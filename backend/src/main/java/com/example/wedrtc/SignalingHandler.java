package com.example.wedrtc;

import com.example.wedrtc.room.Room;
import com.example.wedrtc.room.RoomManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * WebSocket signaling handler managing real-time peer connection handshakes (SDP and ICE).
 * Relays messages peer-to-peer for the full-mesh topology.
 */
@Component
public class SignalingHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(SignalingHandler.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final RoomManager roomManager;
    private final JwtDecoder jwtDecoder;

    // session ID -> WebSocketSession
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    // user ID -> session ID
    private final Map<String, String> userToSession = new ConcurrentHashMap<>();
    // session ID -> user ID
    private final Map<String, String> sessionToUser = new ConcurrentHashMap<>();
    // session ID -> room ID
    private final Map<String, String> sessionToRoom = new ConcurrentHashMap<>();
    // room ID -> Set of user IDs
    private final Map<String, Set<String>> roomUsers = new ConcurrentHashMap<>();

    public SignalingHandler(RoomManager roomManager, JwtDecoder jwtDecoder) {
        this.roomManager = roomManager;
        this.jwtDecoder = jwtDecoder;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.put(session.getId(), session);
        log.debug("WebSocket connection established: session={}", session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        String payload = message.getPayload();
        if (payload.length() > 65_536) {
            session.close(CloseStatus.TOO_BIG_TO_PROCESS);
            return;
        }
        JsonNode json;
        try {
            json = objectMapper.readTree(payload);
        } catch (Exception e) {
            log.warn("Failed to parse incoming WebSocket JSON: {}", payload);
            return;
        }

        String type = json.path("type").asText("");
        switch (type) {
            case "join" -> handleJoin(session, json);
            case "offer" -> handleRelay(session, json, "offer");
            case "answer" -> handleRelay(session, json, "answer");
            case "ice-candidate" -> handleRelay(session, json, "ice-candidate");
            case "media-state" -> handleBroadcastRoom(session, json);
            case "ping" -> sendJson(session, Map.of("type", "pong"));
            case "leave" -> handleLeave(session);
            default -> log.debug("Unknown signaling message type: {}", type);
        }
    }

    private void handleJoin(WebSocketSession session, JsonNode json) throws IOException {
        String roomId = json.path("roomId").asText("");
        String idToken = json.path("token").asText("");

        if (roomId.isBlank() || idToken.isBlank()) {
            sendJson(session, Map.of("type", "error", "code", "UNAUTHENTICATED", "message", "Authentication is required"));
            session.close(CloseStatus.POLICY_VIOLATION);
            return;
        }

        Jwt identity;
        try {
            identity = jwtDecoder.decode(idToken);
        } catch (JwtException exception) {
            sendJson(session, Map.of("type", "error", "code", "UNAUTHENTICATED", "message", "Authentication expired or invalid"));
            session.close(CloseStatus.POLICY_VIOLATION);
            return;
        }

        String userId = identity.getSubject();
        String displayName = identity.getClaimAsString("name");
        if (displayName == null || displayName.isBlank()) {
            displayName = identity.getClaimAsString("email");
        }
        if (displayName == null || displayName.isBlank()) {
            displayName = "Verified participant";
        }

        Optional<Room> optionalRoom = roomManager.getRoom(roomId);
        if (optionalRoom.isEmpty()) {
            sendJson(session, Map.of("type", "error", "code", "ROOM_NOT_FOUND", "message", "Room does not exist"));
            return;
        }

        Room room = optionalRoom.get();
        if (!room.isAuthorized(userId)) {
            sendJson(session, Map.of("type", "error", "code", "NOT_ADMITTED", "message", "Enter a valid invitation code before joining"));
            session.close(CloseStatus.POLICY_VIOLATION);
            return;
        }
        if (room.isFull() && !room.hasParticipant(userId)) {
            sendJson(session, Map.of("type", "error", "code", "ROOM_FULL", "message", "Room capacity limit reached"));
            return;
        }

        // Register mappings
        String existingSessionId = userToSession.putIfAbsent(userId, session.getId());
        if (existingSessionId != null && !existingSessionId.equals(session.getId())) {
            WebSocketSession existingSession = sessions.get(existingSessionId);
            if (existingSession != null && existingSession.isOpen()) {
                sendJson(session, Map.of("type", "error", "code", "DUPLICATE_SESSION", "message", "This account is already active in the call"));
                session.close(CloseStatus.POLICY_VIOLATION);
                return;
            }
            userToSession.replace(userId, existingSessionId, session.getId());
        }
        sessionToUser.put(session.getId(), userId);
        sessionToRoom.put(session.getId(), roomId);

        roomUsers.computeIfAbsent(roomId, k -> ConcurrentHashMap.newKeySet()).add(userId);
        room.addParticipant(userId, displayName);

        // Fetch list of existing participants currently in this room (excluding the joining user)
        List<Map<String, String>> existingParticipants = new ArrayList<>();
        Set<String> usersInRoom = roomUsers.getOrDefault(roomId, Collections.emptySet());
        for (String peerId : usersInRoom) {
            if (!peerId.equals(userId)) {
                Room.Participant p = room.getParticipants().get(peerId);
                String name = p != null ? p.getDisplayName() : "Participant";
                existingParticipants.add(Map.of("userId", peerId, "displayName", name));
            }
        }

        // 1. Send existing users to the newly joined peer so they can initiate offers
        sendJson(session, Map.of(
                "type", "room-joined",
                "roomId", roomId,
                "userId", userId,
                "maxParticipants", room.getMaxParticipants(),
                "users", existingParticipants
        ));

        // 2. Broadcast to all other peers in the room that a new user joined
        broadcastToRoom(roomId, userId, Map.of(
                "type", "user-joined",
                "roomId", roomId,
                "userId", userId,
                "displayName", displayName
        ));

        log.info("User {} ({}) joined room {}. Total participants now: {}", displayName, userId, roomId, usersInRoom.size());
    }

    private void handleRelay(WebSocketSession session, JsonNode json, String type) throws IOException {
        String targetUserId = json.path("target").asText("");
        String fromUserId = sessionToUser.get(session.getId());
        String senderRoomId = sessionToRoom.get(session.getId());

        if (targetUserId.isBlank() || fromUserId == null || senderRoomId == null) {
            log.warn("Invalid relay request: target={}, from={}", targetUserId, fromUserId);
            return;
        }

        String targetSessionId = userToSession.get(targetUserId);
        if (targetSessionId != null && senderRoomId.equals(sessionToRoom.get(targetSessionId))) {
            WebSocketSession targetSession = sessions.get(targetSessionId);
            if (targetSession != null && targetSession.isOpen()) {
                // Forward the exact envelope with 'from' field guaranteed
                Map<String, Object> relayMessage = new HashMap<>();
                relayMessage.put("type", type);
                relayMessage.put("from", fromUserId);
                relayMessage.put("target", targetUserId);

                if (json.has("sdp")) {
                    relayMessage.put("sdp", json.get("sdp"));
                }
                if (json.has("candidate")) {
                    relayMessage.put("candidate", json.get("candidate"));
                }

                sendJson(targetSession, relayMessage);
            }
        }
    }

    private void handleBroadcastRoom(WebSocketSession session, JsonNode json) throws IOException {
        String roomId = sessionToRoom.get(session.getId());
        String userId = sessionToUser.get(session.getId());
        if (roomId != null && userId != null) {
            Map<String, Object> map = objectMapper.convertValue(json, Map.class);
            map.put("from", userId);
            broadcastToRoom(roomId, userId, map);
        }
    }

    private void handleLeave(WebSocketSession session) throws IOException {
        cleanupSession(session);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        cleanupSession(session);
        sessions.remove(session.getId());
        log.debug("WebSocket connection closed: session={}", session.getId());
    }

    private void cleanupSession(WebSocketSession session) throws IOException {
        String sessionId = session.getId();
        String userId = sessionToUser.remove(sessionId);
        String roomId = sessionToRoom.remove(sessionId);

        if (userId != null) {
            userToSession.remove(userId, sessionId);
        }

        if (roomId != null && userId != null) {
            Set<String> users = roomUsers.get(roomId);
            if (users != null) {
                users.remove(userId);
                if (users.isEmpty()) {
                    roomUsers.remove(roomId);
                }
            }
            roomManager.removeParticipant(roomId, userId);

            // Broadcast to remaining room participants
            broadcastToRoom(roomId, userId, Map.of(
                    "type", "user-left",
                    "roomId", roomId,
                    "userId", userId
            ));
            log.info("Cleaned up session for user {} in room {}", userId, roomId);
        }
    }

    private void broadcastToRoom(String roomId, String senderUserId, Map<String, ?> message) throws IOException {
        Set<String> users = roomUsers.get(roomId);
        if (users == null) return;

        byte[] payloadBytes = objectMapper.writeValueAsBytes(message);
        TextMessage textMessage = new TextMessage(payloadBytes);

        for (String peerId : users) {
            if (!peerId.equals(senderUserId)) {
                String peerSessionId = userToSession.get(peerId);
                if (peerSessionId != null) {
                    WebSocketSession peerSession = sessions.get(peerSessionId);
                    if (peerSession != null && peerSession.isOpen()) {
                        synchronized (peerSession) {
                            peerSession.sendMessage(textMessage);
                        }
                    }
                }
            }
        }
    }

    private void sendJson(WebSocketSession session, Object data) throws IOException {
        if (session != null && session.isOpen()) {
            byte[] bytes = objectMapper.writeValueAsBytes(data);
            synchronized (session) {
                session.sendMessage(new TextMessage(bytes));
            }
        }
    }
}

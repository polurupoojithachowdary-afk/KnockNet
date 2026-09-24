package com.example.wedrtc;

import com.example.wedrtc.room.RoomManager;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.web.socket.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class SignalingHandlerTest {
    private final ObjectMapper json = new ObjectMapper();

    private WebSocketSession session(String id, List<JsonNode> messages) throws Exception {
        var session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn(id);
        when(session.isOpen()).thenReturn(true);
        doAnswer(invocation -> {
            messages.add(json.readTree(((TextMessage) invocation.getArgument(0)).getPayload()));
            return null;
        }).when(session).sendMessage(any());
        return session;
    }

    @Test
    void admittedPeersReceiveVoiceAndSignSubtitlesAndDuplicateLoginIsRejected() throws Exception {
        var rooms = new RoomManager();
        var room = rooms.createRoom("alice", 3);
        rooms.validateAndAuthorizeByCode(room.getCode(), "bob");
        var decoder = mock(JwtDecoder.class);
        for (String id : List.of("alice", "bob")) {
            when(decoder.decode(id)).thenReturn(Jwt.withTokenValue(id).header("alg", "RS256")
                    .subject(id).claim("name", id).issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(60)).build());
        }
        var handler = new SignalingHandler(rooms, decoder);
        var aliceMessages = new ArrayList<JsonNode>();
        var bobMessages = new ArrayList<JsonNode>();
        var alice = session("a", aliceMessages);
        var bob = session("b", bobMessages);
        handler.afterConnectionEstablished(alice);
        handler.afterConnectionEstablished(bob);
        handler.handleTextMessage(alice, new TextMessage("{\"type\":\"join\",\"roomId\":\"" + room.getId() + "\",\"token\":\"alice\"}"));
        handler.handleTextMessage(bob, new TextMessage("{\"type\":\"join\",\"roomId\":\"" + room.getId() + "\",\"token\":\"bob\"}"));
        assertEquals("room-joined", aliceMessages.getFirst().path("type").asText());
        assertEquals("alice", bobMessages.getFirst().path("users").path(0).path("userId").asText());
        for (String type : List.of("translation-subtitle", "sign-language-subtitle")) {
            handler.handleTextMessage(alice, new TextMessage("{\"type\":\"" + type + "\",\"translated\":\"Hola\",\"text\":\"Hello\"}"));
            assertEquals(type, bobMessages.getLast().path("type").asText());
            assertEquals("alice", bobMessages.getLast().path("from").asText());
        }
        var duplicateMessages = new ArrayList<JsonNode>();
        var duplicate = session("duplicate", duplicateMessages);
        handler.afterConnectionEstablished(duplicate);
        handler.handleTextMessage(duplicate, new TextMessage("{\"type\":\"join\",\"roomId\":\"" + room.getId() + "\",\"token\":\"alice\"}"));
        assertEquals("DUPLICATE_SESSION", duplicateMessages.getFirst().path("code").asText());
        handler.afterConnectionClosed(alice, CloseStatus.NORMAL);
        assertEquals("user-left", bobMessages.getLast().path("type").asText());
    }
}

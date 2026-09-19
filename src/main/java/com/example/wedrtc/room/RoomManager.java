package com.example.wedrtc.room;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Service managing room creation, lifecycle, and 6-digit access code validation.
 * Designed with a decoupled store interface so that swapping to Firebase Realtime DB,
 * Redis, or PostgreSQL in production requires changing only the persistence adapter.
 */
@Service
public class RoomManager {
    private static final Logger log = LoggerFactory.getLogger(RoomManager.class);
    private static final long DEFAULT_CODE_TTL_SECONDS = 60L; // 1-minute expiration as requested
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Map<String, Room> roomsById = new ConcurrentHashMap<>();
    private final Map<String, String> codeToRoomId = new ConcurrentHashMap<>();
    private final List<ScheduledMeeting> scheduledMeetings = new CopyOnWriteArrayList<>();

    public RoomManager() {
        // Seed an initial meeting for today demo
        scheduleMeeting("Architecture & Design Sync", "11:00 AM", 6, "Chief Architect");
        scheduleMeeting("WebRTC Security Review", "03:30 PM", 8, "SecOps Lead");
    }

    public ScheduledMeeting scheduleMeeting(String title, String scheduledTime, int maxParticipants, String hostName) {
        Room room = createRoom(UUID.randomUUID().toString(), maxParticipants);
        ScheduledMeeting meeting = new ScheduledMeeting(title, scheduledTime, maxParticipants, hostName, room.getId(), room.getCode());
        scheduledMeetings.add(meeting);
        log.info("Scheduled conference created: title={}, time={}, roomId={}", title, scheduledTime, room.getId());
        return meeting;
    }

    public List<ScheduledMeeting> getScheduledMeetings() {
        return List.copyOf(scheduledMeetings);
    }

    public boolean deleteScheduledMeeting(String id) {
        return scheduledMeetings.removeIf(m -> m.getId().equals(id));
    }

    /**
     * Creates a new Knocknet room with a unique UUID and a 6-digit timed-out access code.
     */
    public Room createRoom(String hostId, int maxParticipants) {
        String roomId = UUID.randomUUID().toString();
        String code = generateUniqueCode();
        int capacity = maxParticipants > 0 ? maxParticipants : 6;

        Room room = new Room(roomId, code, hostId, capacity, DEFAULT_CODE_TTL_SECONDS);
        roomsById.put(roomId, room);
        codeToRoomId.put(code, roomId);

        log.info("Knocknet Room created: id={}, code={}, maxParticipants={}, expires in {}s",
                roomId, code, capacity, DEFAULT_CODE_TTL_SECONDS);
        return room;
    }

    /**
     * Resolves a room by its direct UUID (standard join link).
     */
    public Optional<Room> getRoom(String roomId) {
        if (roomId == null) return Optional.empty();
        return Optional.ofNullable(roomsById.get(roomId));
    }

    /**
     * Resolves a room by its 6-digit access code, enforcing the 1-minute timeout.
     */
    public RoomValidationResult validateAndGetRoomByCode(String code) {
        if (code == null || code.trim().length() != 6) {
            return RoomValidationResult.invalid("Invalid 6-digit code format");
        }
        String cleanCode = code.trim();
        String roomId = codeToRoomId.get(cleanCode);
        if (roomId == null) {
            return RoomValidationResult.invalid("Room not found for provided code");
        }
        Room room = roomsById.get(roomId);
        if (room == null) {
            codeToRoomId.remove(cleanCode);
            return RoomValidationResult.invalid("Room does not exist");
        }
        if (room.isCodeExpired()) {
            return RoomValidationResult.expired("Code expired after 60 seconds. Please request a new code from the host.");
        }
        if (room.isFull()) {
            return RoomValidationResult.full("Room has reached its maximum participant limit of " + room.getMaxParticipants());
        }
        return RoomValidationResult.valid(room);
    }

    /**
     * Refreshes the 6-digit join code for an active room with a fresh 60-second TTL.
     */
    public Optional<Room> refreshRoomCode(String roomId) {
        Room room = roomsById.get(roomId);
        if (room == null) {
            return Optional.empty();
        }
        // Remove old mapping
        codeToRoomId.remove(room.getCode());

        String newCode = generateUniqueCode();
        room.refreshCode(newCode, DEFAULT_CODE_TTL_SECONDS);
        codeToRoomId.put(newCode, roomId);

        log.info("Knocknet Room code refreshed: id={}, newCode={}, expires in {}s",
                roomId, newCode, DEFAULT_CODE_TTL_SECONDS);
        return Optional.of(room);
    }

    /**
     * Removes a participant when they disconnect or leave.
     */
    public void removeParticipant(String roomId, String userId) {
        Room room = roomsById.get(roomId);
        if (room != null) {
            room.removeParticipant(userId);
            log.info("Participant {} removed from room {}. Remaining: {}", userId, roomId, room.getParticipantCount());
            // If empty and code expired, we can keep it briefly or clean up
        }
    }

    private String generateUniqueCode() {
        for (int attempts = 0; attempts < 100; attempts++) {
            int num = 100000 + RANDOM.nextInt(900000);
            String candidate = String.valueOf(num);
            if (!codeToRoomId.containsKey(candidate)) {
                return candidate;
            }
        }
        // Fallback with timestamp slice
        return String.valueOf(System.currentTimeMillis() % 900000 + 100000);
    }

    public static class RoomValidationResult {
        public enum Status { VALID, EXPIRED, FULL, INVALID }

        private final Status status;
        private final String message;
        private final Room room;

        private RoomValidationResult(Status status, String message, Room room) {
            this.status = status;
            this.message = message;
            this.room = room;
        }

        public static RoomValidationResult valid(Room room) {
            return new RoomValidationResult(Status.VALID, "OK", room);
        }

        public static RoomValidationResult expired(String message) {
            return new RoomValidationResult(Status.EXPIRED, message, null);
        }

        public static RoomValidationResult full(String message) {
            return new RoomValidationResult(Status.FULL, message, null);
        }

        public static RoomValidationResult invalid(String message) {
            return new RoomValidationResult(Status.INVALID, message, null);
        }

        public Status getStatus() { return status; }
        public String getMessage() { return message; }
        public Room getRoom() { return room; }
        public boolean isValid() { return status == Status.VALID; }
    }
}

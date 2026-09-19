package com.example.wedrtc.room;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;
import java.util.UUID;

/**
 * REST controller for Knocknet room provisioning, 6-digit code lookup, and TTL renewal.
 */
@RestController
@RequestMapping("/api/rooms")
@CrossOrigin(origins = "*")
public class RoomController {

    private final RoomManager roomManager;

    public RoomController(RoomManager roomManager) {
        this.roomManager = roomManager;
    }

    public record CreateRoomRequest(Integer maxParticipants, String hostName) {}
    public record JoinByCodeRequest(String code) {}

    @PostMapping
    public ResponseEntity<?> createRoom(@RequestBody(required = false) CreateRoomRequest request) {
        int maxParticipants = (request != null && request.maxParticipants() != null && request.maxParticipants() > 0)
                ? request.maxParticipants()
                : 6;
        String hostId = UUID.randomUUID().toString();

        Room room = roomManager.createRoom(hostId, maxParticipants);

        return ResponseEntity.ok(Map.of(
                "success", true,
                "roomId", room.getId(),
                "code", room.getCode(),
                "hostId", hostId,
                "maxParticipants", room.getMaxParticipants(),
                "codeExpiresAt", room.getCodeExpiresAt().toString(),
                "codeSecondsRemaining", room.getCodeSecondsRemaining(),
                "joinUrl", "/room.html?id=" + room.getId()
        ));
    }

    @PostMapping("/join")
    public ResponseEntity<?> joinByCode(@RequestBody JoinByCodeRequest request) {
        if (request == null || request.code() == null) {
            return ResponseEntity.badRequest().body(Map.of(
                    "success", false,
                    "error", "MISSING_CODE",
                    "message", "A 6-digit code is required to join"
            ));
        }

        RoomManager.RoomValidationResult result = roomManager.validateAndGetRoomByCode(request.code());
        if (!result.isValid()) {
            HttpStatus status = switch (result.getStatus()) {
                case EXPIRED -> HttpStatus.GONE;
                case FULL -> HttpStatus.FORBIDDEN;
                case INVALID -> HttpStatus.NOT_FOUND;
                default -> HttpStatus.BAD_REQUEST;
            };

            return ResponseEntity.status(status).body(Map.of(
                    "success", false,
                    "error", result.getStatus().name(),
                    "message", result.getMessage()
            ));
        }

        Room room = result.getRoom();
        return ResponseEntity.ok(Map.of(
                "success", true,
                "roomId", room.getId(),
                "code", room.getCode(),
                "maxParticipants", room.getMaxParticipants(),
                "currentParticipants", room.getParticipantCount(),
                "joinUrl", "/room.html?id=" + room.getId()
        ));
    }

    @GetMapping("/{id}")
    public ResponseEntity<?> getRoomInfo(@PathVariable String id) {
        return roomManager.getRoom(id)
                .map(room -> ResponseEntity.ok(Map.of(
                        "success", true,
                        "id", room.getId(),
                        "code", room.getCode(),
                        "isCodeExpired", room.isCodeExpired(),
                        "codeSecondsRemaining", room.getCodeSecondsRemaining(),
                        "participantCount", room.getParticipantCount(),
                        "maxParticipants", room.getMaxParticipants(),
                        "isFull", room.isFull()
                )))
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(
                        "success", false,
                        "error", "NOT_FOUND",
                        "message", "Room does not exist"
                )));
    }

    @PostMapping("/{id}/refresh-code")
    public ResponseEntity<?> refreshCode(@PathVariable String id) {
        return roomManager.refreshRoomCode(id)
                .map(room -> ResponseEntity.ok(Map.of(
                        "success", true,
                        "code", room.getCode(),
                        "codeExpiresAt", room.getCodeExpiresAt().toString(),
                        "codeSecondsRemaining", room.getCodeSecondsRemaining()
                )))
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(
                        "success", false,
                        "error", "NOT_FOUND",
                        "message", "Room does not exist"
                )));
    }

    public record ScheduleMeetingRequest(String title, String scheduledTime, Integer maxParticipants, String hostName) {}

    @GetMapping("/schedule")
    public ResponseEntity<?> getScheduledMeetings() {
        return ResponseEntity.ok(Map.of(
                "success", true,
                "meetings", roomManager.getScheduledMeetings()
        ));
    }

    @PostMapping("/schedule")
    public ResponseEntity<?> scheduleMeeting(@RequestBody ScheduleMeetingRequest request) {
        String title = request != null ? request.title() : "Knocknet Session";
        String time = request != null && request.scheduledTime() != null ? request.scheduledTime() : "Today";
        int capacity = request != null && request.maxParticipants() != null && request.maxParticipants() > 0 ? request.maxParticipants() : 6;
        String host = request != null && request.hostName() != null ? request.hostName() : "Host";

        ScheduledMeeting meeting = roomManager.scheduleMeeting(title, time, capacity, host);
        return ResponseEntity.ok(Map.of(
                "success", true,
                "meeting", meeting,
                "joinUrl", "/room.html?id=" + meeting.getRoomId()
        ));
    }

    @DeleteMapping("/schedule/{id}")
    public ResponseEntity<?> deleteScheduledMeeting(@PathVariable String id) {
        boolean removed = roomManager.deleteScheduledMeeting(id);
        return ResponseEntity.ok(Map.of("success", removed));
    }
}


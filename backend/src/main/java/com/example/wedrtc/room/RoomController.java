package com.example.wedrtc.room;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.security.Principal;
import java.util.Map;

/**
 * REST controller for Knocknet room provisioning, 6-digit code lookup, and TTL renewal.
 */
@RestController
@RequestMapping("/api/rooms")
public class RoomController {

    private final RoomManager roomManager;

    public RoomController(RoomManager roomManager) {
        this.roomManager = roomManager;
    }

    public record CreateRoomRequest(Integer maxParticipants, String hostName) {}
    public record JoinByCodeRequest(String code) {}

    @PostMapping
    public ResponseEntity<?> createRoom(
            @RequestBody(required = false) CreateRoomRequest request,
            Principal principal) {
        int requestedCapacity = request != null && request.maxParticipants() != null
                ? request.maxParticipants() : 6;
        int maxParticipants = Math.max(2, Math.min(requestedCapacity, 8));
        String hostId = principal.getName();

        Room room = roomManager.createRoom(hostId, maxParticipants);

        return ResponseEntity.ok(Map.of(
                "success", true,
                "roomId", room.getId(),
                "code", room.getCode(),
                "hostId", hostId,
                "maxParticipants", room.getMaxParticipants(),
                "codeExpiresAt", room.getCodeExpiresAt().toString(),
                "codeSecondsRemaining", room.getCodeSecondsRemaining(),
                "joinUrl", "/room.html"
        ));
    }

    @PostMapping("/join")
    public ResponseEntity<?> joinByCode(@RequestBody JoinByCodeRequest request, Principal principal) {
        if (request == null || request.code() == null) {
            return ResponseEntity.badRequest().body(Map.of(
                    "success", false,
                    "error", "MISSING_CODE",
                    "message", "A 6-digit code is required to join"
            ));
        }

        RoomManager.RoomValidationResult result = roomManager.validateAndAuthorizeByCode(
                request.code(), principal.getName());
        if (!result.isValid()) {
            HttpStatus status = switch (result.getStatus()) {
                case EXPIRED -> HttpStatus.GONE;
                case FULL -> HttpStatus.FORBIDDEN;
                case RATE_LIMITED -> HttpStatus.TOO_MANY_REQUESTS;
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
                "joinUrl", "/room.html"
        ));
    }

    @GetMapping("/{id}")
    public ResponseEntity<?> getRoomInfo(@PathVariable String id, Principal principal) {
        return roomManager.getRoom(id)
                .map(room -> {
                    if (!room.isAuthorized(principal.getName())) {
                        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of(
                                "success", false,
                                "error", "NOT_ADMITTED",
                                "message", "Enter a valid invitation code before joining this room"
                        ));
                    }
                    return ResponseEntity.ok(Map.of(
                        "success", true,
                        "id", room.getId(),
                        "code", room.getCode(),
                        "isCodeExpired", room.isCodeExpired(),
                        "codeSecondsRemaining", room.getCodeSecondsRemaining(),
                        "participantCount", room.getParticipantCount(),
                        "maxParticipants", room.getMaxParticipants(),
                        "isFull", room.isFull(),
                        "isHost", room.isHost(principal.getName())
                    ));
                })
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(
                        "success", false,
                        "error", "NOT_FOUND",
                        "message", "Room does not exist"
                )));
    }

    @PostMapping("/{id}/refresh-code")
    public ResponseEntity<?> refreshCode(@PathVariable String id, Principal principal) {
        Room existing = roomManager.getRoom(id).orElse(null);
        if (existing == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(
                    "success", false, "error", "NOT_FOUND", "message", "Room does not exist"));
        }
        if (!existing.isHost(principal.getName())) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of(
                    "success", false, "error", "HOST_ONLY", "message", "Only the host can rotate the invitation code"));
        }
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
    public ResponseEntity<?> getScheduledMeetings(Principal principal) {
        return ResponseEntity.ok(Map.of(
                "success", true,
                "meetings", roomManager.getScheduledMeetings(principal.getName())
        ));
    }

    @PostMapping("/schedule")
    public ResponseEntity<?> scheduleMeeting(@RequestBody ScheduleMeetingRequest request, Principal principal) {
        String title = request != null ? request.title() : "Knocknet Session";
        String time = request != null && request.scheduledTime() != null ? request.scheduledTime() : "Today";
        int requestedCapacity = request != null && request.maxParticipants() != null ? request.maxParticipants() : 6;
        int capacity = Math.max(2, Math.min(requestedCapacity, 8));
        String host = request != null && request.hostName() != null ? request.hostName() : "Host";

        ScheduledMeeting meeting = roomManager.scheduleMeeting(title, time, capacity, host, principal.getName());
        return ResponseEntity.ok(Map.of(
                "success", true,
                "meeting", meeting,
                "joinUrl", "/room.html"
        ));
    }

    @DeleteMapping("/schedule/{id}")
    public ResponseEntity<?> deleteScheduledMeeting(@PathVariable String id, Principal principal) {
        boolean removed = roomManager.deleteScheduledMeeting(id, principal.getName());
        return ResponseEntity.ok(Map.of("success", removed));
    }
}

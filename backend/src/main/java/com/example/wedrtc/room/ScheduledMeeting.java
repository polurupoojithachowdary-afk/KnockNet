package com.example.wedrtc.room;

import java.time.Instant;
import java.util.UUID;

/**
 * Model representing a planned/scheduled Knocknet conference.
 */
public class ScheduledMeeting {
    private final String id;
    private final String title;
    private final String scheduledTime; // ISO-8601 or HH:mm string
    private final int maxParticipants;
    private final String hostName;
    private final String hostId;
    private final Instant createdAt;
    private final String roomId;
    private final String code;

    public ScheduledMeeting(String title, String scheduledTime, int maxParticipants, String hostName, String hostId, String roomId, String code) {
        this.id = UUID.randomUUID().toString();
        this.title = (title != null && !title.isBlank()) ? title : "Knocknet Session";
        this.scheduledTime = scheduledTime;
        this.maxParticipants = maxParticipants > 0 ? maxParticipants : 6;
        this.hostName = (hostName != null && !hostName.isBlank()) ? hostName : "Host";
        this.hostId = hostId;
        this.createdAt = Instant.now();
        this.roomId = roomId;
        this.code = code;
    }

    public String getId() {
        return id;
    }

    public String getTitle() {
        return title;
    }

    public String getScheduledTime() {
        return scheduledTime;
    }

    public int getMaxParticipants() {
        return maxParticipants;
    }

    public String getHostName() {
        return hostName;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public String getRoomId() {
        return roomId;
    }

    public String getCode() {
        return code;
    }

    boolean belongsTo(String userId) {
        return hostId.equals(userId);
    }
}

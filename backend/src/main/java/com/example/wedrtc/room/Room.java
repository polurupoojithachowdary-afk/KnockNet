package com.example.wedrtc.room;

import java.time.Instant;
import java.util.Collections;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** Encapsulates the authorization and live presence state of a Knocknet room. */
public class Room {
    private final String id;
    private volatile String code;
    private final String hostId;
    private final int maxParticipants;
    private final Instant createdAt;
    private volatile Instant codeExpiresAt;
    private final Map<String, Participant> participants = new ConcurrentHashMap<>();
    private final Set<String> authorizedUserIds = ConcurrentHashMap.newKeySet();

    public static class Participant {
        private final String userId;
        private final String displayName;
        private final Instant joinedAt;

        public Participant(String userId, String displayName) {
            this.userId = userId;
            this.displayName = displayName != null && !displayName.isBlank() ? displayName : "Guest";
            this.joinedAt = Instant.now();
        }

        public String getUserId() {
            return userId;
        }

        public String getDisplayName() {
            return displayName;
        }

        public Instant getJoinedAt() {
            return joinedAt;
        }
    }

    public Room(String id, String code, String hostId, int maxParticipants, long codeTtlSeconds) {
        this.id = id;
        this.code = code;
        this.hostId = hostId;
        this.maxParticipants = maxParticipants > 0 ? maxParticipants : 6;
        this.createdAt = Instant.now();
        this.codeExpiresAt = this.createdAt.plusSeconds(codeTtlSeconds);
        this.authorizedUserIds.add(hostId);
    }

    public String getId() {
        return id;
    }

    public String getCode() {
        return code;
    }

    public String getHostId() {
        return hostId;
    }

    public int getMaxParticipants() {
        return maxParticipants;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getCodeExpiresAt() {
        return codeExpiresAt;
    }

    public boolean isCodeExpired() {
        return Instant.now().isAfter(codeExpiresAt);
    }

    public long getCodeSecondsRemaining() {
        long diff = codeExpiresAt.getEpochSecond() - Instant.now().getEpochSecond();
        return Math.max(0, diff);
    }

    public synchronized void refreshCode(String newCode, long ttlSeconds) {
        this.code = newCode;
        this.codeExpiresAt = Instant.now().plusSeconds(ttlSeconds);
    }

    public boolean isFull() {
        return participants.size() >= maxParticipants;
    }

    public boolean addParticipant(String userId, String displayName) {
        if (isFull() && !participants.containsKey(userId)) {
            return false;
        }
        participants.put(userId, new Participant(userId, displayName));
        return true;
    }

    public Participant removeParticipant(String userId) {
        return participants.remove(userId);
    }

    public boolean hasParticipant(String userId) {
        return participants.containsKey(userId);
    }

    public void authorizeParticipant(String userId) {
        if (userId != null && !userId.isBlank()) {
            authorizedUserIds.add(userId);
        }
    }

    public boolean isAuthorized(String userId) {
        return userId != null && authorizedUserIds.contains(userId);
    }

    public boolean isHost(String userId) {
        return hostId.equals(userId);
    }

    public int getParticipantCount() {
        return participants.size();
    }

    public Map<String, Participant> getParticipants() {
        return Collections.unmodifiableMap(participants);
    }
}

package com.example.wedrtc;

import com.example.wedrtc.room.Room;
import com.example.wedrtc.room.RoomManager;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class RoomManagerTest {

    private RoomManager roomManager;

    @BeforeEach
    void setUp() {
        roomManager = new RoomManager();
    }

    @Test
    void testCreateRoomGeneratesSixDigitCodeAndSetsTtl() {
        Room room = roomManager.createRoom("host-1", 4);

        assertNotNull(room);
        assertNotNull(room.getId());
        assertEquals(6, room.getCode().length());
        assertTrue(room.getCode().matches("\\d{6}"));
        assertEquals(4, room.getMaxParticipants());
        assertFalse(room.isCodeExpired());
        assertTrue(room.getCodeSecondsRemaining() > 0 && room.getCodeSecondsRemaining() <= 60);
    }

    @Test
    void testValidateAndGetRoomByCodeSuccess() {
        Room room = roomManager.createRoom("host-1", 6);
        RoomManager.RoomValidationResult result = roomManager.validateAndGetRoomByCode(room.getCode());

        assertTrue(result.isValid());
        assertEquals(RoomManager.RoomValidationResult.Status.VALID, result.getStatus());
        assertEquals(room.getId(), result.getRoom().getId());
    }

    @Test
    void testInvalidCodeReturnsInvalidStatus() {
        RoomManager.RoomValidationResult result = roomManager.validateAndGetRoomByCode("000000");
        assertFalse(result.isValid());
        assertEquals(RoomManager.RoomValidationResult.Status.INVALID, result.getStatus());
    }

    @Test
    void testRoomCapacityLimitEnforced() {
        Room room = roomManager.createRoom("host-1", 2);
        assertTrue(room.addParticipant("user-1", "Alice"));
        assertTrue(room.addParticipant("user-2", "Bob"));
        assertTrue(room.isFull());

        // 3rd user should be rejected
        assertFalse(room.addParticipant("user-3", "Charlie"));

        RoomManager.RoomValidationResult result = roomManager.validateAndGetRoomByCode(room.getCode());
        assertFalse(result.isValid());
        assertEquals(RoomManager.RoomValidationResult.Status.FULL, result.getStatus());
    }

    @Test
    void testRefreshCodeGeneratesNewValidCode() {
        Room room = roomManager.createRoom("host-1", 6);
        String oldCode = room.getCode();

        var refreshed = roomManager.refreshRoomCode(room.getId());
        assertTrue(refreshed.isPresent());
        String newCode = refreshed.get().getCode();

        assertEquals(6, newCode.length());
        // Old code is now invalid
        var oldResult = roomManager.validateAndGetRoomByCode(oldCode);
        assertFalse(oldResult.isValid());

        // New code works
        var newResult = roomManager.validateAndGetRoomByCode(newCode);
        assertTrue(newResult.isValid());
    }
}

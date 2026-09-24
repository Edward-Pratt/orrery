package io.github.edwardpratt.gtnhdiscord;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.io.IOException;

import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;

class BackupLogWatcherTest {

    @Test
    void doneLinesBecomeSuccessWithServerUtilitiesDetail() {
        JsonObject msg = BackupLogWatcher.toMessage("Backup done in 12.3 seconds (1.2GB)!", null);
        assertEquals("backup", HubClient.str(msg, "type"));
        assertEquals(
            true,
            msg.get("ok")
                .getAsBoolean());
        assertEquals("12.3 seconds (1.2GB)", HubClient.str(msg, "detail"));
    }

    @Test
    void errorLinesBecomeFailureWithTheExceptionMessage() {
        JsonObject msg = BackupLogWatcher
            .toMessage("Error while backing up", new IOException("No space left on device"));
        assertEquals(
            false,
            msg.get("ok")
                .getAsBoolean());
        assertEquals("No space left on device", HubClient.str(msg, "detail"));
        assertEquals(
            "unknown error",
            HubClient.str(BackupLogWatcher.toMessage("Error while backing up", null), "detail"));
    }

    @Test
    void otherLinesAreIgnored() {
        assertNull(BackupLogWatcher.toMessage("Backups folder - /home/opc/GTNH/backups", null));
        assertNull(BackupLogWatcher.toMessage(null, null));
    }
}

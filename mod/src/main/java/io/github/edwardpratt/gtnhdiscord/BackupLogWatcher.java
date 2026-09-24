package io.github.edwardpratt.gtnhdiscord;

import java.util.function.Consumer;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.Logger;
import org.apache.logging.log4j.core.appender.AbstractAppender;

import com.google.gson.JsonObject;

/**
 * Turns ServerUtilities' own backup log lines into {@code backup} messages: it logs "Backup done in …" and
 * "Error while backing up" on its "Server Utilities" logger, but reports them to players only as chat.
 */
final class BackupLogWatcher extends AbstractAppender {

    static final String LOGGER = "Server Utilities";
    private static final String DONE = "Backup done in ";
    private static final String FAILED = "Error while backing up";

    private final Consumer<JsonObject> send;

    BackupLogWatcher(Consumer<JsonObject> send) {
        super("GTNHDiscord-backups", null, null);
        this.send = send;
    }

    /** Attaches to ServerUtilities' logger. Harmless without ServerUtilities: that logger then never logs these. */
    static void attach(Consumer<JsonObject> send) {
        BackupLogWatcher appender = new BackupLogWatcher(send);
        appender.start();
        ((Logger) LogManager.getLogger(LOGGER)).addAppender(appender);
    }

    @Override
    public void append(LogEvent event) {
        handle(
            event.getMessage()
                .getFormattedMessage(),
            event.getThrown());
    }

    /** Never throws: an error here would surface in ServerUtilities' backup thread. */
    void handle(String text, Throwable thrown) {
        try {
            JsonObject msg = toMessage(text, thrown);
            if (msg != null) send.accept(msg);
        } catch (RuntimeException | LinkageError ignored) {
            // never break logging
        }
    }

    /** The backup message for a log line, or null if it isn't one. */
    static JsonObject toMessage(String text, Throwable thrown) {
        if (text == null) return null;
        if (text.startsWith(DONE)) {
            String detail = text.substring(DONE.length())
                .trim();
            if (detail.endsWith("!")) detail = detail.substring(0, detail.length() - 1);
            return backup(true, detail);
        }
        if (text.startsWith(FAILED)) {
            String detail = thrown != null && thrown.getMessage() != null ? thrown.getMessage() : "unknown error";
            return backup(false, detail);
        }
        return null;
    }

    private static JsonObject backup(boolean ok, String detail) {
        JsonObject o = GameEvents.msg("backup", "detail", detail);
        o.addProperty("ok", ok);
        return o;
    }
}

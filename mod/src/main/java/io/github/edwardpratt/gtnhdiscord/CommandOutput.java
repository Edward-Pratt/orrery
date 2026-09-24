package io.github.edwardpratt.gtnhdiscord;

import java.util.ArrayList;
import java.util.List;

/**
 * The replies to one {@code /cmd}. Some mods (spark) answer from a worker thread after the command has returned,
 * so lines can arrive from any thread; the result is sent once replies go quiet or a hard limit passes. No
 * Minecraft classes, so it is unit-testable.
 */
final class CommandOutput {

    /** Send once this long passes without a new line (counted from the start if there are none yet). */
    static final long QUIET_MS = 1500;
    /** Always send by now: below the hub's 10 s command timeout. */
    static final long MAX_MS = 8000;

    final String id;
    private final long startedAt;
    private final List<String> lines = new ArrayList<>();
    private long lastLineAt;

    CommandOutput(String id, long now) {
        this.id = id;
        this.startedAt = now;
        this.lastLineAt = now;
    }

    synchronized void add(String line, long now) {
        lines.add(line);
        lastLineAt = now;
    }

    synchronized boolean ready(long now) {
        return now - lastLineAt >= QUIET_MS || now - startedAt >= MAX_MS;
    }

    synchronized List<String> lines() {
        return new ArrayList<>(lines);
    }
}

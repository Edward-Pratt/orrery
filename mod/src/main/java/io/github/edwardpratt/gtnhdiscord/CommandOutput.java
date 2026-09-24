package io.github.edwardpratt.gtnhdiscord;

import java.util.ArrayList;
import java.util.List;

/**
 * The replies to one {@code /cmd}. Some mods (spark) answer from a worker thread after the command has returned,
 * so lines can arrive from any thread. The first result is sent once replies go quiet or a hard limit passes;
 * lines after that are sent as "late" batches for a while longer. No Minecraft classes, so it is unit-testable.
 */
final class CommandOutput {

    /** Send once this long passes without a new line (counted from the start if there are none yet). */
    static final long QUIET_MS = 1500;
    /** Always send the first result by now: below the hub's 10 s command timeout. */
    static final long MAX_MS = 8000;
    /** Keep collecting late lines (e.g. spark's profiler link) this long after the start. */
    static final long LATE_MS = 5 * 60_000;

    final String id;
    private final long startedAt;
    private final List<String> lines = new ArrayList<>();
    private long lastLineAt;
    private int sent; // lines already sent

    CommandOutput(String id, long now) {
        this.id = id;
        this.startedAt = now;
        this.lastLineAt = now;
    }

    synchronized void add(String line, long now) {
        lines.add(line);
        lastLineAt = now;
    }

    /** First phase: time to send the result. */
    synchronized boolean ready(long now) {
        return now - lastLineAt >= QUIET_MS || now - startedAt >= MAX_MS;
    }

    /** Late phase: unsent lines have gone quiet. */
    synchronized boolean lateReady(long now) {
        return sent < lines.size() && now - lastLineAt >= QUIET_MS;
    }

    synchronized boolean expired(long now) {
        return now - startedAt >= LATE_MS;
    }

    synchronized boolean hasUnsent() {
        return sent < lines.size();
    }

    /** The lines not sent yet, marking them sent. */
    synchronized List<String> takeUnsent() {
        List<String> out = new ArrayList<>(lines.subList(sent, lines.size()));
        sent = lines.size();
        return out;
    }

    /** Every line so far. */
    synchronized List<String> lines() {
        return new ArrayList<>(lines);
    }
}

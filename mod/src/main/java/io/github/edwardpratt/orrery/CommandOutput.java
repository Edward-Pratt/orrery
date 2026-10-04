package io.github.edwardpratt.orrery;

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
    /** At most this many late batches (Discord follow-ups) per command: a chatty command can't spam the channel. */
    static final int MAX_LATE_BATCHES = 10;
    /** Unsent lines kept at most; more are dropped. */
    static final int MAX_LINES = 2000;

    final String id;
    private final long startedAt;
    private final List<String> lines = new ArrayList<>(); // not sent yet
    private long lastLineAt;
    private int batches; // results sent: the first plus late ones
    private boolean closed;

    CommandOutput(String id, long now) {
        this.id = id;
        this.startedAt = now;
        this.lastLineAt = now;
    }

    /** Ignored once closed (the sender may live on inside another mod) or when the buffer is full. */
    synchronized void add(String line, long now) {
        if (closed || lines.size() >= MAX_LINES) return;
        lines.add(line);
        lastLineAt = now;
    }

    synchronized void close() {
        closed = true;
    }

    /** True once the first result and every allowed late batch have been sent. */
    synchronized boolean lateBatchesUsed() {
        return batches > MAX_LATE_BATCHES;
    }

    /** First phase: time to send the result. */
    synchronized boolean ready(long now) {
        return now - lastLineAt >= QUIET_MS || now - startedAt >= MAX_MS;
    }

    /** Late phase: unsent lines have gone quiet. */
    synchronized boolean lateReady(long now) {
        return !lines.isEmpty() && now - lastLineAt >= QUIET_MS;
    }

    synchronized boolean expired(long now) {
        return now - startedAt >= LATE_MS;
    }

    synchronized boolean hasUnsent() {
        return !lines.isEmpty();
    }

    /** The lines not sent yet; they are dropped from the buffer and count as one sent batch. */
    synchronized List<String> takeUnsent() {
        List<String> out = new ArrayList<>(lines);
        lines.clear();
        batches++;
        return out;
    }

    /** The lines not sent yet. */
    synchronized List<String> lines() {
        return new ArrayList<>(lines);
    }
}

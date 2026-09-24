package io.github.edwardpratt.gtnhdiscord;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;

import org.junit.jupiter.api.Test;

class CommandOutputTest {

    @Test
    void readyAfterAQuietWindowEvenWithNoOutput() {
        CommandOutput out = new CommandOutput("1", 0);
        assertFalse(out.ready(CommandOutput.QUIET_MS - 1));
        assertTrue(out.ready(CommandOutput.QUIET_MS));
        assertEquals(
            0,
            out.lines()
                .size());
    }

    @Test
    void eachNewLineRestartsTheQuietWindow() {
        CommandOutput out = new CommandOutput("1", 0);
        out.add("a", 1000);
        assertFalse(out.ready(2000));
        out.add("b", 2000);
        assertFalse(out.ready(3000));
        assertTrue(out.ready(2000 + CommandOutput.QUIET_MS));
        assertEquals(Arrays.asList("a", "b"), out.lines());
    }

    @Test
    void alwaysReadyByTheMaxWindow() {
        CommandOutput out = new CommandOutput("1", 0);
        for (long t = 0; t < CommandOutput.MAX_MS; t += 500) out.add("line", t);
        assertFalse(out.ready(CommandOutput.MAX_MS - 1));
        assertTrue(out.ready(CommandOutput.MAX_MS));
    }

    @Test
    void acceptsLinesFromAnotherThread() throws InterruptedException {
        // Like spark: the reply comes from a worker thread after the command call returned.
        final CommandOutput out = new CommandOutput("1", System.currentTimeMillis());
        Thread worker = new Thread(
            () -> { for (int i = 0; i < 1000; i++) out.add("line " + i, System.currentTimeMillis()); });
        worker.start();
        worker.join();
        assertEquals(
            1000,
            out.lines()
                .size());
        assertEquals(
            "line 999",
            out.lines()
                .get(999));
    }

    @Test
    void lateLinesComeOutInQuietBatchesUntilExpiry() {
        CommandOutput out = new CommandOutput("1", 0);
        out.add("Profiler started", 100);
        assertEquals(Arrays.asList("Profiler started"), out.takeUnsent()); // the first result
        assertFalse(out.lateReady(5000)); // nothing new
        out.add("Uploading…", 30_000);
        out.add("https://spark.lucko.me/abc", 30_500);
        assertFalse(out.lateReady(31_000)); // not quiet yet
        assertTrue(out.lateReady(30_500 + CommandOutput.QUIET_MS));
        assertEquals(Arrays.asList("Uploading…", "https://spark.lucko.me/abc"), out.takeUnsent());
        assertFalse(out.hasUnsent());
        assertFalse(out.expired(CommandOutput.LATE_MS - 1));
        assertTrue(out.expired(CommandOutput.LATE_MS));
    }

    @Test
    void lateOutputIsBoundedInBatchesAndLinesAndStopsAtClose() {
        CommandOutput out = new CommandOutput("1", 0);
        out.takeUnsent(); // the first result
        for (int i = 0; i < CommandOutput.MAX_LATE_BATCHES; i++) {
            assertFalse(out.lateBatchesUsed());
            out.add("tick " + i, 0);
            out.takeUnsent();
        }
        assertTrue(out.lateBatchesUsed()); // no more follow-ups for this command
        for (int i = 0; i < CommandOutput.MAX_LINES + 10; i++) out.add("spam", 0);
        assertEquals(
            CommandOutput.MAX_LINES,
            out.lines()
                .size());
        out.close();
        out.add("after close", 0);
        assertEquals(
            CommandOutput.MAX_LINES,
            out.lines()
                .size());
    }
}

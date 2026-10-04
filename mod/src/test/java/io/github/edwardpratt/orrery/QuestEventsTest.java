package io.github.edwardpratt.orrery;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.UUID;

import org.junit.jupiter.api.Test;

import betterquesting.api.events.QuestEvent;

class QuestEventsTest {

    @Test
    void aBetterQuestingVersionMismatchDisablesTheListenerInsteadOfCrashingTheServer() {
        // A different BetterQuesting build surfaces as a LinkageError (e.g. NoSuchFieldError), which is not a
        // RuntimeException: it must not escape into the server tick loop.
        int[] calls = { 0 };
        QuestEvents listener = new QuestEvents(() -> {
            calls[0]++;
            throw new NoSuchFieldError("SILENT");
        });
        QuestEvent e = new QuestEvent(QuestEvent.Type.COMPLETED, UUID.randomUUID(), UUID.randomUUID());
        assertDoesNotThrow(() -> listener.onQuest(e));
        assertDoesNotThrow(() -> listener.onQuest(e));
        assertEquals(1, calls[0]); // disabled after the first error
    }
}

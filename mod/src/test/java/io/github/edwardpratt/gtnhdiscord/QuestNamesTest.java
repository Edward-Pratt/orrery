package io.github.edwardpratt.gtnhdiscord;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;

class QuestNamesTest {

    static final Map<String, String> LANG = new HashMap<>();
    static {
        LANG.put("betterquesting.quest.AAA.name", "Stone Age");
        LANG.put("gtnh.quest.bronze", "Bronze Age");
    }

    static String resolve(String key, String property) {
        return QuestNames.resolve(key, property, LANG::containsKey, LANG::get);
    }

    @Test
    void prefersTheQuestLangKey() {
        assertEquals("Stone Age", resolve("betterquesting.quest.AAA.name", "Something else"));
    }

    @Test
    void thenTheTranslatedOrLiteralNameProperty() {
        assertEquals("Bronze Age", resolve("betterquesting.quest.BBB.name", "gtnh.quest.bronze"));
        assertEquals("Get some wood", resolve("betterquesting.quest.BBB.name", "Get some wood"));
    }

    @Test
    void fallsBackWhenOnlyUntranslatedKeysAreLeft() {
        assertEquals(QuestNames.FALLBACK, resolve("betterquesting.quest.BBB.name", "untitled.name"));
        assertEquals(QuestNames.FALLBACK, resolve("betterquesting.quest.BBB.name", ""));
        assertEquals(QuestNames.FALLBACK, resolve("betterquesting.quest.BBB.name", null));
    }

    @Test
    void recognisesKeys() {
        assertTrue(QuestNames.looksLikeKey("untitled.name"));
        assertFalse(QuestNames.looksLikeKey("Stone Age. Part 2"));
        assertFalse(QuestNames.looksLikeKey("Wood"));
    }
}

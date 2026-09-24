package io.github.edwardpratt.gtnhdiscord;

import java.util.function.Predicate;
import java.util.function.UnaryOperator;

/**
 * Server-side quest names. BetterQuesting's own QuestTranslation uses the client-only I18n, so on a dedicated
 * server we go through the server's translation table instead. Pure (lookups are passed in) so it's unit-testable.
 */
final class QuestNames {

    static final String FALLBACK = "a quest";

    private QuestNames() {}

    /** The quest's lang key, then its name property (translated, or as-is if it isn't a key), then "a quest". */
    static String resolve(String langKey, String nameProperty, Predicate<String> canTranslate,
        UnaryOperator<String> translate) {
        if (canTranslate.test(langKey)) return translate.apply(langKey);
        if (nameProperty != null && !nameProperty.trim()
            .isEmpty()) {
            if (canTranslate.test(nameProperty)) return translate.apply(nameProperty);
            if (!looksLikeKey(nameProperty)) return nameProperty;
        }
        return FALLBACK;
    }

    /** e.g. "untitled.name" or "betterquesting.quest.abc.name": an untranslated key, not a real name. */
    static boolean looksLikeKey(String s) {
        return s.indexOf('.') > 0 && s.matches("[A-Za-z0-9_.\\-]+");
    }
}

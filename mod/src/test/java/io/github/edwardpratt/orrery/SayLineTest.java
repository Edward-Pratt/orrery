package io.github.edwardpratt.orrery;

import static org.junit.jupiter.api.Assertions.assertEquals;

import net.minecraft.util.EnumChatFormatting;
import net.minecraft.util.IChatComponent;

import org.junit.jupiter.api.Test;

class SayLineTest {

    static void assertLine(IChatComponent line, EnumChatFormatting color, String text) {
        assertEquals(text, line.getUnformattedText());
        IChatComponent prefix = (IChatComponent) line.getSiblings()
            .get(0);
        assertEquals(
            color,
            prefix.getChatStyle()
                .getColor());
    }

    @Test
    void dashboardLinesAreGold() {
        assertLine(SayLine.of("alex", "hi", "dashboard"), EnumChatFormatting.GOLD, "[Dashboard] <alex> hi");
    }

    @Test
    void discordAndMissingSourcesAreBlue() {
        for (String source : new String[] { "discord", "", null }) {
            assertLine(SayLine.of("alex", "hi", source), EnumChatFormatting.BLUE, "[Discord] <alex> hi");
        }
    }
}

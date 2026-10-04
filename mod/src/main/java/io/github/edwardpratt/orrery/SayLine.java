package io.github.edwardpratt.orrery;

import net.minecraft.util.ChatComponentText;
import net.minecraft.util.ChatStyle;
import net.minecraft.util.EnumChatFormatting;
import net.minecraft.util.IChatComponent;

/** The in-game line for a hub `say`: where it was typed, then `<author> message`. */
final class SayLine {

    private SayLine() {}

    /** A gold [Dashboard] for "dashboard"; a blue [Discord] for anything else, a missing source (older hub) too. */
    static IChatComponent of(String author, String message, String source) {
        boolean dashboard = "dashboard".equals(source);
        IChatComponent line = new ChatComponentText("");
        line.appendSibling(
            new ChatComponentText(dashboard ? "[Dashboard] " : "[Discord] ")
                .setChatStyle(new ChatStyle().setColor(dashboard ? EnumChatFormatting.GOLD : EnumChatFormatting.BLUE)));
        line.appendSibling(new ChatComponentText("<" + author + "> " + message));
        return line;
    }
}

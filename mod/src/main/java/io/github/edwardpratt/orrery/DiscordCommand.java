package io.github.edwardpratt.orrery;

import java.util.function.Supplier;

import net.minecraft.command.CommandBase;
import net.minecraft.command.ICommandSender;
import net.minecraft.command.WrongUsageException;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.ChatComponentText;
import net.minecraft.util.ChatStyle;
import net.minecraft.util.EnumChatFormatting;

/** {@code /discord link <code>} and {@code /discord unlink}, for players. The hub answers with linkResult. */
final class DiscordCommand extends CommandBase {

    private final Supplier<HubClient> client;

    DiscordCommand(Supplier<HubClient> client) {
        this.client = client;
    }

    @Override
    public String getCommandName() {
        return "discord";
    }

    @Override
    public String getCommandUsage(ICommandSender sender) {
        return "/discord link <code> | /discord unlink";
    }

    @Override
    public int getRequiredPermissionLevel() {
        return 0;
    }

    @Override
    public boolean canCommandSenderUseCommand(ICommandSender sender) {
        return sender instanceof EntityPlayerMP;
    }

    @Override
    public void processCommand(ICommandSender sender, String[] args) {
        EntityPlayerMP player = getCommandSenderAsPlayer(sender);
        boolean link = args.length == 2 && args[0].equalsIgnoreCase("link");
        boolean unlink = args.length == 1 && args[0].equalsIgnoreCase("unlink");
        if (!link && !unlink) throw new WrongUsageException(getCommandUsage(sender));
        HubClient c = client.get();
        if (c == null || !c.isConnected()) {
            tell(player, false, "Discord bridge offline, try again later.");
            return;
        }
        String name = player.getCommandSenderName();
        if (link) {
            c.send(
                GameEvents.msg(
                    "link",
                    "player",
                    name,
                    "uuid",
                    player.getGameProfile()
                        .getId()
                        .toString(),
                    "code",
                    args[1]));
            tell(player, true, "Linking…");
        } else {
            c.send(GameEvents.msg("unlink", "player", name));
        }
    }

    static void tell(EntityPlayerMP player, boolean ok, String message) {
        ChatComponentText text = new ChatComponentText("[Discord] " + message);
        text.setChatStyle(new ChatStyle().setColor(ok ? EnumChatFormatting.GREEN : EnumChatFormatting.RED));
        player.addChatMessage(text);
    }
}

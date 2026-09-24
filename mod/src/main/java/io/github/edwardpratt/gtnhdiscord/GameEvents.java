package io.github.edwardpratt.gtnhdiscord;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.network.rcon.RConConsoleSource;
import net.minecraft.server.MinecraftServer;
import net.minecraft.stats.StatisticsFile;
import net.minecraft.util.ChatComponentText;
import net.minecraft.util.ChatStyle;
import net.minecraft.util.EnumChatFormatting;
import net.minecraft.util.IChatComponent;
import net.minecraft.util.MathHelper;
import net.minecraftforge.event.ServerChatEvent;
import net.minecraftforge.event.entity.living.LivingDeathEvent;
import net.minecraftforge.event.entity.player.AchievementEvent;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.common.eventhandler.EventPriority;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.PlayerEvent;
import cpw.mods.fml.common.gameevent.TickEvent;

/**
 * Game-side half of the bridge. Registered on both buses by {@link GtnhDiscord}: chat/death/achievement are Forge-bus
 * events, login/logout/tick are FML-bus events. Everything here runs on the server thread.
 */
public class GameEvents {

    private static final long HEARTBEAT_MS = 5000;

    private final HubClient client;
    private long lastHeartbeat;
    /** Commands still collecting replies. Server thread only (the replies themselves may come from any thread). */
    private final List<CommandOutput> pending = new ArrayList<>();

    GameEvents(HubClient client) {
        this.client = client;
    }

    static JsonObject msg(String type, String... keyValues) {
        JsonObject o = new JsonObject();
        o.addProperty("type", type);
        for (int i = 0; i + 1 < keyValues.length; i += 2) o.addProperty(keyValues[i], keyValues[i + 1]);
        return o;
    }

    // LOWEST priority + canceled events not received: muted chat and prevented deaths are not relayed.
    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onChat(ServerChatEvent e) {
        client.send(msg("chat", "player", e.username, "message", e.message));
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onDeath(LivingDeathEvent e) {
        if (!(e.entityLiving instanceof EntityPlayerMP)) return;
        EntityPlayerMP player = (EntityPlayerMP) e.entityLiving;
        // Same call vanilla EntityPlayerMP.onDeath uses for the death broadcast.
        String text = player.func_110142_aN()
            .func_151521_b()
            .getUnformattedText();
        client.send(msg("death", "player", player.getCommandSenderName(), "message", text));
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onAchievement(AchievementEvent e) {
        if (!(e.entityPlayer instanceof EntityPlayerMP)) return;
        // Fires on every trigger; only report a real first unlock.
        StatisticsFile stats = ((EntityPlayerMP) e.entityPlayer).func_147099_x();
        if (stats.hasAchievementUnlocked(e.achievement) || !stats.canUnlockAchievement(e.achievement)) return;
        String name = e.achievement.func_150951_e()
            .getUnformattedText();
        client.send(msg("achievement", "player", e.entityPlayer.getCommandSenderName(), "achievement", name));
    }

    @SubscribeEvent
    public void onLogin(PlayerEvent.PlayerLoggedInEvent e) {
        client.send(msg("join", "player", e.player.getCommandSenderName()));
    }

    @SubscribeEvent
    public void onLogout(PlayerEvent.PlayerLoggedOutEvent e) {
        client.send(msg("leave", "player", e.player.getCommandSenderName()));
    }

    @SubscribeEvent
    public void onTick(TickEvent.ServerTickEvent e) {
        if (e.phase != TickEvent.Phase.END) return;
        try {
            MinecraftServer server = MinecraftServer.getServer();
            JsonObject in;
            while ((in = client.poll()) != null) handle(server, in);
            long now = System.currentTimeMillis();
            for (Iterator<CommandOutput> it = pending.iterator(); it.hasNext();) {
                CommandOutput out = it.next();
                if (out.ready(now)) {
                    sendResult(out);
                    it.remove();
                }
            }
            // Sent from the tick so that a frozen tick loop stops heartbeats (that is how the hub spots a hang).
            if (now - lastHeartbeat >= HEARTBEAT_MS) {
                lastHeartbeat = now;
                client.send(heartbeat(server));
            }
        } catch (RuntimeException ex) {
            GtnhDiscord.LOG.error("Discord bridge tick failed", ex);
        }
    }

    private void handle(MinecraftServer server, JsonObject in) {
        String type = HubClient.str(in, "type");
        if (type.equals("say")) {
            IChatComponent line = new ChatComponentText("");
            line.appendSibling(
                new ChatComponentText("[Discord] ").setChatStyle(new ChatStyle().setColor(EnumChatFormatting.BLUE)));
            line.appendSibling(
                new ChatComponentText("<" + HubClient.str(in, "author") + "> " + HubClient.str(in, "message")));
            server.getConfigurationManager()
                .sendChatMsg(line);
        } else if (type.equals("cmd")) {
            final CommandOutput output = new CommandOutput(HubClient.str(in, "id"), System.currentTimeMillis());
            // Vanilla's RCON sender: op-level, real world and coordinates. We only capture its replies per line,
            // including ones that arrive later from another thread (the result waits for them; see CommandOutput).
            RConConsoleSource sender = new RConConsoleSource() {

                @Override
                public String getCommandSenderName() {
                    return "Discord";
                }

                @Override
                public void addChatMessage(IChatComponent message) {
                    output.add(message.getUnformattedText(), System.currentTimeMillis());
                }
            };
            server.getCommandManager()
                .executeCommand(sender, HubClient.str(in, "command"));
            pending.add(output);
        }
    }

    /** Sends every pending command result now, ready or not: on shutdown ticks stop, so they'd never go. */
    void flushPending() {
        for (CommandOutput out : pending) sendResult(out);
        pending.clear();
    }

    private void sendResult(CommandOutput out) {
        JsonObject result = msg("cmdResult", "id", out.id);
        JsonArray lines = new JsonArray();
        for (String s : out.lines()) lines.add(new JsonPrimitive(s));
        result.add("output", lines);
        client.send(result);
    }

    private static JsonObject heartbeat(MinecraftServer server) {
        double msPerTick = MathHelper.average(server.tickTimeArray) * 1.0E-6D; // tickTimeArray is nanoseconds
        JsonObject o = msg("heartbeat");
        o.addProperty("tps", Math.min(20.0, 1000.0 / Math.max(msPerTick, 0.001)));
        JsonArray players = new JsonArray();
        for (String name : server.getAllUsernames()) players.add(new JsonPrimitive(name));
        o.add("players", players);
        return o;
    }
}

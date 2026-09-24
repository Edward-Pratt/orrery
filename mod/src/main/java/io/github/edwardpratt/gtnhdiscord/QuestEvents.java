package io.github.edwardpratt.gtnhdiscord;

import java.util.UUID;
import java.util.function.Supplier;

import net.minecraft.util.StatCollector;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import betterquesting.api.api.ApiReference;
import betterquesting.api.api.QuestingAPI;
import betterquesting.api.events.QuestEvent;
import betterquesting.api.properties.NativeProps;
import betterquesting.api.questing.IQuest;
import betterquesting.api.utils.UuidConverter;
import cpw.mods.fml.common.eventhandler.EventPriority;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;

/**
 * BetterQuesting completions → {@code quest} messages. The only class that touches BetterQuesting types, and it is
 * only loaded when BetterQuesting is installed (see GtnhDiscord.serverStarting). Public because Forge's event bus
 * generates its caller in another package.
 */
public final class QuestEvents {

    private static final int MAX_QUESTS = 50; // the hub rejects larger messages

    private final Supplier<HubClient> client;
    /** Set after a BetterQuesting API mismatch: quest announcements stay off until restart. */
    private volatile boolean disabled;

    QuestEvents(Supplier<HubClient> client) {
        this.client = client;
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onQuest(QuestEvent e) {
        if (disabled) return;
        try {
            // BetterQuesting also posts COMPLETED with an empty set on every check.
            if (e.getType() != QuestEvent.Type.COMPLETED || e.getQuestIDs()
                .isEmpty()) return;
            HubClient c = client.get();
            if (c == null) return;
            JsonArray quests = new JsonArray();
            for (UUID id : e.getQuestIDs()) {
                IQuest quest = QuestingAPI.getAPI(ApiReference.QUEST_DB)
                    .get(id);
                if (quest == null || Boolean.TRUE.equals(quest.getProperty(NativeProps.SILENT))) continue;
                String key = "betterquesting.quest." + UuidConverter.encodeUuidStripPadding(id) + ".name";
                JsonObject q = new JsonObject();
                q.addProperty(
                    "name",
                    QuestNames.resolve(
                        key,
                        quest.getProperty(NativeProps.NAME),
                        StatCollector::canTranslate,
                        StatCollector::translateToLocal));
                q.addProperty("main", Boolean.TRUE.equals(quest.getProperty(NativeProps.MAIN)));
                quests.add(q);
                if (quests.size() == MAX_QUESTS) break;
            }
            if (quests.size() == 0) return;
            String player = QuestingAPI.getAPI(ApiReference.NAME_CACHE)
                .getName(e.getPlayerID());
            if (player == null || player.isEmpty()) return;
            JsonObject msg = GameEvents.msg("quest", "player", player);
            msg.add("quests", quests);
            c.send(msg);
        } catch (LinkageError err) {
            // A different BetterQuesting build (NoSuchFieldError/NoSuchMethodError). Not a RuntimeException, and it
            // would otherwise escape FML's event bus into the tick loop and crash the server.
            disabled = true;
            GtnhDiscord.LOG.error(
                "BetterQuesting API mismatch: Discord quest announcements disabled until restart. "
                    + "Rebuild gtnhdiscord against the server's BetterQuesting version.",
                err);
        } catch (RuntimeException ex) {
            GtnhDiscord.LOG.error("Discord bridge quest handler failed", ex);
        }
    }
}

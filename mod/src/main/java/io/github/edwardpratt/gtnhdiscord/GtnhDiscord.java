package io.github.edwardpratt.gtnhdiscord;

import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.common.config.Configuration;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.Mod;
import cpw.mods.fml.common.event.FMLPreInitializationEvent;
import cpw.mods.fml.common.event.FMLServerStartedEvent;
import cpw.mods.fml.common.event.FMLServerStartingEvent;
import cpw.mods.fml.common.event.FMLServerStoppedEvent;
import cpw.mods.fml.common.event.FMLServerStoppingEvent;

@Mod(
    modid = GtnhDiscord.MODID,
    version = Tags.VERSION,
    name = "GTNH Discord",
    acceptedMinecraftVersions = "[1.7.10]",
    acceptableRemoteVersions = "*")
public class GtnhDiscord {

    public static final String MODID = "gtnhdiscord";
    public static final Logger LOG = LogManager.getLogger(MODID);

    private String hubHost;
    private int hubPort;
    private String serverId;
    private String token;
    private HubClient client;
    private GameEvents events;

    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        Configuration config = new Configuration(event.getSuggestedConfigurationFile());
        String general = Configuration.CATEGORY_GENERAL;
        hubHost = config.getString("hubHost", general, "127.0.0.1", "Address of the gtnh-discord hub");
        hubPort = config.getInt("hubPort", general, 25580, 1, 65535, "TCP port of the hub");
        serverId = config.getString("serverId", general, "gtnh", "This server's id in the hub's config.json");
        token = config.getString("token", general, "", "This server's token from the hub's config.json");
        if (config.hasChanged()) config.save();
    }

    @Mod.EventHandler
    public void serverStarting(FMLServerStartingEvent event) {
        if (!event.getServer()
            .isDedicatedServer()) return;
        if (token.isEmpty()) {
            LOG.warn("No token set in config/gtnhdiscord.cfg - Discord bridge disabled");
            return;
        }
        client = new HubClient(hubHost, hubPort, serverId, token, Tags.VERSION);
        events = new GameEvents(client);
        MinecraftForge.EVENT_BUS.register(events);
        FMLCommonHandler.instance()
            .bus()
            .register(events);
        client.start();
        // SIGTERM (systemctl stop, Ctrl+C): vanilla's shutdown hook calls stopServer() directly, so
        // FMLServerStoppingEvent never fires. Announce the stop here too. Harmless after a clean /stop or a crash:
        // the client is already stopped, so this send is never delivered.
        final HubClient c = client;
        Runtime.getRuntime()
            .addShutdownHook(new Thread(() -> announceStop(c), "GTNHDiscord-shutdown"));
    }

    @Mod.EventHandler
    public void serverStarted(FMLServerStartedEvent event) {
        if (client != null) client.send(GameEvents.msg("started"));
    }

    @Mod.EventHandler
    public void serverStopping(FMLServerStoppingEvent event) {
        if (client == null) return;
        events.flushPending(); // e.g. `/cmd stop` gets its output before the connection closes
        announceStop(client);
    }

    /** Queues `stopping` and flushes it before the JVM can exit, so a clean stop never looks like a crash. */
    private static void announceStop(HubClient c) {
        c.send(GameEvents.msg("stopping"));
        c.stop(2000);
    }

    @Mod.EventHandler
    public void serverStopped(FMLServerStoppedEvent event) {
        if (client == null) return;
        client.stop(0); // no-op after a clean stop; after a crash, drops the connection right away
        MinecraftForge.EVENT_BUS.unregister(events);
        FMLCommonHandler.instance()
            .bus()
            .unregister(events);
        client = null;
        events = null;
    }
}

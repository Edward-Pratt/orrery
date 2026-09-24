import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type Webhook,
} from 'discord.js';
import { findCrashLogs } from './crashlogs.ts';
import type { Db } from './db.ts';
import {
  formatEvent,
  formatOutput,
  formatPlayers,
  formatPresence,
  formatStatus,
  formatTopic,
  md,
  topicDue,
  type TopicEdit,
} from './format.ts';
import type { RestartScheduler } from './restarts.ts';
import type { HubEvent, ServerHub } from './servers.ts';

export type DiscordConfig = {
  guildId: string;
  adminRoleId: string;
  /** serverId -> channelId */
  channels: Record<string, string>;
  /** serverId -> server folder, for crash-log uploads */
  dirs: Record<string, string>;
};

export type DiscordFrontend = { client: Client; post: (serverId: string, text: string) => void };

const DAY = 24 * 60 * 60 * 1000;
const WEBHOOK_NAME = 'GTNH Relay';
const CRASH_LOG_WINDOW_MS = 10 * 60_000;
const UNKNOWN_WEBHOOK = 10015; // Discord API error code

// Admin commands are hidden (default_member_permissions "0") until the admin role is allowed under
// Server Settings → Integrations; the adminRoleId check below still applies either way.
export const COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Server status, TPS and uptime'),
  new SlashCommandBuilder().setName('list').setDescription('Players online'),
  new SlashCommandBuilder()
    .setName('cmd')
    .setDescription('Run a server console command (admin role only)')
    .setDefaultMemberPermissions(0)
    .addStringOption((o) => o.setName('command').setDescription('Command, without the leading /').setRequired(true)),
  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart the server with an in-game countdown (admin role only)')
    .setDefaultMemberPermissions(0)
    .addSubcommand((s) =>
      s
        .setName('in')
        .setDescription('Schedule a restart')
        .addIntegerOption((o) =>
          o.setName('minutes').setDescription('Countdown length (0 = now)').setMinValue(0).setMaxValue(60).setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel the scheduled restart')),
].map((c) => c.toJSON());

/** Only people's own messages go into the game: not bots, webhooks (including our relay), or system notices. */
export function shouldRelay(m: Pick<Message, 'author' | 'webhookId' | 'system'>): boolean {
  return !m.author.bot && !m.webhookId && !m.system;
}

export async function startDiscord(
  hub: ServerHub,
  db: Db,
  restarts: RestartScheduler,
  cfg: DiscordConfig,
  token: string,
): Promise<DiscordFrontend> {
  const serverByChannel = new Map(Object.entries(cfg.channels).map(([serverId, channelId]) => [channelId, serverId]));
  const webhooks = new Map<string, Webhook>(); // serverId -> relay webhook
  const topics = new Map<string, TopicEdit>(); // channelId -> last edit
  let presence = '';
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [] }, // nothing the bot posts can ping anyone
  });

  async function post(serverId: string, text: string, files: string[] = []): Promise<void> {
    const channelId = cfg.channels[serverId];
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId);
    if (channel?.isSendable()) await channel.send({ content: text, files });
  }

  const postSafe = (serverId: string, text: string): void => {
    post(serverId, text).catch((err) => console.error(`[discord] post for ${serverId} failed:`, err));
  };

  // Game chat goes through the channel's webhook, with the player's name and skin; falls back to the bot.
  async function relayChat(e: Extract<HubEvent, { type: 'chat' }>): Promise<void> {
    const hook = webhooks.get(e.serverId);
    if (hook) {
      try {
        await hook.send({
          username: e.player,
          avatarURL: `https://mc-heads.net/avatar/${encodeURIComponent(e.player)}/64`,
          content: md(e.message),
          allowedMentions: { parse: [] },
        });
        return;
      } catch (err) {
        // A name Discord refuses for webhooks ("discord" in it) only affects this message; a deleted webhook
        // (Unknown Webhook, 10015) is forgotten so later chat doesn't retry it on every message.
        if ((err as { code?: number }).code === UNKNOWN_WEBHOOK) webhooks.delete(e.serverId);
        console.warn(`[discord] webhook send failed, posting as the bot: ${(err as Error).message}`);
      }
    }
    await post(e.serverId, formatEvent(e)!);
  }

  async function postCrash(serverId: string, text: string): Promise<void> {
    const files = cfg.dirs[serverId] ? await findCrashLogs(cfg.dirs[serverId], Date.now() - CRASH_LOG_WINDOW_MS) : [];
    try {
      await post(serverId, text, files);
    } catch (err) {
      if (!files.length) throw err;
      console.warn(`[discord] crash log upload failed, posting without it: ${(err as Error).message}`);
      await post(serverId, text);
    }
  }

  hub.on('event', (e) => {
    if (e.type === 'chat') {
      relayChat(e).catch((err) => console.error('[discord] chat relay failed:', err));
      return;
    }
    const text = formatEvent(e);
    if (!text) return;
    if (e.type === 'crashed') postCrash(e.serverId, text).catch((err) => console.error('[discord] crash post failed:', err));
    else postSafe(e.serverId, text);
  });

  client.on(Events.MessageCreate, (m) => {
    const serverId = serverByChannel.get(m.channelId);
    if (!serverId || !shouldRelay(m)) return;
    const text = [m.cleanContent, ...m.attachments.map((a) => a.url)].join(' ');
    hub.say(serverId, m.member?.displayName ?? m.author.username, text);
  });

  client.on(Events.InteractionCreate, (i) => {
    if (!i.isChatInputCommand()) return;
    handleCommand(i).catch((err) => console.error('[discord] command failed:', err));
  });

  async function handleCommand(i: ChatInputCommandInteraction): Promise<void> {
    const serverId = serverByChannel.get(i.channelId);
    const state = serverId ? hub.get(serverId) : undefined;
    if (!serverId || !state) {
      await i.reply({ content: 'This channel is not linked to a server.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.commandName === 'status') {
      const now = Date.now();
      await i.reply(formatStatus(state, db.uptime(serverId, now - DAY, now), db.uptime(serverId, now - 7 * DAY, now)));
      return;
    }
    if (i.commandName === 'list') {
      await i.reply(state.online ? formatPlayers(state.players) : `${md(state.name)} is offline.`);
      return;
    }
    // Admin commands from here on.
    if (!i.inCachedGuild() || !i.member.roles.cache.has(cfg.adminRoleId)) {
      await i.reply({ content: 'You need the admin role for this.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.commandName === 'cmd') {
      await i.deferReply(); // commands can take longer than Discord's 3 s reply window
      try {
        const output = await hub.runCommand(serverId, i.options.getString('command', true), `discord:${i.user.username} (${i.user.id})`);
        await i.editReply(formatOutput(output));
      } catch (err) {
        await i.editReply(`❌ ${(err as Error).message}`);
      }
    } else if (i.commandName === 'restart') {
      // The public announcement comes from the scheduler's notify; the reply is just for the admin.
      let reply: string;
      if (i.options.getSubcommand() === 'cancel') {
        reply = restarts.cancel(serverId, i.user.username) ? 'Restart cancelled.' : 'No restart is scheduled.';
      } else {
        try {
          restarts.schedule(serverId, i.options.getInteger('minutes', true), i.user.username);
          reply = 'Restart scheduled.';
        } catch (err) {
          reply = `❌ ${(err as Error).message}`;
        }
      }
      await i.reply({ content: reply, flags: MessageFlags.Ephemeral });
    }
  }

  async function setupWebhooks(c: Client<true>): Promise<void> {
    for (const [serverId, channelId] of Object.entries(cfg.channels)) {
      try {
        const channel = await c.channels.fetch(channelId);
        if (channel?.type !== ChannelType.GuildText) continue;
        const existing = (await channel.fetchWebhooks()).find((h) => h.owner?.id === c.user.id && h.name === WEBHOOK_NAME);
        webhooks.set(serverId, existing ?? (await channel.createWebhook({ name: WEBHOOK_NAME })));
      } catch (err) {
        console.warn(`[discord] no chat webhook for ${serverId} (needs Manage Webhooks), posting as the bot: ${(err as Error).message}`);
      }
    }
  }

  function updatePresence(): void {
    const text = formatPresence(hub.list());
    if (text === presence) return;
    presence = text;
    client.user?.setPresence({ activities: [{ name: 'Custom Status', state: text, type: ActivityType.Custom }] });
  }

  async function updateTopics(): Promise<void> {
    const now = Date.now();
    for (const s of hub.list()) {
      const channelId = cfg.channels[s.id];
      const text = formatTopic(s);
      if (!channelId || !topicDue(topics.get(channelId), text, now)) continue;
      topics.set(channelId, { text, at: now }); // also on failure: don't retry until the text changes
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.type === ChannelType.GuildText) await channel.setTopic(text);
      } catch (err) {
        console.warn(`[discord] topic update for ${s.id} failed (needs Manage Channels): ${(err as Error).message}`);
      }
    }
  }

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
    c.guilds
      .fetch(cfg.guildId)
      .then((guild) => guild.commands.set(COMMANDS))
      .catch((err) => console.error('[discord] registering slash commands failed:', err));
    setupWebhooks(c).catch((err) => console.error('[discord] webhook setup failed:', err));
    updatePresence();
    setInterval(updatePresence, 30_000).unref();
    setInterval(() => void updateTopics(), 60_000).unref();
  });

  await client.login(token);
  return { client, post: postSafe };
}

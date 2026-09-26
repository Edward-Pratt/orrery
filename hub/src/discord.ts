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
import { basename } from 'node:path';
import {
  formatBackupList,
  formatBackupStatus,
  formatEvent,
  formatNotice,
  formatOutput,
  formatPlayers,
  formatPlaytime,
  formatPresence,
  formatStatus,
  formatTop,
  formatTopic,
  formatTps,
  md,
  topicDue,
  type Post,
  type TopicEdit,
} from './format.ts';
import type { DiscordConfig } from './config.ts';
import type { Links } from './links.ts';
import type { RestartScheduler } from './restarts.ts';
import type { HubEvent, ServerHub } from './servers.ts';
import type { Period, Stats } from './stats.ts';

export type DiscordFrontend = {
  client: Client;
};

const WEBHOOK_NAME = 'GTNH Relay';
const CRASH_LOG_WINDOW_MS = 10 * 60_000;
// Discord API error codes.
const UNKNOWN_WEBHOOK = 10015;
const MISSING_PERMISSIONS = 50013;
const INVALID_FORM_BODY = 50035; // e.g. a webhook username containing "discord"

const ADMIN_COMMANDS = new Set(['cmd', 'restart', 'backup']);

// Admin commands are hidden (default_member_permissions "0") until the admin role is allowed under
// Server Settings → Integrations; the adminRoleId check below still applies either way.
export const COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Server status, TPS and uptime'),
  new SlashCommandBuilder().setName('list').setDescription('Players online'),
  new SlashCommandBuilder().setName('tps').setDescription('TPS now, over the last hour and day, and the slowest dimensions'),
  new SlashCommandBuilder()
    .setName('playtime')
    .setDescription("A player's playtime and when they were last seen")
    .addStringOption((o) => o.setName('player').setDescription('Minecraft name'))
    .addUserOption((o) => o.setName('user').setDescription('Or a Discord member who has linked their account')),
  new SlashCommandBuilder().setName('link').setDescription('Link your Discord account to your Minecraft name'),
  new SlashCommandBuilder().setName('unlink').setDescription('Remove the link to your Minecraft name'),
  new SlashCommandBuilder()
    .setName('top')
    .setDescription('Top players by playtime')
    .addStringOption((o) =>
      o
        .setName('period')
        .setDescription('Default: last 7 days')
        .addChoices(
          { name: 'last 24 hours', value: 'day' },
          { name: 'last 7 days', value: 'week' },
          { name: 'all time', value: 'all' },
        ),
    ),
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
  new SlashCommandBuilder()
    .setName('backup')
    .setDescription('ServerUtilities backups (admin role only)')
    .setDefaultMemberPermissions(0)
    .addSubcommand((s) => s.setName('start').setDescription('Start a backup now and report when it finishes'))
    .addSubcommand((s) => s.setName('status').setDescription('Newest backup, count and total size'))
    .addSubcommand((s) => s.setName('list').setDescription('The 10 newest backups with sizes')),
].map((c) => c.toJSON());

/** Only people's own messages go into the game: not bots, webhooks (including our relay), or system notices. */
export function shouldRelay(m: Pick<Message, 'author' | 'webhookId' | 'system'>): boolean {
  return !m.author.bot && !m.webhookId && !m.system;
}

const errorCode = (err: unknown) => (err as { code?: number }).code;

export async function startDiscord(
  hub: ServerHub,
  stats: Stats,
  restarts: RestartScheduler,
  links: Links,
  cfg: DiscordConfig,
  token: string,
): Promise<DiscordFrontend> {
  const channels = new Map(Object.entries(cfg.channels)); // serverId -> channelId; a Map, so no inherited keys
  const serverByChannel = new Map([...channels].map(([serverId, channelId]) => [channelId, serverId]));
  const webhooks = new Map<string, Webhook>(); // serverId -> relay webhook
  const refusedNames = new Set<string>(); // player names Discord won't accept as a webhook username
  const topics = new Map<string, TopicEdit>(); // channelId -> last edit
  let presence = '';
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [] }, // nothing the bot posts can ping anyone
  });

  async function post(serverId: string, message: Post, files: string[] = []): Promise<void> {
    const channelId = channels.get(serverId);
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId);
    if (channel?.isSendable()) await channel.send({ ...message, files });
  }

  const postSafe = (serverId: string, message: Post): void => {
    post(serverId, message).catch((err) => console.error(`[discord] post for ${serverId} failed:`, err));
  };

  // Game chat goes through the channel's webhook, with the player's name and skin; falls back to the bot.
  async function relayChat(e: Extract<HubEvent, { type: 'chat' }>): Promise<void> {
    const hook = webhooks.get(e.serverId);
    if (hook && !refusedNames.has(e.player)) {
      try {
        await hook.send({
          username: e.player,
          avatarURL: `https://mc-heads.net/avatar/${encodeURIComponent(e.player)}/64`,
          content: md(e.message),
          allowedMentions: { parse: [] },
        });
        return;
      } catch (err) {
        // A deleted webhook is forgotten; a refused name is remembered, so neither is retried per message.
        if (errorCode(err) === UNKNOWN_WEBHOOK) webhooks.delete(e.serverId);
        if (errorCode(err) === INVALID_FORM_BODY) refusedNames.add(e.player);
        console.warn(`[discord] webhook send failed, posting as the bot: ${(err as Error).message}`);
      }
    }
    await post(e.serverId, formatEvent(e)!);
  }

  async function postCrash(serverId: string, message: Post): Promise<void> {
    const files = await stats.crashLogs(serverId, Date.now() - CRASH_LOG_WINDOW_MS);
    const withNote: Post =
      files.length && 'embeds' in message
        ? { embeds: [{ ...message.embeds[0], description: `Crash logs attached: ${files.map((f) => basename(f)).join(', ')}` }] }
        : message;
    try {
      await post(serverId, withNote, files);
    } catch (err) {
      if (!files.length) throw err;
      console.warn(`[discord] crash log upload failed, posting without it: ${(err as Error).message}`);
      await post(serverId, message);
    }
  }

  hub.on('event', (e) => {
    if (e.type === 'chat') {
      relayChat(e).catch((err) => console.error('[discord] chat relay failed:', err));
      return;
    }
    const message = formatEvent(e);
    if (!message) return;
    if (e.type === 'crashed') postCrash(e.serverId, message).catch((err) => console.error('[discord] crash post failed:', err));
    else postSafe(e.serverId, message);
  });

  client.on(Events.MessageCreate, (m) => {
    const serverId = serverByChannel.get(m.channelId);
    if (!serverId || !shouldRelay(m)) return;
    const text = [m.cleanContent, ...m.attachments.map((a) => a.url)].join(' ');
    // Linked people appear in game under their Minecraft name.
    hub.say(serverId, stats.linkedPlayer(m.author.id) ?? m.member?.displayName ?? m.author.username, text);
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
    const now = Date.now();
    if (i.commandName === 'status') {
      const s = stats.status(serverId, now)!;
      await i.reply(formatStatus(s.state, s.uptimeDay, s.uptimeWeek));
      return;
    }
    if (i.commandName === 'list') {
      await i.reply(state.online ? formatPlayers(state.players) : formatNotice(`🔴 ${state.name} is offline`));
      return;
    }
    if (i.commandName === 'tps') {
      const t = stats.tps(serverId, now)!;
      await i.reply(formatTps(t.state, t.lastHour, t.hour, t.day));
      return;
    }
    if (i.commandName === 'link') {
      const code = links.issue(i.user.id, i.user.username);
      await i.reply({ content: `In game, type \`/discord link ${code}\` within 10 minutes.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.commandName === 'unlink') {
      const removed = links.unlinkDiscord(i.user.id);
      await i.reply({ content: removed ? 'Unlinked.' : "You weren't linked.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.commandName === 'playtime') {
      const user = i.options.getUser('user');
      const p = stats.playtime(serverId, user ? { discordId: user.id } : { player: i.options.getString('player') ?? undefined }, now)!;
      if (!p.found) {
        const content = user ? `${user.username} hasn't linked a Minecraft account (use /link).` : 'Give a player name or a Discord user.';
        await i.reply({ content, flags: MessageFlags.Ephemeral });
        return;
      }
      await i.reply(formatPlaytime(p.player, p.totalMs, p.weekMs, p.lastSeen, now));
      return;
    }
    if (i.commandName === 'top') {
      const period = (i.options.getString('period') ?? 'week') as Period;
      await i.reply(formatTop(period, stats.top(serverId, period, now)!));
      return;
    }
    if (!ADMIN_COMMANDS.has(i.commandName)) return;
    if (!i.inCachedGuild() || !i.member.roles.cache.has(cfg.adminRoleId)) {
      await i.reply({ content: 'You need the admin role for this.', flags: MessageFlags.Ephemeral });
      return;
    }
    const audit = `discord:${i.user.username} (${i.user.id})`;
    if (i.commandName === 'cmd') {
      await i.deferReply(); // commands can take longer than Discord's 3 s reply window
      try {
        // Replies that arrive later (e.g. spark's profiler link) are posted as follow-ups.
        const onLate = (lines: string[]) => {
          i.followUp(formatOutput(lines)).catch((err) => console.error('[discord] late output follow-up failed:', err));
        };
        await i.editReply(formatOutput(await hub.runCommand(serverId, i.options.getString('command', true), audit, onLate)));
      } catch (err) {
        await i.editReply(`❌ ${(err as Error).message}`);
      }
    } else if (i.commandName === 'restart') {
      // The public announcement comes from the scheduler's notice; the reply is just for the admin.
      let reply: string;
      if (i.options.getSubcommand() === 'cancel') {
        reply = restarts.cancel(serverId, i.user.username) ? 'Restart cancelled.' : 'No restart is scheduled.';
      } else {
        try {
          restarts.schedule(serverId, i.options.getInteger('minutes', true), audit, i.user.username);
          reply = 'Restart scheduled.';
        } catch (err) {
          reply = `❌ ${(err as Error).message}`;
        }
      }
      await i.reply({ content: reply, flags: MessageFlags.Ephemeral });
    } else if (i.commandName === 'backup') {
      const b = (await stats.backups(serverId))!;
      if (!b.configured) {
        await i.reply({ content: 'Set "dir" (or "backupDir") for this server in config.json.', flags: MessageFlags.Ephemeral });
        return;
      }
      const sub = i.options.getSubcommand();
      if (sub === 'status') {
        await i.reply(formatBackupStatus(b.backups, Date.now(), b.free));
      } else if (sub === 'list') {
        await i.reply(formatBackupList(b.backups));
      } else {
        await i.deferReply();
        try {
          // The "finished"/"failed" notice follows in the channel, from the mod's backup event.
          await i.editReply(formatOutput(await hub.runCommand(serverId, 'backup start', audit)));
        } catch (err) {
          await i.editReply(`❌ ${(err as Error).message}`);
        }
      }
    }
  }

  async function setupWebhooks(c: Client<true>): Promise<void> {
    for (const [serverId, channelId] of channels) {
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
      const channelId = channels.get(s.id);
      const text = formatTopic(s);
      if (!channelId || !topicDue(topics.get(channelId), text, now)) continue;
      topics.set(channelId, { text, at: now }); // also on failure: don't retry until the text changes
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.type === ChannelType.GuildText) await channel.setTopic(text);
      } catch (err) {
        const hint = errorCode(err) === MISSING_PERMISSIONS ? ' (the bot needs Manage Channels)' : '';
        console.warn(`[discord] topic update for ${s.id} failed${hint}: ${(err as Error).message}`);
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
  return {
    client,
  };
}

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
  chatContent,
  formatBackupList,
  formatBackupStatus,
  formatEvent,
  formatLinkHint,
  formatNotice,
  formatOutput,
  formatPlayers,
  formatPlaytime,
  formatPresence,
  formatStatus,
  formatTargetEvent,
  formatTop,
  formatTopic,
  formatTps,
  topicDue,
  type Post,
  type TopicEdit,
} from './format.ts';
import type { DiscordConfig } from './config.ts';
import type { Links } from './links.ts';
import type { RestartScheduler } from './restarts.ts';
import type { HubEvent, LiveEvent, ServerHub } from './servers.ts';
import type { Period, Stats } from './stats.ts';
import type { Game } from './types.ts';

export type DiscordFrontend = {
  client: Client;
};

const WEBHOOK_NAME = 'GTNH Relay';
const CRASH_LOG_WINDOW_MS = 10 * 60_000;
// Discord API error codes.
const UNKNOWN_WEBHOOK = 10015;
const MISSING_PERMISSIONS = 50013;
const INVALID_FORM_BODY = 50035; // a field Discord won't take: a webhook username containing "discord", content too long

const ADMIN_COMMANDS = new Set(['cmd', 'restart', 'backup']);

// Admin commands are hidden (default_member_permissions "0") until the admin role is allowed under
// Server Settings → Integrations; the adminRoleId check below still applies either way.
export const COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Server status, TPS/UPS and uptime'),
  new SlashCommandBuilder().setName('list').setDescription('Players online'),
  new SlashCommandBuilder().setName('tps').setDescription("TPS/UPS now, over the last hour and day, and a Minecraft server's slowest dimensions"),
  new SlashCommandBuilder()
    .setName('playtime')
    .setDescription("A player's playtime and when they were last seen")
    .addStringOption((o) => o.setName('player').setDescription('In-game name'))
    .addUserOption((o) => o.setName('user').setDescription('Or a Discord member who has linked their account')),
  new SlashCommandBuilder().setName('link').setDescription('Link your Discord account to your in-game name'),
  new SlashCommandBuilder().setName('unlink').setDescription('Remove the link to your in-game name'),
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
    .addStringOption((o) => o.setName('command').setDescription('The command, as typed in the server console').setRequired(true)),
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
    .setDescription('Backups (admin role only)')
    .setDefaultMemberPermissions(0)
    .addSubcommand((s) => s.setName('start').setDescription('Start a backup now and report when it finishes'))
    .addSubcommand((s) => s.setName('status').setDescription('Newest backup, count and total size'))
    .addSubcommand((s) => s.setName('list').setDescription('The 10 newest backups with sizes')),
].map((c) => c.toJSON());

/** Only people's own messages go into the game: not bots, webhooks (including our relay), or system notices. */
export function shouldRelay(m: Pick<Message, 'author' | 'webhookId' | 'system'>): boolean {
  return !m.author.bot && !m.webhookId && !m.system;
}

/** Where an event is posted: its server's channel, or the alerts channel for the host, services and checks. */
export function channelFor(e: LiveEvent, cfg: DiscordConfig): string | undefined {
  if ('target' in e) return cfg.alertsChannel;
  return Object.hasOwn(cfg.channels, e.serverId) ? cfg.channels[e.serverId] : undefined;
}

/**
 * Posts each announced event about the host, a service or a check to the alerts channel (none: not posted). Server
 * events never come this way: they go to their own server's channel.
 */
export function postTargets(hub: ServerHub, cfg: DiscordConfig, post: (channelId: string, message: Post) => Promise<void>): void {
  hub.on('target', (e) => {
    const channelId = channelFor(e, cfg);
    const message = formatTargetEvent(e);
    if (!channelId || !message) return;
    post(channelId, message).catch((err) => console.error(`[discord] alert for ${e.target} ${e.id} failed:`, err));
  });
}

/**
 * Who a chat line is posted as through the relay webhook, or null to post it as the bot (`formatEvent`, the name
 * escaped). A dashboard line: `<admin> (dashboard)` with their avatar. A minecraft player: their name with their skin.
 * A factorio player: `<name> (Factorio)`, so a line can never pass for a dashboard one or the bot, and only for a name
 * with no whitespace or parentheses: any text can come as a name from the game's mods or the Agent, and `Edward
 * (dashboard)` would look like the owner's line.
 */
export function relayAs(e: Extract<HubEvent, { type: 'chat' | 'say' }>, game: Game | undefined): { username: string; avatarURL?: string } | null {
  if (e.type === 'say') return { username: `${e.author} (dashboard)`, avatarURL: e.avatar };
  if (game === 'factorio') return /[\s()]/.test(e.player) ? null : { username: `${e.player} (Factorio)` };
  return { username: e.player, avatarURL: game === 'minecraft' ? `https://mc-heads.net/avatar/${encodeURIComponent(e.player)}/64` : undefined };
}

const errorCode = (err: unknown) => (err as { code?: number }).code;

/** Whether Discord refused a webhook send for its username (one containing "discord", say), not for anything else. */
export function usernameRefused(err: unknown): boolean {
  const errors = (err as { rawError?: { errors?: unknown } }).rawError?.errors;
  return errorCode(err) === INVALID_FORM_BODY && typeof errors === 'object' && errors !== null && Object.hasOwn(errors, 'username');
}

/**
 * Posts a chat line through a channel's relay webhook under `username`, escaped and cut to Discord's 2000 characters.
 * Throws what Discord answered; a name it refused is remembered in `refusedNames`, so it isn't tried again, while any
 * other error (the content, a deleted webhook) leaves the name alone.
 */
export async function sendChat(
  hook: Pick<Webhook, 'send'>,
  refusedNames: Set<string>,
  username: string,
  avatarURL: string | undefined,
  message: string,
): Promise<void> {
  try {
    await hook.send({ username, avatarURL, content: chatContent(message), allowedMentions: { parse: [] } });
  } catch (err) {
    if (usernameRefused(err)) refusedNames.add(username);
    throw err;
  }
}

/** The parts of a slash command's interaction `/backup` uses. */
export type BackupInteraction = Pick<ChatInputCommandInteraction, 'reply' | 'deferReply' | 'editReply'> & {
  options: Pick<ChatInputCommandInteraction['options'], 'getSubcommand'>;
};

/**
 * `/backup` in a server's channel (its admin role already checked): `status` and `list` of the server's Backups (a
 * factorio server's saves), or `start`, a Backup now through `ServerHub.backup` as `by`. The finished/failed notice
 * follows in the channel, from the game's backup event.
 */
export async function backupCommand(
  i: BackupInteraction,
  hub: Pick<ServerHub, 'get' | 'backup'>,
  stats: Pick<Stats, 'backups'>,
  serverId: string,
  by: string,
): Promise<void> {
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
      const output = await hub.backup(serverId, by);
      // A Mod answers with its command's output; an Agent's save has none.
      await i.editReply(hub.get(serverId)?.game === 'factorio' ? '💾 Saving: the notice follows here once the save is written.' : formatOutput(output));
    } catch (err) {
      await i.editReply(`❌ ${(err as Error).message}`);
    }
  }
}

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
  const refusedNames = new Set<string>(); // names Discord won't accept as a webhook username
  const topics = new Map<string, TopicEdit>(); // channelId -> last edit
  let presence = '';
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [] }, // nothing the bot posts can ping anyone
  });

  async function post(serverId: string, message: Post, files: string[] = []): Promise<void> {
    await postTo(channels.get(serverId), message, files);
  }

  async function postTo(channelId: string | undefined, message: Post, files: string[] = []): Promise<void> {
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId);
    if (channel?.isSendable()) await channel.send({ ...message, files });
  }

  const postSafe = (serverId: string, message: Post): void => {
    post(serverId, message).catch((err) => console.error(`[discord] post for ${serverId} failed:`, err));
  };

  // Game chat and dashboard lines go through the channel's webhook, under the name `relayAs` gives; falls back to the bot.
  async function relayChat(e: Extract<HubEvent, { type: 'chat' | 'say' }>): Promise<void> {
    const as = relayAs(e, hub.get(e.serverId)?.game);
    const hook = webhooks.get(e.serverId);
    if (hook && as && !refusedNames.has(as.username)) {
      try {
        await sendChat(hook, refusedNames, as.username, as.avatarURL, e.message);
        return;
      } catch (err) {
        // A deleted webhook is forgotten (and a refused name remembered, by sendChat), so neither is retried per message.
        if (errorCode(err) === UNKNOWN_WEBHOOK) webhooks.delete(e.serverId);
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
    if (e.type === 'chat' || (e.type === 'say' && e.source === 'dashboard')) {
      relayChat(e).catch((err) => console.error('[discord] chat relay failed:', err));
      return;
    }
    const message = formatEvent(e, hub.get(e.serverId)?.game);
    if (!message) return;
    if (e.type === 'crashed') postCrash(e.serverId, message).catch((err) => console.error('[discord] crash post failed:', err));
    else postSafe(e.serverId, message);
  });

  postTargets(hub, cfg, postTo);

  client.on(Events.MessageCreate, (m) => {
    const serverId = serverByChannel.get(m.channelId);
    if (!serverId || !shouldRelay(m)) return;
    const text = [m.cleanContent, ...m.attachments.map((a) => a.url)].join(' ');
    // Linked people appear in game under their name in that server's game.
    hub.say(serverId, stats.linkedPlayer(serverId, m.author.id) ?? m.member?.displayName ?? m.author.username, text, 'discord');
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
      const games = [...new Set(hub.list().map((s) => s.game))];
      await i.reply({ content: formatLinkHint(code, games), flags: MessageFlags.Ephemeral });
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
        const content = user ? `${user.username} hasn't linked an in-game name here (use /link).` : 'Give a player name or a Discord user.';
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
        reply = restarts.cancel(serverId, audit, i.user.username) ? 'Restart cancelled.' : 'No restart is scheduled.';
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
      await backupCommand(i, hub, stats, serverId, audit);
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

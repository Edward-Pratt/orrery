// Discord frontend, the bot: the client (intents, `allowedMentions: { parse: [] }`), webhook chat (game chat and
// dashboard lines through each channel's relay webhook, set up at login, under the name `relayAs` gives, and posted
// as the bot when there is none, the name is refused or the send fails; the rules in `relay.ts`), Discord chat into
// the game under the author's linked name in that server's game (`Stats.linkedPlayer`), alerts (+ crash-log uploads;
// where each goes and an Agent's lost and back in `alerts.ts`), presence, topics, notices as embeds (each with its
// server's game, which words its updates), and the slash commands (`commands.ts`). This file re-exports the names
// callers import from it.

import { ActivityType, ChannelType, Client, Events, GatewayIntentBits, type Webhook } from 'discord.js';
import { basename } from 'node:path';
import type { DiscordUsers } from './admin.ts';
import { postTargets } from './alerts.ts';
import { COMMANDS, handleCommand, type CommandCtx } from './commands.ts';
import { formatEvent, formatPresence, formatTopic, topicDue, type Post, type TopicEdit } from './format.ts';
import { errorCode, MISSING_PERMISSIONS, relayAs, sendChat, shouldRelay, UNKNOWN_WEBHOOK } from './relay.ts';
import type { DiscordConfig } from '../config.ts';
import type { Links } from '../servers/links.ts';
import type { RestartScheduler } from '../servers/restarts.ts';
import type { HubEvent, ServerHub } from '../servers/servers.ts';
import type { Stats } from '../stats/stats.ts';

export { AGENT_ALERT_MS, agentAlerts, channelFor, postTargets } from './alerts.ts';
export { backupCommand, COMMANDS, type BackupInteraction } from './commands.ts';
export { REFUSED_KEPT, relayAs, sendChat, shouldRelay, usernameRefused } from './relay.ts';

export type DiscordFrontend = {
  client: Client;
  /** Stops it: held alerts dropped, the client destroyed. */
  stop: () => void;
};

const WEBHOOK_NAME = 'GTNH Relay';
const CRASH_LOG_WINDOW_MS = 10 * 60_000;

export async function startDiscord(
  hub: ServerHub,
  stats: Stats,
  restarts: RestartScheduler,
  links: Links,
  cfg: DiscordConfig,
  token: string,
  users?: DiscordUsers,
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
  const commandCtx: CommandCtx = { hub, stats, restarts, links, cfg, serverByChannel, users };

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

  const stopTargets = postTargets(hub, cfg, postTo);

  client.on(Events.MessageCreate, (m) => {
    const serverId = serverByChannel.get(m.channelId);
    if (!serverId || !shouldRelay(m)) return;
    const text = [m.cleanContent, ...m.attachments.map((a) => a.url)].join(' ');
    // Linked people appear in game under their name in that server's game.
    hub.say(serverId, stats.linkedPlayer(serverId, m.author.id) ?? m.member?.displayName ?? m.author.username, text, 'discord');
  });

  client.on(Events.InteractionCreate, (i) => {
    if (!i.isChatInputCommand()) return;
    handleCommand(commandCtx, i).catch((err) => console.error('[discord] command failed:', err));
  });

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
    stop: () => {
      stopTargets();
      void client.destroy();
    },
  };
}
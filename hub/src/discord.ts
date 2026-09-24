import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Db } from './db.ts';
import { stripCodes, type HubEvent, type ServerHub, type ServerState } from './servers.ts';

export type DiscordConfig = {
  guildId: string;
  adminRoleId: string;
  /** serverId -> channelId */
  channels: Record<string, string>;
};

const DAY = 24 * 60 * 60 * 1000;

const COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Server status, TPS and uptime'),
  new SlashCommandBuilder().setName('list').setDescription('Players online'),
  new SlashCommandBuilder()
    .setName('cmd')
    .setDescription('Run a server console command (admin role only)')
    .addStringOption((o) => o.setName('command').setDescription('Command, without the leading /').setRequired(true)),
].map((c) => c.toJSON());

/** Escapes Minecraft text for Discord: no § codes, no markdown, headings, lists or masked links. */
export function md(s: string): string {
  return escapeMarkdown(stripCodes(s), { heading: true, maskedLink: true, bulletedList: true, numberedList: true });
}

/** The Discord post for a hub event, or null for events that aren't announced. */
export function formatEvent(e: HubEvent): string | null {
  switch (e.type) {
    case 'chat':
      return `**${md(e.player)}**: ${md(e.message)}`;
    case 'join':
      return `➡️ **${md(e.player)}** joined`;
    case 'leave':
      return `⬅️ **${md(e.player)}** left`;
    case 'death':
      return `💀 ${md(e.message)}`;
    case 'achievement':
      return `🏆 **${md(e.player)}** earned **${md(e.achievement)}**`;
    case 'started':
      return '✅ Server started';
    case 'stopped':
      return '🛑 Server stopped';
    case 'crashed':
      return '💥 Server went down unexpectedly';
    case 'hung':
      return '⚠️ Server not responding';
    case 'recovered':
      return '✅ Server responding again';
    case 'connected': // may just be a reconnect after a hub restart
    case 'offline': // hub-start bookkeeping for uptime, not news
      return null;
  }
}

export function formatStatus(s: ServerState, day: number | null, week: number | null): string {
  const pct = (u: number | null) => (u === null ? 'n/a' : `${(u * 100).toFixed(1)}%`);
  const status = !s.online ? '🔴 Offline' : s.hung ? '🟠 Not responding' : '🟢 Online';
  const lines = [`**${md(s.name)}** — ${status}`];
  if (s.online) lines.push(`TPS: ${s.tps === null ? 'n/a' : s.tps.toFixed(1)} · Players: ${s.players.length}`);
  lines.push(`Uptime: 24h ${pct(day)} · 7d ${pct(week)}`);
  return lines.join('\n');
}

export function formatPlayers(players: string[]): string {
  return players.length ? `Online (${players.length}): ${players.map(md).join(', ')}` : 'Nobody online.';
}

/** Command output as a code block that always fits in one Discord message. */
export function formatOutput(lines: string[]): string {
  const max = 1900;
  let text = stripCodes(lines.join('\n')).replaceAll('```', "'''") || '(no output)';
  if (text.length > max) text = text.slice(0, max) + '\n… (truncated)';
  return '```\n' + text + '\n```';
}

export async function startDiscord(hub: ServerHub, db: Db, cfg: DiscordConfig, token: string): Promise<Client> {
  const serverByChannel = new Map(Object.entries(cfg.channels).map(([serverId, channelId]) => [channelId, serverId]));
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [] }, // nothing the bot posts can ping anyone
  });

  hub.on('event', (e) => {
    const text = formatEvent(e);
    const channelId = cfg.channels[e.serverId];
    if (!text || !channelId) return;
    post(channelId, text).catch((err) => console.error(`[discord] post to ${channelId} failed:`, err));
  });

  async function post(channelId: string, text: string): Promise<void> {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isSendable()) await channel.send(text);
  }

  client.on(Events.MessageCreate, (m) => {
    const serverId = serverByChannel.get(m.channelId);
    if (!serverId || m.author.bot || m.webhookId) return;
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
    } else if (i.commandName === 'list') {
      await i.reply(state.online ? formatPlayers(state.players) : `${md(state.name)} is offline.`);
    } else if (i.commandName === 'cmd') {
      if (!i.inCachedGuild() || !i.member.roles.cache.has(cfg.adminRoleId)) {
        await i.reply({ content: 'You need the admin role to run commands.', flags: MessageFlags.Ephemeral });
        return;
      }
      await i.deferReply(); // commands can take longer than Discord's 3 s reply window
      try {
        const output = await hub.runCommand(serverId, i.options.getString('command', true), `discord:${i.user.username} (${i.user.id})`);
        await i.editReply(formatOutput(output));
      } catch (err) {
        await i.editReply(`❌ ${(err as Error).message}`);
      }
    }
  }

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
    c.guilds
      .fetch(cfg.guildId)
      .then((guild) => guild.commands.set(COMMANDS))
      .catch((err) => console.error('[discord] registering slash commands failed:', err));
  });

  await client.login(token);
  return client;
}

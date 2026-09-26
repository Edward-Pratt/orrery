import { escapeMarkdown, type APIEmbed } from 'discord.js';
import { growthPerDay, type Backup } from './backups.ts';
import { sparkline } from './lag.ts';
import { countdownText } from './restarts.ts';
import { stripCodes, truncate, type Announcement, type HubEvent, type Notice, type ServerState, type Severity } from './servers.ts';
import type { Summary } from './summary.ts';
import { formatBytes, formatDuration } from './units.ts';

/** What the bot posts: plain text (chat-like messages) or an embed (everything else). */
export type Post = { content: string } | { embeds: APIEmbed[] };

export const COLORS = { green: 0x2ecc71, grey: 0x95a5a6, red: 0xe74c3c, orange: 0xe67e22, blue: 0x3498db } as const;

// Discord embed limits.
const TITLE = 256;
const FIELD = 1024;
const DESCRIPTION = 4096;

/** Escapes Minecraft text for Discord: no § codes, no markdown, headings, lists or masked links. */
export function md(s: string): string {
  return escapeMarkdown(stripCodes(s), { heading: true, maskedLink: true, bulletedList: true, numberedList: true });
}

/** Embed titles render less markdown than descriptions, so they only get § codes stripped. */
function title(s: string): string {
  return truncate(stripCodes(s), TITLE);
}

const embed = (e: APIEmbed): Post => ({ embeds: [e] });

const SEVERITY_COLORS: Record<Severity, number> = { problem: COLORS.red, warning: COLORS.orange, good: COLORS.green, info: COLORS.blue };

function noticeText(n: Notice): string {
  switch (n.kind) {
    case 'restartScheduled':
      return `🔄 Restart in ${countdownText(n.ms)} (by ${n.by})`;
    case 'restartNow':
      return '🔄 Restarting now';
    case 'restartCancelled':
      return `❎ Restart cancelled (by ${n.by})`;
    case 'restartCancelledDown':
      return '❎ Restart cancelled (server went down)';
    case 'restartFailed':
      return `❌ Restart failed: ${n.error}`;
    case 'lag': {
      const where = n.worst ? `${n.worst.name} (DIM ${n.worst.id}) ${Math.round(n.worst.ms)} ms/tick` : 'unknown';
      return `🐢 Lag: ${n.tps.toFixed(1)} TPS; slowest: ${where}`;
    }
    case 'lagRecovered':
      return `✅ TPS back to normal (${n.tps.toFixed(1)})`;
    case 'backupOverdue':
      return `⚠️ No new backup for ${n.hours} h (newest: ${n.newest})`;
    case 'backupsMissing':
      return '⚠️ No backups found';
    case 'lowDisk':
      return `⚠️ Low disk space for backups: ${formatBytes(n.free)} free (limit ${n.minFreeGB} GB)`;
    case 'backupFinished':
      return `✅ Backup finished (${n.detail})`;
    case 'backupFailed':
      return `❌ Backup failed: ${n.detail}`;
  }
}

/** The Discord post for a hub event, or null for events that aren't announced. */
export function formatEvent(e: HubEvent): Post | null {
  switch (e.type) {
    case 'chat':
      return { content: `**${md(e.player)}**: ${md(e.message)}` };
    case 'join':
      return { content: `➡️ **${md(e.player)}** joined` };
    case 'leave':
      return { content: `⬅️ **${md(e.player)}** left` };
    case 'death':
      return { content: `💀 ${md(e.message)}` };
    case 'achievement':
      return { content: `🏆 **${md(e.player)}** earned **${md(e.achievement)}**` };
    case 'started':
      return embed({ title: '✅ Server started', color: COLORS.green });
    case 'stopped':
      return embed({ title: '🛑 Server stopped', color: COLORS.grey });
    case 'crashed':
      return embed({ title: '💥 Server went down unexpectedly', color: COLORS.red });
    case 'hung':
      return embed({ title: '⚠️ Server not responding', color: COLORS.orange });
    case 'recovered':
      return embed({ title: '✅ Server responding again', color: COLORS.green });
    case 'notice':
      return embed({ title: title(noticeText(e)), color: SEVERITY_COLORS[e.severity] });
    case 'questBatch':
      return formatQuests(e);
    case 'linked':
      return formatLinked(e.player, e.discordId);
    case 'summary':
      return formatSummary(e.name, e.summary);
    case 'connected': // may just be a reconnect after a hub restart
    case 'offline': // hub-start bookkeeping for uptime, not news
    case 'quest': // the QuestAnnouncer turns it into questBatch announcements
    case 'link': // answered by Links, which announces a new link
    case 'unlink':
    case 'backup': // the BackupWatcher publishes it as a notice
    case 'say': // chat sent into the game: Discord's own came from its channel
    case 'console': // the /cmd reply shows it to whoever ran it
    case 'tps': // for the dashboard; /tps and lag notices cover Discord
      return null;
  }
}

/** A short informational line as an embed (e.g. a command's "server is offline" reply). */
export function formatNotice(text: string): Post {
  return embed({ title: title(text), color: COLORS.blue });
}

const pct = (u: number | null) => (u === null ? 'n/a' : `${(u * 100).toFixed(1)}%`);

export function formatStatus(s: ServerState, day: number | null, week: number | null): Post {
  const [state, color] = !s.online
    ? ['🔴 Offline', COLORS.red]
    : s.hung
      ? ['🟠 Not responding', COLORS.orange]
      : ['🟢 Online', COLORS.green];
  const fields = [
    ...(s.online
      ? [
          { name: 'TPS', value: s.tps === null ? 'n/a' : s.tps.toFixed(1), inline: true },
          { name: 'Players', value: String(s.players.length), inline: true },
        ]
      : []),
    { name: 'Uptime 24 h', value: pct(day), inline: true },
    { name: 'Uptime 7 d', value: pct(week), inline: true },
  ];
  if (s.online && s.players.length) fields.push({ name: 'Online now', value: truncate(s.players.map(md).join(', '), FIELD), inline: false });
  return embed({ title: title(`${s.name} — ${state}`), color, fields });
}

export function formatPlayers(players: string[]): Post {
  if (!players.length) return embed({ title: 'Nobody online', color: COLORS.blue });
  return embed({
    title: `Online (${players.length})`,
    description: truncate(players.map(md).join(', '), DESCRIPTION),
    color: COLORS.blue,
  });
}

/** Command output as a code block that always fits in one Discord message. */
export function formatOutput(lines: string[]): string {
  const max = 1900;
  let text = stripCodes(lines.join('\n')).replaceAll('```', "'''") || '(no output)';
  if (text.length > max) text = truncate(text, max) + '\n… (truncated)';
  return '```\n' + text + '\n```';
}

export function formatLastSeen(seen: { online: true } | number | null, now: number): string {
  if (seen === null) return 'never';
  if (typeof seen === 'object') return 'online now';
  return `${formatDuration(now - seen)} ago`;
}

export function formatPlaytime(player: string, totalMs: number, weekMs: number, seen: { online: true } | number | null, now: number): Post {
  return embed({
    title: 'Playtime',
    color: COLORS.blue,
    fields: [
      { name: 'Player', value: md(player), inline: false },
      { name: 'Total', value: formatDuration(totalMs), inline: true },
      { name: 'Last 7 days', value: formatDuration(weekMs), inline: true },
      { name: 'Last seen', value: formatLastSeen(seen, now), inline: true },
    ],
  });
}

export const TOP_PERIODS = { day: 'last 24 hours', week: 'last 7 days', all: 'all time' } as const;

export function formatTop(period: keyof typeof TOP_PERIODS, rows: { player: string; ms: number }[]): Post {
  const lines = rows.map((r, i) => `${i + 1}. **${md(r.player)}**: ${formatDuration(r.ms)}`);
  return embed({
    title: `Top players (${TOP_PERIODS[period]})`,
    description: truncate(lines.join('\n'), DESCRIPTION) || 'No playtime recorded.',
    color: COLORS.blue,
  });
}

const totalSize = (backups: Backup[]) => formatBytes(backups.reduce((sum, b) => sum + b.size, 0));
const formatGrowth = (g: number) => `${g < 0 ? '−' : '+'}${formatBytes(Math.abs(g))}/day`;
const formatFree = (free: number | null) => (free === null ? 'n/a' : formatBytes(free));

export function formatBackupStatus(backups: Backup[], now: number, free: number | null): Post {
  const newest = backups[0];
  if (!newest) return embed({ title: 'Backups', description: 'No backups found.', color: COLORS.orange });
  const growth = growthPerDay(backups);
  return embed({
    title: 'Backups',
    color: COLORS.blue,
    fields: [
      { name: 'Newest', value: truncate(newest.name, FIELD), inline: false },
      { name: 'Age', value: `${formatDuration(now - newest.mtimeMs)}`, inline: true },
      { name: 'Size', value: formatBytes(newest.size), inline: true },
      { name: 'Count', value: String(backups.length), inline: true },
      { name: 'Total size', value: totalSize(backups), inline: true },
      { name: 'Free disk', value: formatFree(free), inline: true },
      ...(growth === null ? [] : [{ name: 'Growth', value: formatGrowth(growth), inline: true }]),
    ],
  });
}

export function formatBackupList(backups: Backup[]): Post {
  if (!backups.length) return embed({ title: 'Backups', description: 'No backups found.', color: COLORS.orange });
  const lines = backups.slice(0, 10).map((b) => `\`${b.name}\` ${formatBytes(b.size)}`);
  return embed({
    title: `Backups: ${backups.length}, ${totalSize(backups)} total`,
    description: truncate(lines.join('\n'), DESCRIPTION),
    color: COLORS.blue,
  });
}

export function formatSummary(serverName: string, s: Summary): Post {
  const top = s.top.map((p, i) => `${i + 1}. **${md(p.player)}**: ${formatDuration(p.ms)}`).join('\n') || 'Nobody played.';
  const b = s.backups;
  const backups = b && [`${b.count}`, `${formatBytes(b.total)} total`, `${formatFree(b.free)} free`, ...(b.growth === null ? [] : [formatGrowth(b.growth)])];
  return embed({
    title: title(`📊 ${serverName}: ${s.day}`),
    color: COLORS.blue,
    fields: [
      { name: 'Uptime', value: pct(s.uptime), inline: true },
      { name: 'Peak players', value: s.peak === null ? 'n/a' : String(s.peak), inline: true },
      { name: 'Unique players', value: String(s.unique), inline: true },
      { name: 'Total playtime', value: formatDuration(s.totalMs), inline: true },
      { name: 'Starts', value: String(s.starts), inline: true },
      { name: 'Crashes', value: String(s.crashes), inline: true },
      { name: 'Top players', value: truncate(top, FIELD), inline: false },
      ...(backups ? [{ name: 'Backups', value: backups.join(', '), inline: false }] : []),
    ],
  });
}

export function formatTps(
  s: ServerState,
  lastHour: { ts: number; tps: number }[],
  hour: { avg: number; min: number } | null,
  day: { avg: number; min: number } | null,
): Post {
  if (!s.online || s.tps === null) return embed({ title: title(`${s.name}: offline`), color: COLORS.red });
  const color = s.tps >= 18 ? COLORS.green : s.tps >= 12 ? COLORS.orange : COLORS.red;
  const stat = (x: { avg: number; min: number } | null, withMin: boolean) =>
    x === null ? 'n/a' : withMin ? `${x.avg.toFixed(1)} (min ${x.min.toFixed(1)})` : x.avg.toFixed(1);
  const fields = [
    { name: 'Last hour', value: stat(hour, true), inline: true },
    { name: 'Last 24 h', value: stat(day, false), inline: true },
  ];
  if (lastHour.length) fields.push({ name: 'Trend (1 sample/min)', value: sparkline(lastHour.slice(-60).map((x) => x.tps)), inline: false });
  if (s.dims.length) {
    const dims = s.dims.map((d) => `${md(d.name)} (DIM ${d.id}): ${Math.round(d.ms)} ms/tick`).join('\n');
    fields.push({ name: 'Slowest dimensions', value: truncate(dims, FIELD), inline: false });
  }
  return embed({ title: title(`${s.name}: ${s.tps.toFixed(1)} TPS`), color, fields });
}

/** A quest post: the quests completed at once, or a batched roll-up (`count` > quests shown). */
export function formatQuests(b: Omit<Extract<Announcement, { type: 'questBatch' }>, 'type'>): Post {
  const who = `📜 **${md(b.player)}** completed`;
  if (b.count > b.quests.length) return { content: `${who} ${b.count} quests (latest: **${md(b.quests[0].name)}**)` };
  const names = b.quests.slice(0, 5).map((q) => `**${md(q.name)}**`);
  const more = b.quests.length > 5 ? ` and ${b.quests.length - 5} more` : '';
  return { content: truncate(`${who} ${names.join(', ')}${more}`, 2000) };
}

/** The mention renders as a name but doesn't ping (allowedMentions is off for everything the bot posts). */
export function formatLinked(player: string, discordId: string): Post {
  return { content: `🔗 **${md(player)}** linked to <@${discordId}>` };
}

/** The bot's custom status: one segment per server, e.g. "GTNH: 3 online · 20 TPS". */
export function formatPresence(states: ServerState[]): string {
  const part = (s: ServerState) => {
    if (!s.online) return `${stripCodes(s.name)}: offline`;
    if (s.hung) return `${stripCodes(s.name)}: not responding`;
    return `${stripCodes(s.name)}: ${s.players.length} online${s.tps === null ? '' : ` · ${Math.round(s.tps)} TPS`}`;
  };
  return truncate(states.map(part).join(' | '), 128);
}

/** A channel topic for one server. TPS is rounded so the text (and the rate-limited edit) changes less often. */
export function formatTopic(s: ServerState): string {
  if (!s.online) return '🔴 Offline';
  if (s.hung) return '🟠 Not responding';
  const tps = s.tps === null ? '' : ` · ${Math.round(s.tps)} TPS`;
  const n = s.players.length;
  const who = n ? `: ${s.players.join(', ')}` : '';
  return truncate(`🟢 Online${tps} · ${n} player${n === 1 ? '' : 's'}${who}`, 1024);
}

export type TopicEdit = { text: string; at: number };
/** Discord allows 2 topic edits per channel per 10 minutes. */
export const TOPIC_MIN_GAP_MS = 5 * 60_000;

/** Whether a channel topic should be edited to `text` now, given the last edit. */
export function topicDue(last: TopicEdit | undefined, text: string, now: number): boolean {
  return !last || (last.text !== text && now - last.at >= TOPIC_MIN_GAP_MS);
}

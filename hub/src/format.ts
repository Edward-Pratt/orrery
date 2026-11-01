import { escapeMarkdown, type APIEmbed } from 'discord.js';
import { growthPerDay, type Backup } from './backups.ts';
import { GAMES, rateOf, sparkline } from './lag.ts';
import { countdownText } from './restarts.ts';
import {
  stripCodes,
  truncate,
  type Announcement,
  type GameMsg,
  type HubEvent,
  type Notice,
  type ServerState,
  type Severity,
  type TargetEvent,
} from './servers.ts';
import type { Game } from './types.ts';
import type { Summary } from './summary.ts';
import { formatBytes, formatDuration } from './units.ts';

/** What the bot posts: plain text (chat-like messages) or an embed (everything else). */
export type Post = { content: string } | { embeds: APIEmbed[] };

export const COLORS = { green: 0x2ecc71, grey: 0x95a5a6, red: 0xe74c3c, orange: 0xe67e22, blue: 0x3498db } as const;

// Discord limits: a message's content, an embed's parts.
const CONTENT = 2000;
const TITLE = 256;
const FIELD = 1024;
const DESCRIPTION = 4096;

/** Escapes Minecraft text for Discord: no § codes, no markdown, headings, lists or masked links. */
export function md(s: string): string {
  return escapeMarkdown(stripCodes(s), { heading: true, maskedLink: true, bulletedList: true, numberedList: true });
}

/**
 * Escapes text that goes mid-line or in an embed title (a notice's detail, a save's name, a version, an error): every
 * inline markdown and masked links, but not the line-start rules (headings, lists), which there would only put a
 * backslash before a backup's "12.3 seconds".
 */
export function inline(s: string): string {
  return escapeMarkdown(stripCodes(s), { maskedLink: true });
}

/** Embed titles render less markdown than descriptions, so they only get § codes stripped. */
function title(s: string): string {
  return truncate(stripCodes(s), TITLE);
}

const embed = (e: APIEmbed): Post => ({ embeds: [e] });
/** A plain-text post, cut to Discord's 2000 characters after escaping (escaping can double a 1 KiB message). */
const plain = (s: string): Post => ({ content: truncate(s, CONTENT) });

/** A chat line as the relay webhook posts it (the name is the webhook's own): escaped, then cut to Discord's 2000. */
export function chatContent(message: string): string {
  return truncate(md(message), CONTENT);
}

/** The most of a milestone's text a post shows (the subject only: a research, a planet, a platform's name). */
const MILESTONE_TEXT = 200;

/** A milestone's line: the mod sends its subject (`text`), the player for a landing, and a force other than `player`. */
function milestoneText(m: Extract<GameMsg, { type: 'milestone' }>): string {
  const what = md(truncate(m.text, MILESTONE_TEXT));
  const force = m.force ? ` (${md(m.force)})` : '';
  switch (m.kind) {
    case 'research':
      return `🔬 Research finished: **${what}**${force}`;
    case 'rocket': // the planet it left, empty if unknown
      return `🚀 First rocket launched${what ? ` from **${what}**` : ''}${force}`;
    case 'platform':
      return `🛰️ First space platform in orbit: **${what}**${force}`;
    case 'landing':
      return `🪐 First landing on **${what}**${m.player ? ` by **${md(m.player)}**` : ''}${force}`;
  }
}

/** What `/link` answers: how to type the code in each game that has a server. */
export function formatLinkHint(code: string, games: Game[]): string {
  const how: Record<Game, string> = {
    minecraft: `In Minecraft, type \`/discord link ${code}\``,
    factorio: `In Factorio, type \`/orrery-link ${code}\``,
  };
  const lines = GAMES.filter((g) => games.includes(g)).map((g) => how[g]);
  if (lines.length > 1) return `${lines.map((l) => `${l}.`).join(' ')} The code works for 10 minutes.`;
  return `${lines[0] ?? how.minecraft} within 10 minutes.`; // no servers at all: Minecraft's, as before Factorio
}

const SEVERITY_COLORS: Record<Severity, number> = { problem: COLORS.red, warning: COLORS.orange, good: COLORS.green, info: COLORS.blue };

/** A countdown's words: a restart's, or a stop's (of a server's service). */
const COUNTDOWN = { restart: { in: '🔄 Restart in', now: '🔄 Restarting now' }, stop: { in: '🛑 Stop in', now: '🛑 Stopping now' } };

/** A notice's title; null for one that isn't posted. A factorio server's updates are game updates (it has no pack). */
function noticeText(n: Notice, game: Game): string | null {
  if (game === 'factorio' && (n.kind === 'packUpdateStarted' || n.kind === 'packUpdateFinished')) return gameUpdateText(n);
  switch (n.kind) {
    case 'restartScheduled':
      return `${COUNTDOWN[n.stop ? 'stop' : 'restart'].in} ${countdownText(n.ms)} (by ${n.by})`;
    case 'restartNow':
      return COUNTDOWN[n.stop ? 'stop' : 'restart'].now;
    case 'restartCancelled':
      return `❎ Restart cancelled (by ${n.by})`;
    case 'restartCancelledDown':
      return '❎ Restart cancelled (server went down)';
    case 'restartFailed':
      return `❌ Restart failed: ${inline(n.error)}`; // a factorio server's: its Agent's refusal
    case 'lag': {
      // Only Minecraft has dimensions to name (Factorio's rate is UPS); an older Mod sends none.
      if (n.label === 'UPS') return `🐢 Lag: ${n.tps.toFixed(1)} ${n.label}`;
      const where = n.worst ? `${n.worst.name} (DIM ${n.worst.id}) ${Math.round(n.worst.ms)} ms/tick` : 'unknown';
      return `🐢 Lag: ${n.tps.toFixed(1)} ${n.label}; slowest: ${where}`;
    }
    case 'lagRecovered':
      return `✅ ${n.label} back to normal (${n.tps.toFixed(1)})`;
    case 'backupOverdue':
      return `⚠️ No new backup for ${n.hours} h (newest: ${inline(n.newest)})`;
    case 'backupsMissing':
      return '⚠️ No backups found';
    case 'lowDisk':
      return `⚠️ Low disk space for backups: ${formatBytes(n.free)} free (limit ${n.minFreeGB} GB)`;
    case 'backupFinished':
      return `✅ Backup finished (${inline(n.detail)})`; // an Agent's detail is its own text
    case 'backupFailed':
      return `❌ Backup failed: ${inline(n.detail)}`;
    case 'packUpdateStarted':
      return n.from === n.to ? `📦 Applying pack changes to ${n.to} (by ${n.by})` : `📦 Updating the pack: ${n.from} → ${n.to} (by ${n.by})`;
    case 'packUpdateStep': // progress for the dashboard
      return null;
    case 'packUpdateFinished':
      switch (n.outcome) {
        case 'ok':
          return n.from === n.to ? `✅ Pack changes applied to ${n.to} (${formatDuration(n.ms)})` : `✅ Pack updated to ${n.to} (${formatDuration(n.ms)})`;
        case 'rolled back':
          return `❌ Pack update to ${n.to} rolled back: ${n.from} is running again.${n.backup ? ` Pre-update backup: ${n.backup}` : ''}`;
        case 'failed':
          return `❌ Pack update to ${n.to} failed: the server didn't come back, even after a rollback`;
        case 'failed before swap':
          return `❌ Pack update to ${n.to} failed after the stop, before any file changed: ${n.from} is starting again`;
        case 'failed in staging':
          return `⚠️ Pack update to ${n.to} failed while preparing: the server wasn't touched`;
        case 'cancelled':
          return `❎ Pack update to ${n.to} cancelled: the server wasn't touched`;
      }
  }
}

/**
 * A game update's start and end. `from` names the Factorio version the Agent reported (`installed`) and the pre-update
 * save is named in the game's folder: both `inline()`, as they go mid-line in the embed title. `to` is the version the
 * admin picked, checked as `X.Y.Z`.
 */
function gameUpdateText(n: Extract<Notice, { kind: 'packUpdateStarted' | 'packUpdateFinished' }>): string {
  const from = inline(n.from);
  if (n.kind === 'packUpdateStarted') return `📦 Updating the game: ${from} → ${n.to} (by ${n.by})`;
  switch (n.outcome) {
    case 'ok':
      return `✅ Game updated to ${n.to} (${formatDuration(n.ms)})`;
    case 'rolled back':
      return `❌ Game update to ${n.to} rolled back: ${from} is running again.${n.backup ? ` Pre-update save: ${inline(n.backup)}` : ''}`;
    case 'failed':
      return `❌ Game update to ${n.to} failed: the server didn't come back, even after a rollback`;
    case 'failed before swap':
      return `❌ Game update to ${n.to} failed after the stop, before anything changed: ${from} is starting again`;
    case 'failed in staging':
      return `⚠️ Game update to ${n.to} failed while preparing: the server wasn't touched`;
    case 'cancelled':
      return `❎ Game update to ${n.to} cancelled before the swap: nothing was changed`;
  }
}

/** The Discord post for a hub event, or null for events that aren't announced. `game`: the server's (it words updates). */
export function formatEvent(e: HubEvent, game: Game = 'minecraft'): Post | null {
  switch (e.type) {
    case 'chat':
      return plain(`**${md(e.player)}**: ${md(e.message)}`);
    case 'say': // chat sent into the game: Discord's own came from its channel
      return e.source === 'dashboard' ? plain(`**${md(e.author)}** (dashboard): ${md(e.message)}`) : null;
    case 'join':
      return plain(`➡️ **${md(e.player)}** joined`);
    case 'leave':
      return plain(`⬅️ **${md(e.player)}** left`);
    case 'death':
      return plain(`💀 ${md(e.message)}`);
    case 'achievement':
      return plain(`🏆 **${md(e.player)}** earned **${md(e.achievement)}**`);
    case 'milestone':
      return plain(milestoneText(e));
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
    case 'notice': {
      const text = noticeText(e, game);
      return text === null ? null : embed({ title: title(text), color: SEVERITY_COLORS[e.severity] });
    }
    case 'questBatch':
      return formatQuests(e);
    case 'linked':
      return formatLinked(e.player, e.discordId);
    case 'summary':
      return formatSummary(e.name, e.summary);
    case 'connected': // may just be a reconnect after a hub restart
    case 'offline': // hub-start bookkeeping for uptime, not news
    case 'lost': // its Agent left: a planned exit is not news, and a lost Agent is a host notice
    case 'quest': // the QuestAnnouncer turns it into questBatch announcements
    case 'link': // answered by Links, which announces a new link
    case 'unlink':
    case 'backup': // the BackupWatcher publishes it as a notice
    case 'console': // the /cmd reply shows it to whoever ran it
    case 'tps': // for the dashboard; /tps and lag notices cover Discord
    case 'paused': // for the dashboard's card
      return null;
  }
}

function targetText(e: Extract<TargetEvent, { type: 'notice' }>): string {
  switch (e.kind) {
    case 'checkDown':
      return `❌ Check ${e.id} is down: ${e.error}`;
    case 'checkUp':
      return `✅ Check ${e.id} is back up (${e.ms} ms)`;
    case 'memoryHigh':
      return `⚠️ Host ${e.id}: memory at ${e.percent}% for ${e.minutes} min`;
    case 'memoryOk':
      return `✅ Host ${e.id}: memory back to ${e.percent}%`;
    case 'diskLow':
      return `⚠️ Host ${e.id}: low disk on ${inline(e.mount)}: ${formatBytes(e.free)} free (limit ${e.minFreeGB} GB)`; // an Agent's sample names it
    case 'diskOk':
      return `✅ Host ${e.id}: disk on ${inline(e.mount)} back to ${formatBytes(e.free)} free`;
    case 'serviceFailed':
      return `❌ Service ${e.id} failed (${e.unit})`;
    case 'agentLost':
      return `⚠️ Host ${e.id}: agent ${e.name} is not connected`;
    case 'agentBack':
      return `✅ Host ${e.id}: agent ${e.name} is connected again`;
    case 'eventsOff': // the Agent's words
      return `⚠️ Host ${e.id}: game events from agent ${e.name} are off: ${inline(e.reason)}`;
    case 'eventsOn':
      return `✅ Host ${e.id}: game events from agent ${e.name} are on again`;
    // `from` is what the part said it runs (a Mod's or an Agent's hello): escaped. `to` is a tag GitHub listed.
    case 'deployStarted':
      return `🚀 Deploying ${deployed(e)}: ${e.from === null ? 'unknown' : inline(e.from)} → ${e.to} (by ${e.by})`;
    case 'deployFinished':
      if (e.outcome === 'ok') return `✅ Deployed ${deployed(e)}: ${e.to}`;
      if (e.outcome === 'rolled back') return `❌ Deploying ${deployed(e)} ${e.to} failed: rolled back to ${e.from === null ? 'the previous release' : inline(e.from)}`;
      return `❌ Deploying ${deployed(e)} ${e.to} failed`;
  }
}

/** What a deploy was of, and where: "the hub on production", "the Mod on gtnh", "the agent on factorio-vm". */
const deployed = (e: { part: string; id: string }) => `${{ hub: 'the hub', web: 'the dashboard', mod: 'the Mod', agent: 'the agent' }[e.part]} on ${e.id}`;

/**
 * The alerts channel's post for an event about the host, a service or a check, naming what it is about (the channel
 * is shared); null for events that aren't announced.
 */
export function formatTargetEvent(e: TargetEvent): Post | null {
  if (e.type !== 'notice') return null; // samples and service states are for the dashboard
  const url = 'url' in e ? { description: truncate(e.url, DESCRIPTION) } : {};
  return embed({ title: title(targetText(e)), ...url, color: SEVERITY_COLORS[e.severity] });
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
          { name: rateOf(s.game).label, value: s.tps === null ? 'n/a' : s.tps.toFixed(1), inline: true },
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
      { name: 'Newest', value: truncate(md(newest.name), FIELD), inline: false },
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
  // A name (an Agent's save's comes from the game's folder) can't end its code span early.
  const lines = backups.slice(0, 10).map((b) => `\`${b.name.replaceAll('`', "'")}\` ${formatBytes(b.size)}`);
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
  const { label, max } = rateOf(s.game);
  // Bands as a share of full speed: 18 and 12 TPS of Minecraft's 20.
  const color = s.tps >= 0.9 * max ? COLORS.green : s.tps >= 0.6 * max ? COLORS.orange : COLORS.red;
  const stat = (x: { avg: number; min: number } | null, withMin: boolean) =>
    x === null ? 'n/a' : withMin ? `${x.avg.toFixed(1)} (min ${x.min.toFixed(1)})` : x.avg.toFixed(1);
  const fields = [
    { name: 'Last hour', value: stat(hour, true), inline: true },
    { name: 'Last 24 h', value: stat(day, false), inline: true },
  ];
  if (lastHour.length) fields.push({ name: 'Trend (1 sample/min)', value: sparkline(lastHour.slice(-60).map((x) => x.tps), max), inline: false });
  if (s.dims.length) {
    const dims = s.dims.map((d) => `${md(d.name)} (DIM ${d.id}): ${Math.round(d.ms)} ms/tick`).join('\n');
    fields.push({ name: 'Slowest dimensions', value: truncate(dims, FIELD), inline: false });
  }
  return embed({ title: title(`${s.name}: ${s.tps.toFixed(1)} ${label}`), color, fields });
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

/** The bot's custom status: one segment per server, e.g. "GTNH: 3 online · 20 TPS" (UPS for a factorio server). */
export function formatPresence(states: ServerState[]): string {
  const part = (s: ServerState) => {
    if (!s.online) return `${stripCodes(s.name)}: offline`;
    if (s.hung) return `${stripCodes(s.name)}: not responding`;
    return `${stripCodes(s.name)}: ${s.players.length} online${s.tps === null ? '' : ` · ${Math.round(s.tps)} ${rateOf(s.game).label}`}`;
  };
  return truncate(states.map(part).join(' | '), 128);
}

/** A channel topic for one server. Its rate is rounded so the text (and the rate-limited edit) changes less often. */
export function formatTopic(s: ServerState): string {
  if (!s.online) return '🔴 Offline';
  if (s.hung) return '🟠 Not responding';
  const tps = s.tps === null ? '' : ` · ${Math.round(s.tps)} ${rateOf(s.game).label}`;
  const n = s.players.length;
  const who = n ? `: ${s.players.map(md).join(', ')}` : ''; // a topic renders markdown too
  return truncate(`🟢 Online${tps} · ${n} player${n === 1 ? '' : 's'}${who}`, 1024);
}

export type TopicEdit = { text: string; at: number };
/** Discord allows 2 topic edits per channel per 10 minutes. */
export const TOPIC_MIN_GAP_MS = 5 * 60_000;

/** Whether a channel topic should be edited to `text` now, given the last edit. */
export function topicDue(last: TopicEdit | undefined, text: string, now: number): boolean {
  return !last || (last.text !== text && now - last.at >= TOPIC_MIN_GAP_MS);
}

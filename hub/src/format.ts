import { escapeMarkdown } from 'discord.js';
import { stripCodes, truncate, type HubEvent, type ServerState } from './servers.ts';

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
  if (text.length > max) text = truncate(text, max) + '\n… (truncated)';
  return '```\n' + text + '\n```';
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

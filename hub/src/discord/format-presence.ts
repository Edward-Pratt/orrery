// The bot's custom status (`formatPresence`: one segment per server) and each server's channel topic (`formatTopic`,
// its players through `md()`, as a topic renders markdown; `topicDue` keeps the edits within Discord's limit).

import { rateOf } from '../servers/lag.ts';
import { stripCodes, truncate, type ServerState } from '../servers/servers.ts';
import { md } from './format-text.ts';

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

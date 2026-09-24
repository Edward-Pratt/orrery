import type { Db } from './db.ts';
import { localDay } from './units.ts';

export type Summary = {
  day: string;
  uptime: number | null;
  peak: number | null;
  unique: number;
  totalMs: number;
  top: { player: string; ms: number }[];
  starts: number;
  crashes: number;
};

/** The local calendar day before `at`, midnight to midnight (23 or 25 h long on DST days). */
export function yesterday(at: number): { from: number; to: number; day: string } {
  const to = new Date(at);
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - 1);
  return { from: from.getTime(), to: to.getTime(), day: localDay(from.getTime()) };
}

/** Stats for the day before `at` (the summary's scheduled time, not Date.now()). */
export function buildSummary(db: Db, serverId: string, at: number): Summary {
  const { from, to, day } = yesterday(at);
  const players = db.top(serverId, from, to, 1_000_000);
  return {
    day,
    uptime: db.uptime(serverId, from, to),
    peak: db.peak(serverId, day),
    unique: players.length,
    totalMs: players.reduce((sum, p) => sum + p.ms, 0),
    top: players.slice(0, 3),
    starts: db.countEvents(serverId, 'started', from, to),
    crashes: db.countEvents(serverId, 'crashed', from, to),
  };
}

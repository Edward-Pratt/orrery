import type { BackupStats } from './backups.ts';
import { localDay } from './units.ts';

/** The daily summary, as `Stats.summary` answers it. */
export type Summary = {
  day: string;
  uptime: number | null;
  peak: number | null;
  unique: number;
  totalMs: number;
  top: { player: string; ms: number }[];
  starts: number;
  crashes: number;
  /** Only for servers with a Backup folder. */
  backups?: BackupStats;
};

/** The local calendar day before `at`, midnight to midnight (23 or 25 h long on DST days). */
export function yesterday(at: number): { from: number; to: number; day: string } {
  const to = new Date(at);
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - 1);
  return { from: from.getTime(), to: to.getTime(), day: localDay(from.getTime()) };
}

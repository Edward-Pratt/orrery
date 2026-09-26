import { everyDay } from './daily.ts';
import type { ServerHub } from './servers.ts';
import type { Stats } from './stats.ts';
import { localDay } from './units.ts';
export type { Summary } from './types.ts';


/** The local calendar day before `at`, midnight to midnight (23 or 25 h long on DST days). */
export function yesterday(at: number): { from: number; to: number; day: string } {
  const to = new Date(at);
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - 1);
  return { from: from.getTime(), to: to.getTime(), day: localDay(from.getTime()) };
}

/**
 * Arms each server's daily summary: at its `dailySummary` time, `Stats.summary` is announced on the hub's event
 * stream. Returns a cancel for all of them. Throws on a bad time.
 */
export function scheduleSummaries(
  hub: Pick<ServerHub, 'announce'>,
  stats: Pick<Stats, 'summary'>,
  servers: { id: string; name: string; dailySummary?: string }[],
): () => void {
  const cancels = servers.flatMap((s) =>
    s.dailySummary
      ? [
          everyDay(s.dailySummary, 0, (target) => {
            stats
              .summary(s.id, target)
              .then((summary) => summary && hub.announce(s.id, { type: 'summary', name: s.name, summary }))
              .catch((err) => console.error(`[summary] ${s.id} failed:`, err));
          }),
        ]
      : [],
  );
  return () => {
    for (const cancel of cancels) cancel();
  };
}

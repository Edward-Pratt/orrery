// A server's lifecycle events onto the `event` stream (`emitLifecycle`), through a factorio server's lifecycle budget:
// at most 20 an hour, in bursts of 20, kept across connections: one over it is not emitted at all, so the uptime log,
// the stream and Discord alike miss it, the drops logged at most once a minute with a count, and the latest dropped
// one is emitted when the next token comes, within 3 min, unless a later one went out first; a Mod's server has no
// such budget. The budgets are `ServerHub`'s (`ServerCtx.lifecycle`, by server id). Hub core.

import type { Lifecycle } from '../types.ts';
import type { ServerCtx } from './server-ctx.ts';

/**
 * A factorio server's lifecycle events, its connections and reconnects together (docs/protocol.md, "Rate rules"): 20 an
 * hour, in bursts of 20. Each is a row of the never-pruned uptime log, a stream event and maybe a Discord post, so an
 * Agent's token holder churning connections must not add them without end.
 */
const LIFECYCLE = { perHour: 20, burst: 20 };
const HOUR_MS = 3_600_000;
const LOG_MS = 60_000;

/**
 * A factorio server's lifecycle budget: a token bucket (a clock stepping back adds none), the latest event dropped
 * over it (put through when the next token comes), and the drops since the last log line.
 */
export type LifecycleBudget = { tokens: number; last: number; pending: Lifecycle | null; timer?: NodeJS.Timeout; dropped: number; loggedAt: number };

export function emitLifecycle(c: ServerCtx, serverId: string, type: Lifecycle): void {
  if (c.configs.get(serverId)?.game === 'factorio' && !lifecycleFits(c, serverId, type)) return;
  c.emit({ serverId, type });
}

/**
 * Whether a factorio server's lifecycle event fits its budget (`LIFECYCLE`) now. One that doesn't is dropped, for
 * the uptime log, the stream and Discord alike, and kept as the latest: when the next token comes it goes out then
 * (unless a later event went out first), so the recorded state is never wrong for longer than one token (3 min).
 * `get` and `downs` are right all along; what follows the stream is not until then: the dashboard's card and its
 * latest rate (`LiveFeed`). A restart countdown is cancelled anyway: `RestartScheduler` checks `downs` too.
 */
function lifecycleFits(c: ServerCtx, serverId: string, type: Lifecycle): boolean {
  const now = Date.now();
  let b = c.lifecycle.get(serverId);
  if (!b) c.lifecycle.set(serverId, (b = { tokens: LIFECYCLE.burst, last: now, pending: null, dropped: 0, loggedAt: -Infinity }));
  b.tokens = Math.min(LIFECYCLE.burst, b.tokens + (Math.max(0, now - b.last) * LIFECYCLE.perHour) / HOUR_MS);
  b.last = now;
  // A hair under 1 is float rounding when the timer below fires: a whole token, so its replay is never a drop.
  if (b.tokens >= 1 - 1e-9) {
    b.tokens -= 1;
    b.pending = null; // a later event went out: the dropped one is stale
    return true;
  }
  b.pending = type;
  b.dropped++;
  if (now < b.loggedAt || now - b.loggedAt >= LOG_MS) {
    console.error(`[hub] ${serverId}: over ${LIFECYCLE.perHour} lifecycle events an hour, dropped ${b.dropped}`);
    b.loggedAt = now;
    b.dropped = 0;
  }
  if (!b.timer) {
    const budget = b;
    budget.timer = setTimeout(
      () => {
        budget.timer = undefined;
        const latest = budget.pending;
        budget.pending = null;
        if (latest && !c.closing) emitLifecycle(c, serverId, latest); // through the budget again: rounding may re-arm it
      },
      Math.ceil(((1 - b.tokens) * HOUR_MS) / LIFECYCLE.perHour),
    );
  }
  return false;
}

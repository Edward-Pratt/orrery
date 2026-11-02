// `LagMonitor`: 1/min TPS samples into the `tps` table, lag and recovery notices with the rate's label (a paused
// server is skipped: no row, no notice, its lag state kept) (`isLagging` is the server card's `lagging`);
// `sparkline`; `GAMES` and `rateOf(game)`, a game's rate (`TPS` out of 20, `UPS` out of 60): the one place it is
// decided, used by config, Discord output and the server card's `rate`. Hub core.

import type { Db } from './db.ts';
import type { ServerHub } from './servers.ts';
import type { Game, Rate } from './types.ts';

export type LagConfig = { tps: number; minutes: number; enabled: boolean };

export const GAMES = ['minecraft', 'factorio'] as const satisfies readonly Game[];
const RATES: Record<Game, Rate> = { minecraft: { label: 'TPS', max: 20 }, factorio: { label: 'UPS', max: 60 } };

/** A game's rate: what its speed is called and its full speed. The one place these live. */
export function rateOf(game: Game): Rate {
  return RATES[game];
}

const BARS = '▁▂▃▄▅▆▇█';

/** One bar per value, scaled 0..max (the game's full speed). */
export function sparkline(values: number[], max: number): string {
  return values.map((v) => BARS[Math.min(7, Math.max(0, Math.floor((v / max) * 8)))]).join('');
}

/**
 * Samples each server's TPS once a minute into the `tps` table and alerts when it stays low. Lag is only judged
 * while a server is online and responding: crashes and hangs have their own alerts. A paused server (a factorio one
 * with nobody on, or an admin's pause) is skipped altogether: neither sampled nor judged, its lag state kept for when
 * it runs again. Hub core (notices go on the hub's event stream).
 */
export class LagMonitor {
  #hub: Pick<ServerHub, 'list' | 'publish'>;
  #db: Db;
  #configs: Record<string, LagConfig>;
  #low = new Map<string, number>(); // serverId -> consecutive low samples
  #lagging = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(hub: Pick<ServerHub, 'list' | 'publish'>, db: Db, configs: Record<string, LagConfig>) {
    this.#hub = hub;
    this.#db = db;
    this.#configs = configs;
  }

  start(intervalMs = 60_000): void {
    this.#timer = setInterval(() => this.sample(Date.now()), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  /** Whether the server is in a lag alert now: the state Discord's lag notice and its recovery follow. */
  isLagging(serverId: string): boolean {
    return this.#lagging.has(serverId);
  }

  sample(now: number): void {
    for (const s of this.#hub.list()) {
      if (s.paused) continue;
      if (!s.online || s.hung || s.tps === null) {
        this.#low.delete(s.id);
        this.#lagging.delete(s.id); // the crash/hang alert covers it; no "back to normal" later
        continue;
      }
      const worst = s.dims[0];
      this.#db.recordTps(s.id, now, s.tps, worst?.name ?? null, worst?.ms ?? null);
      const cfg = this.#configs[s.id];
      if (!cfg.enabled) continue;
      if (s.tps < cfg.tps) {
        const low = (this.#low.get(s.id) ?? 0) + 1;
        this.#low.set(s.id, low);
        if (low >= cfg.minutes && !this.#lagging.has(s.id)) {
          this.#lagging.add(s.id);
          this.#hub.publish(s.id, { severity: 'warning', kind: 'lag', tps: s.tps, label: rateOf(s.game).label, worst: worst ?? null });
        }
      } else {
        this.#low.delete(s.id);
        if (this.#lagging.delete(s.id)) this.#hub.publish(s.id, { severity: 'good', kind: 'lagRecovered', tps: s.tps, label: rateOf(s.game).label });
      }
    }
  }
}

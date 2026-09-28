import type { Db } from './db.ts';
import type { ServerHub } from './servers.ts';

export type LagConfig = { tps: number; minutes: number; enabled: boolean };

const BARS = '▁▂▃▄▅▆▇█';

/** One bar per value, scaled 0..max (20 TPS). */
export function sparkline(values: number[], max = 20): string {
  return values.map((v) => BARS[Math.min(7, Math.max(0, Math.floor((v / max) * 8)))]).join('');
}

/**
 * Samples each server's TPS once a minute into the `tps` table and alerts when it stays low. Lag is only judged
 * while a server is online and responding: crashes and hangs have their own alerts. Hub core (notices go on the hub's
 * event stream).
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
          this.#hub.publish(s.id, { severity: 'warning', kind: 'lag', tps: s.tps, worst: worst ?? null });
        }
      } else {
        this.#low.delete(s.id);
        if (this.#lagging.delete(s.id)) this.#hub.publish(s.id, { severity: 'good', kind: 'lagRecovered', tps: s.tps });
      }
    }
  }
}

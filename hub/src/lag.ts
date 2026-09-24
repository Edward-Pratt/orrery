import type { Db } from './db.ts';
import type { ServerHub } from './servers.ts';

export type LagConfig = { tps: number; minutes: number; enabled: boolean };
export const DEFAULT_LAG: LagConfig = { tps: 15, minutes: 2, enabled: true };

const BARS = '▁▂▃▄▅▆▇█';

/** One bar per value, scaled 0..max (20 TPS). */
export function sparkline(values: number[], max = 20): string {
  return values.map((v) => BARS[Math.min(7, Math.max(0, Math.floor((v / max) * 8)))]).join('');
}

/**
 * Samples each server's TPS once a minute into the `tps` table and alerts when it stays low. Lag is only judged
 * while a server is online and responding: crashes and hangs have their own alerts. Hub core (plain-text notices).
 */
export class LagMonitor {
  #hub: Pick<ServerHub, 'list'>;
  #db: Db;
  #configs: Record<string, LagConfig>;
  #notify: (serverId: string, text: string) => void;
  #low = new Map<string, number>(); // serverId -> consecutive low samples
  #lagging = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(hub: Pick<ServerHub, 'list'>, db: Db, configs: Record<string, LagConfig>, notify: (serverId: string, text: string) => void) {
    this.#hub = hub;
    this.#db = db;
    this.#configs = configs;
    this.#notify = notify;
  }

  start(intervalMs = 60_000): void {
    this.#timer = setInterval(() => this.sample(Date.now()), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
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
      const cfg = this.#configs[s.id] ?? DEFAULT_LAG;
      if (!cfg.enabled) continue;
      if (s.tps < cfg.tps) {
        const low = (this.#low.get(s.id) ?? 0) + 1;
        this.#low.set(s.id, low);
        if (low >= cfg.minutes && !this.#lagging.has(s.id)) {
          this.#lagging.add(s.id);
          const where = worst ? `${worst.name} (DIM ${worst.id}) ${Math.round(worst.ms)} ms/tick` : 'unknown';
          this.#notify(s.id, `🐢 Lag: ${s.tps.toFixed(1)} TPS; slowest: ${where}`);
        }
      } else {
        this.#low.delete(s.id);
        if (this.#lagging.delete(s.id)) this.#notify(s.id, `✅ TPS back to normal (${s.tps.toFixed(1)})`);
      }
    }
  }
}

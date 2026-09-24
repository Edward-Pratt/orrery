import type { Db } from './db.ts';
import type { ServerHub } from './servers.ts';
import { localDay } from './units.ts';

/**
 * Keeps the sessions table in step with each server's live player list (from heartbeats), so playtime
 * survives missed join/leave events, crashes and hub restarts. Accuracy is the poll interval.
 */
export class PlaytimeTracker {
  #hub: Pick<ServerHub, 'list'>;
  #db: Db;
  #open = new Map<string, Set<string>>(); // serverId -> players with an open session
  #timer: NodeJS.Timeout | undefined;

  constructor(hub: Pick<ServerHub, 'list'>, db: Db) {
    this.#hub = hub;
    this.#db = db;
  }

  start(intervalMs = 10_000): void {
    this.#timer = setInterval(() => this.poll(Date.now()), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  poll(now: number): void {
    for (const s of this.#hub.list()) {
      const open = this.#open.get(s.id) ?? new Set<string>();
      const online = new Set(s.online ? s.players : []);
      for (const player of online) {
        if (!open.has(player)) {
          this.#db.openSession(s.id, player, now);
          open.add(player);
        }
      }
      for (const player of open) {
        if (!online.has(player)) {
          this.#db.closeSession(s.id, player, now);
          open.delete(player);
        }
      }
      this.#open.set(s.id, open);
      if (s.online) this.#db.recordPeak(s.id, localDay(now), online.size);
    }
  }
}

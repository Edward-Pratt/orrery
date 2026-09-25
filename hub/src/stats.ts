import type { Db } from './db.ts';
import type { ServerHub, ServerState } from './servers.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

type TpsStats = { avg: number; min: number } | null;

export type StatusAnswer = { state: ServerState; uptimeDay: number | null; uptimeWeek: number | null };
export type TpsAnswer = { state: ServerState; lastHour: { ts: number; tps: number }[]; hour: TpsStats; day: TpsStats };

/**
 * Answers frontends' stats questions for one Server as plain data; owns the time windows. Hub core: frontends
 * (Discord now, the web dashboard later) format the answers. Undefined for an unknown Server.
 */
export class Stats {
  #hub: Pick<ServerHub, 'get'>;
  #db: Db;

  constructor(hub: Pick<ServerHub, 'get'>, db: Db) {
    this.#hub = hub;
    this.#db = db;
  }

  /** Live state and uptime over the last 24 h and 7 d (null where nothing is known). */
  status(serverId: string, now = Date.now()): StatusAnswer | undefined {
    const state = this.#hub.get(serverId);
    if (!state) return undefined;
    return { state, uptimeDay: this.#db.uptime(serverId, now - DAY, now), uptimeWeek: this.#db.uptime(serverId, now - 7 * DAY, now) };
  }

  /** Live state, the last hour's samples (oldest first), and average/minimum over the last hour and day. */
  tps(serverId: string, now = Date.now()): TpsAnswer | undefined {
    const state = this.#hub.get(serverId);
    if (!state) return undefined;
    return {
      state,
      lastHour: this.#db.tpsSince(serverId, now - HOUR),
      hour: this.#db.tpsStats(serverId, now - HOUR, now),
      day: this.#db.tpsStats(serverId, now - DAY, now),
    };
  }
}

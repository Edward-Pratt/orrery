import type { Db } from './db.ts';
import type { ServerHub, ServerState } from './servers.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

type TpsStats = { avg: number; min: number } | null;

export type StatusAnswer = { state: ServerState; uptimeDay: number | null; uptimeWeek: number | null };
export type TpsAnswer = { state: ServerState; lastHour: { ts: number; tps: number }[]; hour: TpsStats; day: TpsStats };
export type PlaytimeAnswer =
  | { found: true; player: string; totalMs: number; weekMs: number; lastSeen: { online: true } | number | null }
  | { found: false; reason: 'noInput' | 'notLinked' };
/** `/top` periods: the last 24 hours, the last 7 days, all time. */
export type Period = 'day' | 'week' | 'all';

const PERIOD_MS: Record<Period, number> = { day: DAY, week: 7 * DAY, all: Infinity };
const TOP_LIMIT = 10;

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

  /** A player's playtime (all time, last 7 days) and last seen, by Minecraft name or a linked Discord user. */
  playtime(serverId: string, who: { player?: string; discordId?: string }, now = Date.now()): PlaytimeAnswer | undefined {
    if (!this.#hub.get(serverId)) return undefined;
    const player = who.discordId !== undefined ? this.linkedPlayer(who.discordId) : who.player;
    if (!player) return { found: false, reason: who.discordId !== undefined ? 'notLinked' : 'noInput' };
    return {
      found: true,
      player,
      totalMs: this.#db.playtime(serverId, player, 0, now, now),
      weekMs: this.#db.playtime(serverId, player, now - 7 * DAY, now, now),
      lastSeen: this.#db.lastSeen(serverId, player),
    };
  }

  /** The 10 players with the most playtime in the period, most first. */
  top(serverId: string, period: Period, now = Date.now()): { player: string; ms: number }[] | undefined {
    if (!this.#hub.get(serverId)) return undefined;
    return this.#db.top(serverId, Math.max(0, now - PERIOD_MS[period]), now, TOP_LIMIT, now);
  }

  /** The Minecraft name linked to a Discord user, if any. */
  linkedPlayer(discordId: string): string | undefined {
    return this.#db.linkByDiscord(discordId)?.player;
  }
}

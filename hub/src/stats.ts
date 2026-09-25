import { freeBytes, listBackups, type Backup } from './backups.ts';
import type { ServerSettings } from './config.ts';
import { findCrashLogs } from './crashlogs.ts';
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
/** A Server without a Backup folder has no Backup answers at all, rather than an empty list. */
export type BackupsAnswer = { configured: false } | { configured: true; backups: Backup[]; free: number | null };
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
  #folders: Map<string, Pick<ServerSettings, 'dir' | 'backupDir'>>;

  constructor(hub: Pick<ServerHub, 'get'>, db: Db, servers: Pick<ServerSettings, 'id' | 'dir' | 'backupDir'>[]) {
    this.#hub = hub;
    this.#db = db;
    this.#folders = new Map(servers.map((s) => [s.id, s]));
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

  /** Finished Backups newest first, and free space on their disk. Never throws. */
  async backups(serverId: string): Promise<BackupsAnswer | undefined> {
    if (!this.#hub.get(serverId)) return undefined;
    const dir = this.#folders.get(serverId)?.backupDir;
    if (!dir) return { configured: false };
    return { configured: true, backups: await listBackups(dir), free: await freeBytes(dir) };
  }

  /** Crash logs written at or after `sinceMs` in the server folder (none without one). Never throws. */
  crashLogs(serverId: string, sinceMs: number): Promise<string[]> {
    const dir = this.#folders.get(serverId)?.dir;
    return dir ? findCrashLogs(dir, sinceMs) : Promise.resolve([]);
  }

  /** The Minecraft name linked to a Discord user, if any. */
  linkedPlayer(discordId: string): string | undefined {
    return this.#db.linkByDiscord(discordId)?.player;
  }
}

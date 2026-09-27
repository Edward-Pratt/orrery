import { backupStats, freeBytes, growthPerDay, listBackups } from './backups.ts';
import type { ServerSettings } from './config.ts';
import { findCrashLogs } from './crashlogs.ts';
import type { Db } from './db.ts';
import type { AuditEntry, ServerHub } from './servers.ts';
import { yesterday, type Summary } from './summary.ts';
import { bucketMs, HISTORY_POINTS } from './host.ts';
import type { BackupsAnswer, HistoryAnswer, Period, PlaytimeAnswer, StatusAnswer, TpsAnswer } from './types.ts';
export type { BackupsAnswer, HistoryAnswer, Period, PlaytimeAnswer, StatusAnswer, TpsAnswer, TpsStats } from './types.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;

const PERIOD_MS: Record<Period, number> = { day: DAY, week: 7 * DAY, all: Infinity };
const TOP_LIMIT = 10;

/**
 * Answers frontends' stats questions for one Server as plain data; owns the time windows. Hub core: frontends
 * (Discord now, the web dashboard later) format the answers. Undefined for an unknown Server.
 */
export class Stats {
  #hub: Pick<ServerHub, 'get'>;
  #db: Db;
  #folders: Map<string, Pick<ServerSettings, 'dir' | 'backupDir' | 'backupMinFreeGB'>>;

  constructor(hub: Pick<ServerHub, 'get'>, db: Db, servers: Pick<ServerSettings, 'id' | 'dir' | 'backupDir' | 'backupMinFreeGB'>[]) {
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

  /** Finished Backups newest first, free space on their disk, and growth per day. Never throws. */
  async backups(serverId: string): Promise<BackupsAnswer | undefined> {
    if (!this.#hub.get(serverId)) return undefined;
    const folders = this.#folders.get(serverId);
    const dir = folders?.backupDir;
    if (!dir) return { configured: false };
    const backups = await listBackups(dir);
    return { configured: true, backups, free: await freeBytes(dir), growth: growthPerDay(backups), minFree: folders.backupMinFreeGB * GB };
  }

  /** Crash logs written at or after `sinceMs` in the server folder (none without one). Never throws. */
  crashLogs(serverId: string, sinceMs: number): Promise<string[]> {
    const dir = this.#folders.get(serverId)?.dir;
    return dir ? findCrashLogs(dir, sinceMs) : Promise.resolve([]);
  }

  /** Stats for the day before `at` (the summary's scheduled time, not Date.now()); Backups only with a folder. */
  async summary(serverId: string, at: number): Promise<Summary | undefined> {
    if (!this.#hub.get(serverId)) return undefined;
    const { from, to, day } = yesterday(at);
    const players = this.#db.top(serverId, from, to, 1_000_000, at);
    const dir = this.#folders.get(serverId)?.backupDir;
    const backups = dir ? await backupStats(dir) : null;
    return {
      day,
      uptime: this.#db.uptime(serverId, from, to),
      peak: this.#db.peak(serverId, day),
      unique: players.length,
      totalMs: players.reduce((sum, p) => sum + p.ms, 0),
      top: players.slice(0, 3),
      starts: this.#db.countEvents(serverId, 'started', from, to),
      crashes: this.#db.countEvents(serverId, 'crashed', from, to),
      ...(backups ? { backups } : {}),
    };
  }

  /** TPS (null without it), player counts and up/down periods over the last `hours`; see `HistoryAnswer`. */
  history(serverId: string, hours: number, withTps: boolean, now = Date.now()): HistoryAnswer | undefined {
    const state = this.#hub.get(serverId);
    if (!state) return undefined;
    const from = now - hours * HOUR;
    const width = bucketMs(hours);
    const tps = !withTps
      ? null
      : width <= 60_000
        ? this.#db.tpsSince(serverId, from)
        : this.#db.tpsAveraged(serverId, from, width, HISTORY_POINTS - 1);
    // Players: those already on at `from`, then +1 at each session's start and -1 at its end, a point per change.
    const deltas = new Map<number, number>();
    let count = 0;
    for (const s of this.#db.sessionsSince(serverId, from)) {
      if (s.start <= from) count++;
      else deltas.set(s.start, (deltas.get(s.start) ?? 0) + 1);
      if (s.end !== null && s.end <= now) deltas.set(s.end, (deltas.get(s.end) ?? 0) - 1);
    }
    const players = [{ ts: from, count }];
    for (const [ts, d] of [...deltas].sort(([a], [b]) => a - b)) {
      if (d === 0) continue; // a leave and a join in the same millisecond
      players.push({ ts, count: (count += d) });
    }
    // Sessions sync every 10 s, so the end is the live count.
    players.push({ ts: now, count: state.online ? state.players.length : 0 });
    const uptime: HistoryAnswer['uptime'] = [];
    for (const r of this.#db.states(serverId, from, now)) {
      const s = r.reason === 'hung' ? 'hung' : r.state;
      if (uptime.at(-1)?.state !== s) uptime.push({ ts: r.ts, state: s });
    }
    return { tps, players, uptime };
  }

  /** The newest audit log entries, for every server or one. */
  audit(limit: number, serverId?: string): (AuditEntry & { ts: number })[] {
    return this.#db.auditLog(limit, serverId);
  }

  /** The Minecraft name linked to a Discord user, if any. */
  linkedPlayer(discordId: string): string | undefined {
    return this.#db.linkByDiscord(discordId)?.player;
  }
}

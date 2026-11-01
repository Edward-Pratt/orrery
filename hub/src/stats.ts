import type { Agents } from './agents.ts';
import { backupStats, freeBytes, growthPerDay, listBackups } from './backups.ts';
import type { ServerSettings } from './config.ts';
import { findCrashLogs } from './crashlogs.ts';
import type { AuditFilter, Db } from './db.ts';
import { listLogs, tailLog, type LogFile } from './logs.ts';
import type { ServerHub } from './servers.ts';
import { yesterday, type Summary } from './summary.ts';
import { bucketMs, HISTORY_POINTS } from './host.ts';
import type { AuditRow, Backup, BackupsAnswer, HistoryAnswer, Period, PlaytimeAnswer, StatusAnswer, TpsAnswer } from './types.ts';
export type { BackupsAnswer, HistoryAnswer, Period, PlaytimeAnswer, StatusAnswer, TpsAnswer, TpsStats } from './types.ts';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;

const PERIOD_MS: Record<Period, number> = { day: DAY, week: 7 * DAY, all: Infinity };
const TOP_LIMIT = 10;

/** Where a server's logs are read: its folder (`logs.ts`), or the files its Agent serves. */
type LogSource = { list: () => Promise<LogFile[]>; read: (name: string) => Promise<string[] | undefined> };
/**
 * Where a server's Backups are: its Backup folder (`listBackups`, `freeBytes`), or for a server an Agent runs the saves
 * it last pushed (newest first, with their kind and the current world) and the free space it reported (none known
 * before its first push: no saves, free unknown). Never rejects.
 */
export type BackupSource = { list: () => Promise<Backup[]>; free: () => Promise<number | null> };

/**
 * Answers frontends' stats questions for one Server as plain data; owns the time windows. Hub core: frontends
 * (Discord now, the web dashboard later) format the answers. Undefined for an unknown Server.
 */
export class Stats {
  #hub: Pick<ServerHub, 'get'>;
  #db: Db;
  #folders: Map<string, Pick<ServerSettings, 'dir' | 'backupDir' | 'backupMinFreeGB'>>;
  #logSources = new Map<string, LogSource>();
  #backupSources = new Map<string, BackupSource>();

  /**
   * `agents`: the Agents whose servers' logs are the files they serve and whose Backups are the saves they push (with
   * the agents integration).
   */
  constructor(
    hub: Pick<ServerHub, 'get'>,
    db: Db,
    servers: Pick<ServerSettings, 'id' | 'dir' | 'backupDir' | 'backupMinFreeGB'>[],
    agents?: Pick<Agents, 'list' | 'request' | 'on'>,
  ) {
    this.#hub = hub;
    this.#db = db;
    this.#folders = new Map(servers.map((s) => [s.id, s]));
    for (const { id, dir, backupDir } of servers) {
      if (dir) this.#logSources.set(id, { list: () => listLogs(dir), read: (name) => tailLog(dir, name) });
      if (backupDir) this.#backupSources.set(id, { list: () => listBackups(backupDir), free: () => freeBytes(backupDir) });
    }
    // Each Agent's latest `saves`, by its server; kept in memory only, as it pushes them again on connect.
    const saves = new Map<string, { backups: Backup[]; free: number }>();
    const serverOf = new Map((agents?.list() ?? []).map((a) => [a.id, a.server]));
    agents?.on('saves', (agentId, msg) => {
      const server = serverOf.get(agentId);
      if (server === undefined) return;
      const backups = msg.saves.map((s) => ({ name: s.name, size: s.size, mtimeMs: s.mtime, kind: s.kind, current: s.current }));
      saves.set(server, { backups: backups.sort((x, y) => y.mtimeMs - x.mtimeMs), free: msg.free });
    });
    for (const a of agents?.list() ?? []) {
      this.#backupSources.set(a.server, {
        list: async () => [...(saves.get(a.server)?.backups ?? [])],
        free: async () => saves.get(a.server)?.free ?? null,
      });
      const ask = agents!; // listed only with agents
      const list = async () => (await ask.request(a.id, { type: 'logs' })).files.sort((x, y) => y.modified - x.modified);
      // Only a name the Agent lists right now is asked for (it checks again).
      const read = async (name: string) =>
        (await list()).some((f) => f.name === name) ? (await ask.request(a.id, { type: 'log', name })).lines : undefined;
      this.#logSources.set(a.server, { list, read });
    }
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

  /** A player's playtime (all time, last 7 days) and last seen, by in-game name or a linked Discord user. */
  playtime(serverId: string, who: { player?: string; discordId?: string }, now = Date.now()): PlaytimeAnswer | undefined {
    if (!this.#hub.get(serverId)) return undefined;
    const player = who.discordId !== undefined ? this.linkedPlayer(serverId, who.discordId) : who.player;
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

  /** A known server's Backups: its folder's, or its Agent's saves; undefined with neither (or unknown). */
  backupSource(serverId: string): BackupSource | undefined {
    return this.#hub.get(serverId) ? this.#backupSources.get(serverId) : undefined;
  }

  /**
   * Finished Backups newest first (a factorio server's saves, each with its kind), free space on their disk, and
   * growth per day; `configured: false` with no Backup source. Never throws.
   */
  async backups(serverId: string): Promise<BackupsAnswer | undefined> {
    if (!this.#hub.get(serverId)) return undefined;
    const source = this.backupSource(serverId);
    if (!source) return { configured: false };
    const backups = await source.list();
    const minFree = this.#folders.get(serverId)!.backupMinFreeGB * GB;
    return { configured: true, backups, free: await source.free(), growth: growthPerDay(backups), minFree };
  }

  /** Crash logs written at or after `sinceMs` in the server folder (none without one, so none for an Agent's). Never throws. */
  crashLogs(serverId: string, sinceMs: number): Promise<string[]> {
    const dir = this.#folders.get(serverId)?.dir;
    return dir ? findCrashLogs(dir, sinceMs) : Promise.resolve([]);
  }

  /** Whether a known server's logs can be read: it has a folder, or an Agent runs it. */
  hasLogs(serverId: string): boolean {
    return this.#logSource(serverId) !== undefined;
  }

  #logSource(serverId: string): LogSource | undefined {
    return this.#hub.get(serverId) ? this.#logSources.get(serverId) : undefined;
  }

  /**
   * The server's logs, newest first: its folder's logs and crash reports (never throws), or the files its Agent serves
   * (rejects if the Agent can't answer). Undefined unknown or with neither.
   */
  async logs(serverId: string): Promise<LogFile[] | undefined> {
    return this.#logSource(serverId)?.list();
  }

  /**
   * The last lines of one listed log (see `tailLog`, or the Agent's `log`); undefined unknown, with neither a folder
   * nor an Agent, or not listed. Rejects if the file can't be read or the Agent can't answer.
   */
  async log(serverId: string, name: string): Promise<string[] | undefined> {
    return this.#logSource(serverId)?.read(name);
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

  /** A batch of audit log entries, newest first (see `Db.auditLog`), and whether older ones remain. */
  audit(limit: number, filter: AuditFilter = {}): { entries: AuditRow[]; older: boolean } {
    const rows = this.#db.auditLog(limit + 1, filter);
    return { entries: rows.slice(0, limit), older: rows.length > limit };
  }

  /** The name a Discord user linked in the server's game (its Minecraft or its Factorio name), if any. */
  linkedPlayer(serverId: string, discordId: string): string | undefined {
    const game = this.#hub.get(serverId)?.game;
    if (game === 'factorio') return this.#db.factorioLinkByDiscord(discordId)?.name;
    return game === 'minecraft' ? this.#db.linkByDiscord(discordId)?.player : undefined;
  }
}

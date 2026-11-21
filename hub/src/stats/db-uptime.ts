// `Db`'s uptime and play layer (over `db-base.ts`): the up/down/unknown log (`events`; `recordLifecycle` maps hub
// lifecycle events to up/down, and `lost` to unknown; `touch` stamps the hub alive in `meta`, `markHubRestart` marks
// the gap unknown and closes open sessions) and uptime math (`computeUptime`); player sessions, daily peaks and TPS,
// and their stats queries; for server history, `states` (up/down rows from a window's start), `sessionsSince` and
// `tpsAveraged` (TPS in time buckets, in SQL). Writes never throw.

import type { Lifecycle } from '../servers/servers.ts';
import { DbBase } from './db-base.ts';

export type State = 'up' | 'down' | 'unknown';
export type Row = { ts: number; state: State };

const LIFECYCLE_STATES = new Map<string, State>([
  ['connected', 'up'],
  ['started', 'up'],
  ['recovered', 'up'],
  ['stopped', 'down'],
  ['crashed', 'down'],
  ['hung', 'down'],
  ['offline', 'down'],
  ['lost', 'unknown'], // its Agent left: nobody knows what the server does meanwhile
] satisfies [Lifecycle, State][]);

/** Fraction of known (up + down) time in [from, to] that the server was up; null if none was known. */
export function computeUptime(rows: Row[], from: number, to: number): number | null {
  let up = 0;
  let known = 0;
  for (let i = 0; i < rows.length; i++) {
    const start = Math.max(rows[i].ts, from);
    const end = Math.min(rows[i + 1]?.ts ?? to, to);
    if (end <= start || rows[i].state === 'unknown') continue;
    known += end - start;
    if (rows[i].state === 'up') up += end - start;
  }
  return known === 0 ? null : up / known;
}

/** `Db`'s uptime, sessions, peaks and TPS (`db.ts` extends it, through the layers between). */
export class UptimeDb extends DbBase {
  record(serverId: string, state: State, reason: string, ts = Date.now()): void {
    this.write('record', 'INSERT INTO events (server_id, ts, state, reason) VALUES (?, ?, ?, ?)', serverId, ts, state, reason);
    this.touch(ts); // the hub was alive at least until this event
  }

  /** Records a hub event's effect on uptime, with the event type as the reason; non-lifecycle events are ignored. */
  recordLifecycle(serverId: string, type: string, ts = Date.now()): void {
    const state = LIFECYCLE_STATES.get(type);
    if (state) this.record(serverId, state, type, ts);
  }

  /** Stamps the hub as alive. Call every minute. */
  touch(ts = Date.now()): void {
    this.write(
      'touch',
      "INSERT INTO meta (key, value) VALUES ('last_alive', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ts,
    );
  }

  /**
   * Call once at hub startup: the time since the last touch is unknown for every server, and sessions still
   * open end at that last touch. Both use the old stamp, read before touch(now) replaces it.
   */
  markHubRestart(serverIds: string[], now = Date.now()): void {
    const last = this.handle.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get() as
      | { value: number }
      | undefined;
    // MAX: a session opened after the last stamp ends at its start, never before it.
    this.write('close sessions', 'UPDATE sessions SET end = MAX(start, ?) WHERE end IS NULL', last?.value ?? now);
    for (const id of serverIds) {
      if (last) this.record(id, 'unknown', 'hub down', last.value);
      this.record(id, 'unknown', 'hub start', now);
    }
    this.touch(now);
  }

  uptime(serverId: string, from: number, to = Date.now()): number | null {
    return computeUptime(this.states(serverId, from, to), from, to);
  }

  /** State changes in [from, to], oldest first, starting with the state at `from` if one was recorded before it. */
  states(serverId: string, from: number, to = Date.now()): (Row & { reason: string })[] {
    const before = this.handle
      .prepare('SELECT state, reason FROM events WHERE server_id = ? AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT 1')
      .get(serverId, from) as { state: State; reason: string } | undefined;
    const rows = this.handle
      .prepare('SELECT ts, state, reason FROM events WHERE server_id = ? AND ts > ? AND ts <= ? ORDER BY ts, rowid')
      .all(serverId, from, to) as (Row & { reason: string })[];
    return before ? [{ ts: from, ...before }, ...rows] : rows;
  }

  countEvents(serverId: string, reason: string, from: number, to: number): number {
    const row = this.handle
      .prepare('SELECT COUNT(*) AS n FROM events WHERE server_id = ? AND reason = ? AND ts >= ? AND ts < ?')
      .get(serverId, reason, from, to) as { n: number };
    return row.n;
  }

  openSession(serverId: string, player: string, ts: number): void {
    this.write('open session', 'INSERT INTO sessions (server_id, player, start, end) VALUES (?, ?, ?, NULL)', serverId, player, ts);
  }

  closeSession(serverId: string, player: string, ts: number): void {
    this.write('close session', 'UPDATE sessions SET end = ? WHERE server_id = ? AND player = ? AND end IS NULL', ts, serverId, player);
  }

  /** Playtime in [from, to]; an open session counts until `now`. Names match case-insensitively. */
  playtime(serverId: string, player: string, from: number, to: number, now = Date.now()): number {
    const row = this.handle
      .prepare(
        `SELECT COALESCE(SUM(MIN(COALESCE(end, ?1), ?2) - MAX(start, ?3)), 0) AS ms FROM sessions
         WHERE server_id = ?4 AND player = ?5 COLLATE NOCASE AND start < ?2 AND COALESCE(end, ?1) > ?3`,
      )
      .get(now, to, from, serverId, player) as { ms: number };
    return row.ms;
  }

  /** `{ online: true }` while a session is open, else the last session's end, or null if never seen. */
  lastSeen(serverId: string, player: string): { online: true } | number | null {
    const row = this.handle
      .prepare('SELECT MAX(end) AS last, SUM(end IS NULL) AS open FROM sessions WHERE server_id = ? AND player = ? COLLATE NOCASE')
      .get(serverId, player) as { last: number | null; open: number | null };
    if (row.open) return { online: true };
    return row.last;
  }

  /** Sessions overlapping [from, now]; `end` null while open. */
  sessionsSince(serverId: string, from: number): { start: number; end: number | null }[] {
    return this.handle
      .prepare('SELECT start, end FROM sessions WHERE server_id = ? AND (end IS NULL OR end > ?)')
      .all(serverId, from) as { start: number; end: number | null }[];
  }

  /** Players by playtime in [from, to], most first. */
  top(serverId: string, from: number, to: number, limit: number, now = Date.now()): { player: string; ms: number }[] {
    return this.handle
      .prepare(
        `SELECT player, SUM(MIN(COALESCE(end, ?1), ?2) - MAX(start, ?3)) AS ms FROM sessions
         WHERE server_id = ?4 AND start < ?2 AND COALESCE(end, ?1) > ?3
         GROUP BY player COLLATE NOCASE ORDER BY ms DESC LIMIT ?5`,
      )
      .all(now, to, from, serverId, limit)
      .map((r) => ({ player: r.player as string, ms: r.ms as number })); // plain objects, not sqlite's null-prototype rows
  }

  /** Keeps the highest player count seen on a local day ("YYYY-MM-DD"). */
  recordPeak(serverId: string, day: string, count: number): void {
    this.write(
      'peak',
      'INSERT INTO peaks (server_id, day, peak) VALUES (?, ?, ?) ON CONFLICT (server_id, day) DO UPDATE SET peak = MAX(peak, excluded.peak)',
      serverId,
      day,
      count,
    );
  }

  peak(serverId: string, day: string): number | null {
    const row = this.handle.prepare('SELECT peak FROM peaks WHERE server_id = ? AND day = ?').get(serverId, day) as
      | { peak: number }
      | undefined;
    return row?.peak ?? null;
  }

  recordTps(serverId: string, ts: number, tps: number, worstName: string | null, worstMs: number | null): void {
    this.write('tps', 'INSERT INTO tps (server_id, ts, tps, worst_name, worst_ms) VALUES (?, ?, ?, ?, ?)', serverId, ts, tps, worstName, worstMs);
  }

  /** TPS samples at or after `from`, oldest first. */
  tpsSince(serverId: string, from: number): { ts: number; tps: number }[] {
    return this.handle
      .prepare('SELECT ts, tps FROM tps WHERE server_id = ? AND ts >= ? ORDER BY ts')
      .all(serverId, from)
      .map((r) => ({ ts: r.ts as number, tps: r.tps as number }));
  }

  /** TPS samples since `from`, oldest first, averaged into `width`-ms buckets (the last one no later than `maxBucket`). */
  tpsAveraged(serverId: string, from: number, width: number, maxBucket: number): { ts: number; tps: number }[] {
    return this.handle
      .prepare(
        `SELECT ROUND(AVG(ts)) AS ts, AVG(tps) AS tps FROM tps WHERE server_id = ?1 AND ts >= ?2
         GROUP BY MIN(CAST((ts - ?2) / ?3 AS INTEGER), ?4) ORDER BY ts`,
      )
      .all(serverId, from, width, maxBucket)
      .map((r) => ({ ts: r.ts as number, tps: r.tps as number }));
  }

  /** Average and minimum TPS over [from, to), or null without samples. */
  tpsStats(serverId: string, from: number, to: number): { avg: number; min: number } | null {
    const row = this.handle
      .prepare('SELECT AVG(tps) AS avg, MIN(tps) AS min FROM tps WHERE server_id = ? AND ts >= ? AND ts < ?')
      .get(serverId, from, to) as { avg: number | null; min: number | null };
    return row.avg === null || row.min === null ? null : { avg: row.avg, min: row.min };
  }
}

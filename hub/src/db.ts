import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEntry, HostSample, Lifecycle } from './servers.ts';
import { localDay } from './units.ts';

const TPS_KEEP_MS = 90 * 24 * 60 * 60_000;
const COPIES_KEPT = 7;

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

/** SQLite store: server up/down transitions (uptime), player sessions (playtime), the audit log, and nightly upkeep. */
export class Db {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (server_id TEXT NOT NULL, ts INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_server_ts ON events (server_id, ts);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (server_id TEXT NOT NULL, player TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER);
      CREATE INDEX IF NOT EXISTS sessions_server_player ON sessions (server_id, player);
      CREATE TABLE IF NOT EXISTS peaks (server_id TEXT NOT NULL, day TEXT NOT NULL, peak INTEGER NOT NULL, PRIMARY KEY (server_id, day));
      CREATE TABLE IF NOT EXISTS tps (server_id TEXT NOT NULL, ts INTEGER NOT NULL, tps REAL NOT NULL, worst_name TEXT, worst_ms REAL);
      CREATE INDEX IF NOT EXISTS tps_server_ts ON tps (server_id, ts);
      CREATE TABLE IF NOT EXISTS links (discord_id TEXT PRIMARY KEY, player TEXT NOT NULL, uuid TEXT NOT NULL, linked_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS links_player ON links (player COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS web_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_target_ts ON audit (target, ts);
      CREATE TABLE IF NOT EXISTS host_samples (host_id TEXT NOT NULL, ts INTEGER NOT NULL, sample TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS host_samples_host_ts ON host_samples (host_id, ts);
    `);
  }

  /** Writes never throw: a database error (disk full, locked) is logged instead of taking the hub down. */
  #write(label: string, sql: string, ...params: (string | number | null)[]): void {
    try {
      this.#db.prepare(sql).run(...params);
    } catch (err) {
      console.error(`[db] ${label} failed:`, (err as Error).message);
    }
  }

  record(serverId: string, state: State, reason: string, ts = Date.now()): void {
    this.#write('record', 'INSERT INTO events (server_id, ts, state, reason) VALUES (?, ?, ?, ?)', serverId, ts, state, reason);
    this.touch(ts); // the hub was alive at least until this event
  }

  /** Records a hub event's effect on uptime, with the event type as the reason; non-lifecycle events are ignored. */
  recordLifecycle(serverId: string, type: string, ts = Date.now()): void {
    const state = LIFECYCLE_STATES.get(type);
    if (state) this.record(serverId, state, type, ts);
  }

  /** Stamps the hub as alive. Call every minute. */
  touch(ts = Date.now()): void {
    this.#write(
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
    const last = this.#db.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get() as
      | { value: number }
      | undefined;
    // MAX: a session opened after the last stamp ends at its start, never before it.
    this.#write('close sessions', 'UPDATE sessions SET end = MAX(start, ?) WHERE end IS NULL', last?.value ?? now);
    for (const id of serverIds) {
      if (last) this.record(id, 'unknown', 'hub down', last.value);
      this.record(id, 'unknown', 'hub start', now);
    }
    this.touch(now);
  }

  uptime(serverId: string, from: number, to = Date.now()): number | null {
    const before = this.#db
      .prepare('SELECT state FROM events WHERE server_id = ? AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT 1')
      .get(serverId, from) as { state: State } | undefined;
    const rows = this.#db
      .prepare('SELECT ts, state FROM events WHERE server_id = ? AND ts > ? AND ts <= ? ORDER BY ts, rowid')
      .all(serverId, from, to) as Row[];
    return computeUptime(before ? [{ ts: from, state: before.state }, ...rows] : rows, from, to);
  }

  countEvents(serverId: string, reason: string, from: number, to: number): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE server_id = ? AND reason = ? AND ts >= ? AND ts < ?')
      .get(serverId, reason, from, to) as { n: number };
    return row.n;
  }

  openSession(serverId: string, player: string, ts: number): void {
    this.#write('open session', 'INSERT INTO sessions (server_id, player, start, end) VALUES (?, ?, ?, NULL)', serverId, player, ts);
  }

  closeSession(serverId: string, player: string, ts: number): void {
    this.#write('close session', 'UPDATE sessions SET end = ? WHERE server_id = ? AND player = ? AND end IS NULL', ts, serverId, player);
  }

  /** Playtime in [from, to]; an open session counts until `now`. Names match case-insensitively. */
  playtime(serverId: string, player: string, from: number, to: number, now = Date.now()): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(MIN(COALESCE(end, ?1), ?2) - MAX(start, ?3)), 0) AS ms FROM sessions
         WHERE server_id = ?4 AND player = ?5 COLLATE NOCASE AND start < ?2 AND COALESCE(end, ?1) > ?3`,
      )
      .get(now, to, from, serverId, player) as { ms: number };
    return row.ms;
  }

  /** `{ online: true }` while a session is open, else the last session's end, or null if never seen. */
  lastSeen(serverId: string, player: string): { online: true } | number | null {
    const row = this.#db
      .prepare('SELECT MAX(end) AS last, SUM(end IS NULL) AS open FROM sessions WHERE server_id = ? AND player = ? COLLATE NOCASE')
      .get(serverId, player) as { last: number | null; open: number | null };
    if (row.open) return { online: true };
    return row.last;
  }

  /** Players by playtime in [from, to], most first. */
  top(serverId: string, from: number, to: number, limit: number, now = Date.now()): { player: string; ms: number }[] {
    return this.#db
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
    this.#write(
      'peak',
      'INSERT INTO peaks (server_id, day, peak) VALUES (?, ?, ?) ON CONFLICT (server_id, day) DO UPDATE SET peak = MAX(peak, excluded.peak)',
      serverId,
      day,
      count,
    );
  }

  peak(serverId: string, day: string): number | null {
    const row = this.#db.prepare('SELECT peak FROM peaks WHERE server_id = ? AND day = ?').get(serverId, day) as
      | { peak: number }
      | undefined;
    return row?.peak ?? null;
  }

  recordTps(serverId: string, ts: number, tps: number, worstName: string | null, worstMs: number | null): void {
    this.#write('tps', 'INSERT INTO tps (server_id, ts, tps, worst_name, worst_ms) VALUES (?, ?, ?, ?, ?)', serverId, ts, tps, worstName, worstMs);
  }

  /** TPS samples at or after `from`, oldest first. */
  tpsSince(serverId: string, from: number): { ts: number; tps: number }[] {
    return this.#db
      .prepare('SELECT ts, tps FROM tps WHERE server_id = ? AND ts >= ? ORDER BY ts')
      .all(serverId, from)
      .map((r) => ({ ts: r.ts as number, tps: r.tps as number }));
  }

  /** Average and minimum TPS over [from, to), or null without samples. */
  tpsStats(serverId: string, from: number, to: number): { avg: number; min: number } | null {
    const row = this.#db
      .prepare('SELECT AVG(tps) AS avg, MIN(tps) AS min FROM tps WHERE server_id = ? AND ts >= ? AND ts < ?')
      .get(serverId, from, to) as { avg: number | null; min: number | null };
    return row.avg === null || row.min === null ? null : { avg: row.avg, min: row.min };
  }

  /** Links a Discord account to a Minecraft player, replacing any earlier link of either. */
  link(discordId: string, player: string, uuid: string, ts: number): void {
    this.#write('unlink old', 'DELETE FROM links WHERE discord_id = ? OR player = ? COLLATE NOCASE', discordId, player);
    this.#write('link', 'INSERT INTO links (discord_id, player, uuid, linked_at) VALUES (?, ?, ?, ?)', discordId, player, uuid, ts);
  }

  /** True if a link was removed. */
  unlinkDiscord(discordId: string): boolean {
    return this.#delete('DELETE FROM links WHERE discord_id = ?', discordId);
  }

  unlinkPlayer(player: string): boolean {
    return this.#delete('DELETE FROM links WHERE player = ? COLLATE NOCASE', player);
  }

  #delete(sql: string, param: string): boolean {
    try {
      return Number(this.#db.prepare(sql).run(param).changes) > 0;
    } catch (err) {
      console.error('[db] unlink failed:', (err as Error).message);
      return false;
    }
  }

  linkByDiscord(discordId: string): { player: string; uuid: string } | null {
    const row = this.#db.prepare('SELECT player, uuid FROM links WHERE discord_id = ?').get(discordId) as
      | { player: string; uuid: string }
      | undefined;
    return row ? { player: row.player, uuid: row.uuid } : null;
  }

  linkByPlayer(player: string): { discordId: string; player: string } | null {
    const row = this.#db.prepare('SELECT discord_id, player FROM links WHERE player = ? COLLATE NOCASE').get(player) as
      | { discord_id: string; player: string }
      | undefined;
    return row ? { discordId: row.discord_id, player: row.player } : null;
  }

  /** A host's sample, kept as JSON. */
  recordHostSample(hostId: string, sample: HostSample): void {
    this.#write('host sample', 'INSERT INTO host_samples (host_id, ts, sample) VALUES (?, ?, ?)', hostId, sample.ts, JSON.stringify(sample));
  }

  /** A host's samples taken at or after `since`, oldest first. */
  hostSamples(hostId: string, since: number): HostSample[] {
    return this.#db
      .prepare('SELECT sample FROM host_samples WHERE host_id = ? AND ts >= ? ORDER BY ts')
      .all(hostId, since)
      .map((r) => JSON.parse(r.sample as string) as HostSample);
  }

  /**
   * Nightly upkeep: drops TPS and host samples older than 90 days (every other table is small and kept for all-time
   * stats), then writes a copy to `copyDir/hub-<local day>.db` and keeps the 7 newest copies. Never throws.
   */
  maintain(copyDir: string, now = Date.now()): void {
    this.#write('prune tps', 'DELETE FROM tps WHERE ts < ?', now - TPS_KEEP_MS);
    this.#write('prune host samples', 'DELETE FROM host_samples WHERE ts < ?', now - TPS_KEEP_MS);
    this.#write('prune web sessions', 'DELETE FROM web_sessions WHERE expires <= ?', now);
    try {
      mkdirSync(copyDir, { recursive: true });
      const file = join(copyDir, `hub-${localDay(now)}.db`);
      rmSync(file, { force: true }); // VACUUM INTO refuses to overwrite
      this.#db.prepare('VACUUM INTO ?').run(file);
      const old = readdirSync(copyDir)
        .filter((n) => /^hub-\d{4}-\d{2}-\d{2}\.db$/.test(n))
        .sort()
        .reverse()
        .slice(COPIES_KEPT);
      for (const name of old) rmSync(join(copyDir, name), { force: true });
    } catch (err) {
      console.error('[db] nightly copy failed:', (err as Error).message);
    }
  }

  /** A dashboard login; `id` is the hash of the cookie's session id, never the id itself. */
  addWebSession(id: string, userId: string, username: string, expires: number): void {
    this.#write(
      'add web session',
      'INSERT INTO web_sessions (id, user_id, username, expires) VALUES (?, ?, ?, ?)',
      id,
      userId,
      username,
      expires,
    );
  }

  /** The logged-in Discord user of an unexpired session. */
  webSession(id: string, now = Date.now()): { id: string; username: string } | undefined {
    const row = this.#db
      .prepare('SELECT user_id AS id, username FROM web_sessions WHERE id = ? AND expires > ?')
      .get(id, now) as { id: string; username: string } | undefined;
    return row && { ...row };
  }

  deleteWebSession(id: string): void {
    this.#write('delete web session', 'DELETE FROM web_sessions WHERE id = ?', id);
  }

  /** Records who did what to which server. Never pruned: the table is small. */
  audit(e: AuditEntry, ts = Date.now()): void {
    this.#write('audit', 'INSERT INTO audit (ts, actor, action, target, details) VALUES (?, ?, ?, ?, ?)', ts, e.actor, e.action, e.target, e.details);
  }

  /** The newest `limit` audit entries, newest first, for every server or just `target`. */
  auditLog(limit: number, target?: string): (AuditEntry & { ts: number })[] {
    return this.#db
      .prepare('SELECT ts, actor, action, target, details FROM audit WHERE ?1 IS NULL OR target = ?1 ORDER BY ts DESC, rowid DESC LIMIT ?2')
      .all(target ?? null, limit)
      .map((r) => ({ ...r }) as AuditEntry & { ts: number });
  }

  close(): void {
    this.#db.close();
  }
}

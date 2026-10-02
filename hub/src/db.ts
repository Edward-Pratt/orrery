import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEntry, HostSample, Lifecycle } from './servers.ts';
import type { AuditRow, DeployOutcome, DeployRow, PackOutcome, PackStep } from './types.ts';

export type AuditFilter = { target?: string; actor?: string; before?: number };
import { localDay } from './units.ts';

/** How long TPS and host samples are kept. */
const SAMPLES_KEEP_MS = 90 * 24 * 60 * 60_000;
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
      CREATE TABLE IF NOT EXISTS web_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, expires INTEGER NOT NULL, avatar TEXT);
      CREATE TABLE IF NOT EXISTS audit (ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_target_ts ON audit (target, ts);
      CREATE TABLE IF NOT EXISTS host_samples (host_id TEXT NOT NULL, ts INTEGER NOT NULL, sample TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS host_samples_host_ts ON host_samples (host_id, ts);
      CREATE TABLE IF NOT EXISTS deploys (id INTEGER PRIMARY KEY, part TEXT NOT NULL, target TEXT NOT NULL, from_tag TEXT,
        to_tag TEXT NOT NULL, by TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER, outcome TEXT NOT NULL, log TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS packs (server_id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL,
        sha256 TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, how TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pack_files (server_id TEXT NOT NULL, path TEXT NOT NULL, pack INTEGER NOT NULL, PRIMARY KEY (server_id, path));
      CREATE TABLE IF NOT EXISTS extras (id INTEGER PRIMARY KEY, server_id TEXT NOT NULL, target TEXT NOT NULL, sha256 TEXT NOT NULL,
        label TEXT NOT NULL, note TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS config_edits (id INTEGER PRIMARY KEY, server_id TEXT NOT NULL, path TEXT NOT NULL, find TEXT NOT NULL,
        replace TEXT NOT NULL, note TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, failed_on TEXT);
      CREATE TABLE IF NOT EXISTS pack_updates (id INTEGER PRIMARY KEY, server_id TEXT NOT NULL, from_version TEXT NOT NULL,
        to_version TEXT NOT NULL, changes TEXT, by TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER, outcome TEXT NOT NULL,
        step TEXT NOT NULL, backup TEXT, log TEXT NOT NULL, restored INTEGER);
    `);
    // Tables are only ever added (never altered) from here on: an older hub after a Rollback must still read this file.
    // sessions from before the avatar column read as null
    if (!(this.#db.prepare('PRAGMA table_info(web_sessions)').all() as { name: string }[]).some((c) => c.name === 'avatar')) {
      this.#db.exec('ALTER TABLE web_sessions ADD COLUMN avatar TEXT');
    }
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
    return computeUptime(this.states(serverId, from, to), from, to);
  }

  /** State changes in [from, to], oldest first, starting with the state at `from` if one was recorded before it. */
  states(serverId: string, from: number, to = Date.now()): (Row & { reason: string })[] {
    const before = this.#db
      .prepare('SELECT state, reason FROM events WHERE server_id = ? AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT 1')
      .get(serverId, from) as { state: State; reason: string } | undefined;
    const rows = this.#db
      .prepare('SELECT ts, state, reason FROM events WHERE server_id = ? AND ts > ? AND ts <= ? ORDER BY ts, rowid')
      .all(serverId, from, to) as (Row & { reason: string })[];
    return before ? [{ ts: from, ...before }, ...rows] : rows;
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

  /** Sessions overlapping [from, now]; `end` null while open. */
  sessionsSince(serverId: string, from: number): { start: number; end: number | null }[] {
    return this.#db
      .prepare('SELECT start, end FROM sessions WHERE server_id = ? AND (end IS NULL OR end > ?)')
      .all(serverId, from) as { start: number; end: number | null }[];
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

  /** TPS samples since `from`, oldest first, averaged into `width`-ms buckets (the last one no later than `maxBucket`). */
  tpsAveraged(serverId: string, from: number, width: number, maxBucket: number): { ts: number; tps: number }[] {
    return this.#db
      .prepare(
        `SELECT ROUND(AVG(ts)) AS ts, AVG(tps) AS tps FROM tps WHERE server_id = ?1 AND ts >= ?2
         GROUP BY MIN(CAST((ts - ?2) / ?3 AS INTEGER), ?4) ORDER BY ts`,
      )
      .all(serverId, from, width, maxBucket)
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
    this.#write('prune tps', 'DELETE FROM tps WHERE ts < ?', now - SAMPLES_KEEP_MS);
    this.#write('prune host samples', 'DELETE FROM host_samples WHERE ts < ?', now - SAMPLES_KEEP_MS);
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
  addWebSession(id: string, userId: string, username: string, avatar: string | null, expires: number): void {
    this.#write(
      'add web session',
      'INSERT INTO web_sessions (id, user_id, username, avatar, expires) VALUES (?, ?, ?, ?, ?)',
      id,
      userId,
      username,
      avatar,
      expires,
    );
  }

  /** The logged-in Discord user of an unexpired session. */
  webSession(id: string, now = Date.now()): { id: string; username: string; avatar: string | null } | undefined {
    const row = this.#db
      .prepare('SELECT user_id AS id, username, avatar FROM web_sessions WHERE id = ? AND expires > ?')
      .get(id, now) as { id: string; username: string; avatar: string | null } | undefined;
    return row && { ...row };
  }

  deleteWebSession(id: string): void {
    this.#write('delete web session', 'DELETE FROM web_sessions WHERE id = ?', id);
  }

  /** Records who did what to which server. Never pruned: the table is small. */
  audit(e: AuditEntry, ts = Date.now()): void {
    this.#write('audit', 'INSERT INTO audit (ts, actor, action, target, details) VALUES (?, ?, ?, ?, ?)', ts, e.actor, e.action, e.target, e.details);
  }

  /**
   * The newest `limit` audit entries, newest first, optionally of one `target` and/or `actor`, and only those strictly
   * older than the entry `before` (its `id`): the order is (ts, rowid), so two entries in one millisecond aren't skipped.
   */
  auditLog(limit: number, { target, actor, before }: AuditFilter = {}): AuditRow[] {
    return this.#db
      .prepare(
        `SELECT rowid AS id, ts, actor, action, target, details FROM audit
         WHERE (?1 IS NULL OR target = ?1) AND (?2 IS NULL OR actor = ?2)
           AND (?3 IS NULL OR (ts, rowid) < (SELECT ts, rowid FROM audit WHERE rowid = ?3))
         ORDER BY ts DESC, rowid DESC LIMIT ?4`,
      )
      .all(target ?? null, actor ?? null, before ?? null, limit)
      .map((r) => ({ ...r }) as AuditRow);
  }

  /** A copy of the whole database, now (`VACUUM INTO`). Throws: a deploy must not go ahead without it. */
  copyTo(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    this.#db.prepare('VACUUM INTO ?').run(file);
  }

  /** Starts a deploy's history row as `running`; returns its id. Throws, so a deploy isn't started unrecorded. */
  startDeploy(d: Pick<DeployRow, 'part' | 'target' | 'from' | 'to' | 'by'>, started = Date.now()): number {
    const r = this.#db
      .prepare("INSERT INTO deploys (part, target, from_tag, to_tag, by, started, outcome, log) VALUES (?, ?, ?, ?, ?, ?, 'running', '')")
      .run(d.part, d.target, d.from, d.to, d.by, started);
    return Number(r.lastInsertRowid);
  }

  /** Closes a running deploy's row with its outcome; a row already closed stays as it is. */
  finishDeploy(id: number, outcome: Exclude<DeployOutcome, 'running'>, log: string, finished = Date.now()): void {
    this.#write('finish deploy', "UPDATE deploys SET outcome = ?, log = ?, finished = ? WHERE id = ? AND outcome = 'running'", outcome, log, finished, id);
  }

  /** The newest `limit` deploys, newest first: only those older than the row `before`, of `part`, with `outcome` (`running`: still running). */
  deploys(limit: number, { before, part, outcome, running }: { before?: number; part?: DeployRow['part']; outcome?: DeployOutcome; running?: true } = {}): DeployRow[] {
    return this.#db
      .prepare(
        `SELECT id, part, target, from_tag AS "from", to_tag AS "to", by, started, finished, outcome, log FROM deploys
         WHERE (?1 IS NULL OR id < ?1) AND (?2 IS NULL OR part = ?2) AND (?3 IS NULL OR outcome = ?3) ORDER BY id DESC LIMIT ?4`,
      )
      .all(before ?? null, part ?? null, running ? 'running' : (outcome ?? null), limit)
      .map((r) => ({ ...r }) as DeployRow);
  }

  // Packs. These writes throw: an admin's change must not be reported as done when it wasn't stored.

  pack(serverId: string): PackRow | undefined {
    const r = this.#db.prepare('SELECT name, version, source, sha256, by, at, how, snapshot FROM packs WHERE server_id = ?').get(serverId);
    return r && ({ ...r } as PackRow);
  }

  /** Writes a server's pack row and manifest (`files`; `own`: those the pack itself ships) at once. */
  setPack(serverId: string, p: PackRow, files: string[], own: Set<string>): void {
    this.#db.exec('BEGIN');
    try {
      this.#db
        .prepare('INSERT OR REPLACE INTO packs (server_id, name, version, source, sha256, by, at, how, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(serverId, p.name, p.version, p.source, p.sha256, p.by, p.at, p.how, p.snapshot);
      this.#db.prepare('DELETE FROM pack_files WHERE server_id = ?').run(serverId);
      const add = this.#db.prepare('INSERT INTO pack_files (server_id, path, pack) VALUES (?, ?, ?)');
      for (const f of files) add.run(serverId, f, own.has(f) ? 1 : 0);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The manifest: every file the last apply wrote, sorted (`own`: only those the pack itself ships). */
  packFiles(serverId: string, own = false): string[] {
    return this.#db
      .prepare('SELECT path FROM pack_files WHERE server_id = ? AND pack >= ? ORDER BY path')
      .all(serverId, own ? 1 : 0)
      .map((r) => r.path as string);
  }

  extras(serverId: string): ExtraRow[] {
    return this.#db
      .prepare('SELECT id, target, sha256, label, note, by, at, removed FROM extras WHERE server_id = ? ORDER BY target')
      .all(serverId)
      .map((r) => ({ ...r, removed: r.removed === 1 }) as ExtraRow);
  }

  addExtra(serverId: string, e: Omit<ExtraRow, 'id' | 'removed'>): number {
    const r = this.#db
      .prepare('INSERT INTO extras (server_id, target, sha256, label, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(serverId, e.target, e.sha256, e.label, e.note, e.by, e.at);
    return Number(r.lastInsertRowid);
  }

  updateExtra(id: number, e: Pick<ExtraRow, 'sha256' | 'label' | 'note' | 'removed'>): void {
    this.#db.prepare('UPDATE extras SET sha256 = ?, label = ?, note = ?, removed = ? WHERE id = ?').run(e.sha256, e.label, e.note, e.removed ? 1 : 0, id);
  }

  deleteExtra(id: number): void {
    this.#db.prepare('DELETE FROM extras WHERE id = ?').run(id);
  }

  /** A server's Config edits, in the order they were added (the order they run in). */
  configEdits(serverId: string): EditRow[] {
    return this.#db
      .prepare('SELECT id, path, find, replace, note, by, at, failed_on AS failedOn FROM config_edits WHERE server_id = ? ORDER BY id')
      .all(serverId)
      .map((r) => ({ ...r }) as EditRow);
  }

  addEdit(serverId: string, e: Omit<EditRow, 'id' | 'failedOn'>): number {
    const r = this.#db
      .prepare('INSERT INTO config_edits (server_id, path, find, replace, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(serverId, e.path, e.find, e.replace, e.note, e.by, e.at);
    return Number(r.lastInsertRowid);
  }

  updateEdit(id: number, e: Pick<EditRow, 'path' | 'find' | 'replace' | 'note' | 'failedOn'>): void {
    this.#db.prepare('UPDATE config_edits SET path = ?, find = ?, replace = ?, note = ?, failed_on = ? WHERE id = ?').run(e.path, e.find, e.replace, e.note, e.failedOn, id);
  }

  deleteEdit(id: number): void {
    this.#db.prepare('DELETE FROM config_edits WHERE id = ?').run(id);
  }

  /** Starts a pack update's history row as `running` in Prepare; returns its id. */
  startPackUpdate(serverId: string, u: Pick<PackUpdateDbRow, 'from' | 'to' | 'changes' | 'by' | 'started'>): number {
    const r = this.#db
      .prepare("INSERT INTO pack_updates (server_id, from_version, to_version, changes, by, started, outcome, step, log) VALUES (?, ?, ?, ?, ?, ?, 'running', 'prepare', '')")
      .run(serverId, u.from, u.to, u.changes === null ? null : JSON.stringify(u.changes), u.by, u.started);
    return Number(r.lastInsertRowid);
  }

  /** Changes a pack update's row; never throws (the update goes on). */
  setPackUpdate(id: number, u: Partial<Pick<PackUpdateDbRow, 'finished' | 'outcome' | 'step' | 'backup' | 'log' | 'restored'>>): void {
    const columns = { finished: 'finished', outcome: 'outcome', step: 'step', backup: 'backup', log: 'log', restored: 'restored' } as const;
    const keys = Object.keys(u) as (keyof typeof columns)[];
    if (!keys.length) return;
    this.#write('pack update', `UPDATE pack_updates SET ${keys.map((k) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => u[k] ?? null), id);
  }

  /** A server's pack updates, newest first (`serverId` undefined: every server's still running). */
  packUpdates(serverId: string | undefined, limit: number): PackUpdateDbRow[] {
    return this.#db
      .prepare(
        `SELECT id, server_id AS serverId, from_version AS "from", to_version AS "to", changes, by, started, finished, outcome, step, backup, log, restored
         FROM pack_updates WHERE (?1 IS NULL AND outcome = 'running') OR server_id = ?1 ORDER BY id DESC LIMIT ?2`,
      )
      .all(serverId ?? null, limit)
      .map((r) => ({ ...r, changes: r.changes === null ? null : JSON.parse(r.changes as string) }) as PackUpdateDbRow);
  }

  close(): void {
    this.#db.close();
  }
}

/** A server's installed pack as stored; `snapshot` is what the last apply laid over it, as JSON. */
export type PackRow = { name: string; version: string; source: string; sha256: string; by: string; at: number; how: 'adopted' | 'updated'; snapshot: string };
export type ExtraRow = { id: number; target: string; sha256: string; label: string; note: string; by: string; at: number; removed: boolean };
export type EditRow = { id: number; path: string; find: string; replace: string; note: string; by: string; at: number; failedOn: string | null };
export type PackUpdateDbRow = {
  id: number;
  serverId: string;
  from: string;
  to: string;
  changes: string[] | null;
  by: string;
  started: number;
  finished: number | null;
  outcome: PackOutcome;
  step: PackStep;
  backup: string | null;
  log: string;
  restored: number | null;
};

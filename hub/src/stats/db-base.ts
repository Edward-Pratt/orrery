// The base of `Db`'s layers (`db.ts` is the leaf, over `db-library.ts`, `db-packs.ts`, `db-links.ts` and
// `db-uptime.ts`, each extending the one before): it opens the SQLite file (`node:sqlite`) and holds the handle
// (`handle`) every layer's statements run on, creates every table in one statement, in this order, then the two
// columns added since (`web_sessions.avatar`; `packs.library_id`, a nullable column, the one other exception to
// "never altered": an older hub after a Rollback writes it as null). Tables are only added, never altered: an older
// hub after a Rollback still reads the file. `write` is the never-throwing write the layers share; `close` closes it.

import { DatabaseSync } from 'node:sqlite';

export class DbBase {
  /** The database handle every layer's statements run on (`users/store.ts` and `feed-store.ts` get it too). */
  protected readonly handle: DatabaseSync;

  constructor(path: string, timeout = 0) {
    this.handle = new DatabaseSync(path, { timeout }); // the users CLI waits up to 5 s for the running hub's writes
    this.handle.exec(`
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
      CREATE TABLE IF NOT EXISTS web_session_checks (id TEXT PRIMARY KEY, token TEXT NOT NULL, checked INTEGER NOT NULL);
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
      CREATE TABLE IF NOT EXISTS library (id INTEGER PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, mc TEXT NOT NULL,
        loader TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, source TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL,
        UNIQUE (name, version));
      CREATE TABLE IF NOT EXISTS runtimes (name TEXT PRIMARY KEY, feature INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        by TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, dir TEXT NOT NULL, token TEXT NOT NULL,
        unit TEXT NOT NULL, game_port INTEGER NOT NULL, runtime TEXT, by TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY, server_id TEXT NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS feed_server_id ON feed (server_id, id);
      CREATE TABLE IF NOT EXISTS factorio_links (discord_id TEXT PRIMARY KEY, name TEXT NOT NULL, linked_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS factorio_links_name ON factorio_links (name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS mod_update_notices (server_id TEXT PRIMARY KEY, mods TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    // Tables are only ever added (never altered) from here on: an older hub after a Rollback must still read this file.
    // sessions from before the avatar column read as null
    if (!(this.handle.prepare('PRAGMA table_info(web_sessions)').all() as { name: string }[]).some((c) => c.name === 'avatar')) {
      this.handle.exec('ALTER TABLE web_sessions ADD COLUMN avatar TEXT');
    }
    // A pack row's library entry (#139); null on rows from before it, or written by an older hub after a Rollback.
    if (!(this.handle.prepare('PRAGMA table_info(packs)').all() as { name: string }[]).some((c) => c.name === 'library_id')) {
      this.handle.exec('ALTER TABLE packs ADD COLUMN library_id INTEGER');
    }
  }

  /** Writes never throw: a database error (disk full, locked) is logged instead of taking the hub down. */
  protected write(label: string, sql: string, ...params: (string | number | null)[]): void {
    try {
      this.handle.prepare(sql).run(...params);
    } catch (err) {
      console.error(`[db] ${label} failed:`, (err as Error).message);
    }
  }

  close(): void {
    this.handle.close();
  }
}

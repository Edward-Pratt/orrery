// SQLite (`node:sqlite`): `Db`, the hub's one database, built in layers that each extend the one before:
// `db-base.ts` (the handle, every table, the never-throwing write), `db-uptime.ts` (uptime, sessions, peaks, TPS),
// `db-links.ts` (account links), `db-packs.ts` (packs, manifests, Extras, Config edits, pack updates) and
// `db-library.ts` (the pack library, Java runtimes, Pending servers); callers import every name from here. This leaf
// owns the dashboard's login sessions' tables (`web_sessions` and `web_session_checks`, the Discord login's, kept for a
// rollback; their SQL is `users/store.ts`, `db.users`); the audit log (`audit`, `auditLog`: newest first, filtered by
// server, actor and a `before` cursor; never pruned); host samples (`recordHostSample`, `hostSamples`, as JSON); the
// live feed's chat and console (the `feed` table; its SQL is `feed-store.ts`, `db.feed`); `maintain` (nightly: prune
// TPS and host samples > 90 days, expired sessions and all but each server's newest 500 feed rows, 7 dated copies, the
// 3 newest `hub-before-*` deploy copies by time); the deploy history (`startDeploy`, `finishDeploy` (a running row
// only), `amendDeploy` (an `ok` row only: an Agent's deploy whose result came after its hello), `deploys`: newest
// first, by part, outcome and a `before` id) and `copyTo` (a `VACUUM INTO` copy before a hub deploy; it and
// `startDeploy` throw); the portal mod updates last posted per server (`mod_update_notices`: `modUpdateNotice`,
// `setModUpdateNotice`). Other writes never throw.

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuditEntry, HostSample } from '../servers/servers.ts';
import type { AuditRow, DeployOutcome, DeployRow } from '../types.ts';
import { UsersStore } from '../users/store.ts';
import { LibraryDb } from './db-library.ts';
import { FeedStore } from './feed-store.ts';

export type { LibraryRow, PendingRow, RuntimeRow } from './db-library.ts';
export type { EditRow, ExtraRow, PackRow, PackUpdateDbRow } from './db-packs.ts';
export { computeUptime, type Row, type State } from './db-uptime.ts';

export type AuditFilter = { target?: string; actor?: string; before?: number };
import { localDay } from '../units.ts';

/** How long TPS and host samples are kept. */
const SAMPLES_KEEP_MS = 90 * 24 * 60 * 60_000;
const COPIES_KEPT = 7;
/** Copies taken before a hub deploy (`hub-before-<tag>-<ms>.db`) kept: one per Rollback anyone would still want. */
const DEPLOY_COPIES_KEPT = 3;

/** SQLite store: server up/down transitions (uptime), player sessions (playtime), the audit log, recent chat and console (the live feed), and nightly upkeep. */
export class Db extends LibraryDb {
  /** The dashboard's login sessions, on the same database (`users/store.ts`). */
  readonly users: UsersStore;
  /** The live feed's chat and console, on the same database (`feed-store.ts`). */
  readonly feed: FeedStore;

  constructor(path: string, timeout = 0) {
    super(path, timeout);
    this.users = new UsersStore(this.handle);
    this.feed = new FeedStore(this.handle);
  }

  /** The portal mod updates last posted for a server (`name@version` keys) and when; null before the first. */
  modUpdateNotice(serverId: string): { mods: string[]; at: number } | null {
    const row = this.handle.prepare('SELECT mods, at FROM mod_update_notices WHERE server_id = ?').get(serverId) as { mods: string; at: number } | undefined;
    if (!row) return null;
    const mods = JSON.parse(row.mods) as unknown;
    return { mods: Array.isArray(mods) ? mods.filter((m): m is string => typeof m === 'string') : [], at: row.at };
  }

  setModUpdateNotice(serverId: string, mods: string[], at: number): void {
    this.write('mod update notice', 'INSERT OR REPLACE INTO mod_update_notices (server_id, mods, at) VALUES (?, ?, ?)', serverId, JSON.stringify(mods), at);
  }

  /** A host's sample, kept as JSON. */
  recordHostSample(hostId: string, sample: HostSample): void {
    this.write('host sample', 'INSERT INTO host_samples (host_id, ts, sample) VALUES (?, ?, ?)', hostId, sample.ts, JSON.stringify(sample));
  }

  /** A host's samples taken at or after `since`, oldest first. */
  hostSamples(hostId: string, since: number): HostSample[] {
    return this.handle
      .prepare('SELECT sample FROM host_samples WHERE host_id = ? AND ts >= ? ORDER BY ts')
      .all(hostId, since)
      .map((r) => JSON.parse(r.sample as string) as HostSample);
  }

  /**
   * Nightly upkeep: drops TPS and host samples older than 90 days and all but each server's newest 500 feed events
   * (every other table is small and kept for all-time stats), then writes a copy to `copyDir/hub-<local day>.db` and keeps the 7 newest copies, and the 3 newest of the
   * copies taken before hub deploys. Never throws.
   */
  maintain(copyDir: string, now = Date.now()): void {
    this.write('prune tps', 'DELETE FROM tps WHERE ts < ?', now - SAMPLES_KEEP_MS);
    this.write('prune host samples', 'DELETE FROM host_samples WHERE ts < ?', now - SAMPLES_KEEP_MS);
    this.users.pruneSessions(now);
    this.feed.prune();
    try {
      mkdirSync(copyDir, { recursive: true });
      const file = join(copyDir, `hub-${localDay(now)}.db`);
      rmSync(file, { force: true }); // VACUUM INTO refuses to overwrite
      this.handle.prepare('VACUUM INTO ?').run(file);
      const old = readdirSync(copyDir)
        .filter((n) => /^hub-\d{4}-\d{2}-\d{2}\.db$/.test(n))
        .sort()
        .reverse()
        .slice(COPIES_KEPT);
      for (const name of old) rmSync(join(copyDir, name), { force: true });
      // By time, not name: tags don't sort as text (hub-v2.10.0 < hub-v2.9.0).
      const deployCopies = readdirSync(copyDir)
        .filter((n) => /^hub-before-.*\.db$/.test(n))
        .map((n) => ({ n, mtime: statSync(join(copyDir, n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(DEPLOY_COPIES_KEPT);
      for (const { n } of deployCopies) rmSync(join(copyDir, n), { force: true });
    } catch (err) {
      console.error('[db] nightly copy failed:', (err as Error).message);
    }
  }

  /** Records who did what to which server. Never pruned: the table is small. */
  audit(e: AuditEntry, ts = Date.now()): void {
    this.write('audit', 'INSERT INTO audit (ts, actor, action, target, details) VALUES (?, ?, ?, ?, ?)', ts, e.actor, e.action, e.target, e.details);
  }

  /**
   * The newest `limit` audit entries, newest first, optionally of one `target` and/or `actor`, and only those strictly
   * older than the entry `before` (its `id`): the order is (ts, rowid), so two entries in one millisecond aren't skipped.
   */
  auditLog(limit: number, { target, actor, before }: AuditFilter = {}): AuditRow[] {
    return this.handle
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
    this.handle.prepare('VACUUM INTO ?').run(file);
  }

  /** Starts a deploy's history row as `running`; returns its id. Throws, so a deploy isn't started unrecorded. */
  startDeploy(d: Pick<DeployRow, 'part' | 'target' | 'from' | 'to' | 'by'>, started = Date.now()): number {
    const r = this.handle
      .prepare("INSERT INTO deploys (part, target, from_tag, to_tag, by, started, outcome, log) VALUES (?, ?, ?, ?, ?, ?, 'running', '')")
      .run(d.part, d.target, d.from, d.to, d.by, started);
    return Number(r.lastInsertRowid);
  }

  /** Closes a running deploy's row with its outcome; a row already closed stays as it is. */
  finishDeploy(id: number, outcome: Exclude<DeployOutcome, 'running'>, log: string, finished = Date.now()): void {
    this.write('finish deploy', "UPDATE deploys SET outcome = ?, log = ?, finished = ? WHERE id = ? AND outcome = 'running'", outcome, log, finished, id);
  }

  /** Rewrites a deploy closed `ok` with how it really ended (an Agent's own deploy, after its hello); any other row stays. */
  amendDeploy(id: number, outcome: Exclude<DeployOutcome, 'running'>, log: string, finished = Date.now()): void {
    this.write('amend deploy', "UPDATE deploys SET outcome = ?, log = ?, finished = ? WHERE id = ? AND outcome = 'ok'", outcome, log, finished, id);
  }

  /** The newest `limit` deploys, newest first: only those older than the row `before`, of `part`, with `outcome` (`running`: still running). */
  deploys(limit: number, { before, part, outcome, running }: { before?: number; part?: DeployRow['part']; outcome?: DeployOutcome; running?: true } = {}): DeployRow[] {
    return this.handle
      .prepare(
        `SELECT id, part, target, from_tag AS "from", to_tag AS "to", by, started, finished, outcome, log FROM deploys
         WHERE (?1 IS NULL OR id < ?1) AND (?2 IS NULL OR part = ?2) AND (?3 IS NULL OR outcome = ?3) ORDER BY id DESC LIMIT ?4`,
      )
      .all(before ?? null, part ?? null, running ? 'running' : (outcome ?? null), limit)
      .map((r) => ({ ...r }) as DeployRow);
  }
}

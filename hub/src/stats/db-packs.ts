// `Db`'s packs layer (over `db-links.ts`): `packs` (a server's pack row; `packs.library_id`, a nullable column added
// since, see `db-base.ts`: `packsOf`, `unlinkedPacks`, `setPackLibrary`), the manifest in `pack_files` with whether the
// pack ships each file, `extras`, `config_edits`, `pack_updates` and, for an install's id, `hasPackData`/`deletePackData`
// (its pack row, manifest, Extras and edits), with their row types. Their writes throw, as `startDeploy` does, but
// `setPackUpdate`.

import type { PackOutcome, PackStep } from '../types.ts';
import { LinksDb } from './db-links.ts';

/** `Db`'s packs: rows, manifests, Extras, Config edits and pack updates. */
export class PacksDb extends LinksDb {
  // Packs. These writes throw: an admin's change must not be reported as done when it wasn't stored.

  pack(serverId: string): PackRow | undefined {
    const r = this.handle.prepare('SELECT name, version, source, sha256, by, at, how, snapshot, library_id AS libraryId FROM packs WHERE server_id = ?').get(serverId);
    return r && ({ ...r } as PackRow);
  }

  /** The servers whose pack row is a library entry. */
  packsOf(libraryId: number): string[] {
    return this.handle.prepare('SELECT server_id FROM packs WHERE library_id = ? ORDER BY server_id').all(libraryId).map((r) => r.server_id as string);
  }

  /** Pack rows linked to no library entry (none yet, written by an older hub, or the entry gone), with their zip's sha256. */
  unlinkedPacks(): { serverId: string; sha256: string }[] {
    return this.handle
      .prepare('SELECT server_id AS serverId, sha256 FROM packs WHERE library_id IS NULL OR library_id NOT IN (SELECT id FROM library)')
      .all()
      .map((r) => ({ ...r }) as { serverId: string; sha256: string });
  }

  /** Points a server's pack row at a library entry (moving `packs/` over). */
  setPackLibrary(serverId: string, libraryId: number): void {
    this.handle.prepare('UPDATE packs SET library_id = ? WHERE server_id = ?').run(libraryId, serverId);
  }

  /** Writes a server's pack row and manifest (`files`; `own`: those the pack itself ships) at once. */
  setPack(serverId: string, p: PackRow, files: string[], own: Set<string>): void {
    this.handle.exec('BEGIN');
    try {
      this.handle
        .prepare('INSERT OR REPLACE INTO packs (server_id, name, version, source, sha256, by, at, how, snapshot, library_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(serverId, p.name, p.version, p.source, p.sha256, p.by, p.at, p.how, p.snapshot, p.libraryId);
      this.handle.prepare('DELETE FROM pack_files WHERE server_id = ?').run(serverId);
      const add = this.handle.prepare('INSERT INTO pack_files (server_id, path, pack) VALUES (?, ?, ?)');
      for (const f of files) add.run(serverId, f, own.has(f) ? 1 : 0);
      this.handle.exec('COMMIT');
    } catch (err) {
      this.handle.exec('ROLLBACK');
      throw err;
    }
  }

  /** The manifest: every file the last apply wrote, sorted (`own`: only those the pack itself ships). */
  packFiles(serverId: string, own = false): string[] {
    return this.handle
      .prepare('SELECT path FROM pack_files WHERE server_id = ? AND pack >= ? ORDER BY path')
      .all(serverId, own ? 1 : 0)
      .map((r) => r.path as string);
  }

  extras(serverId: string): ExtraRow[] {
    return this.handle
      .prepare('SELECT id, target, sha256, label, note, by, at, removed FROM extras WHERE server_id = ? ORDER BY target')
      .all(serverId)
      .map((r) => ({ ...r, removed: r.removed === 1 }) as ExtraRow);
  }

  addExtra(serverId: string, e: Omit<ExtraRow, 'id' | 'removed'>): number {
    const r = this.handle
      .prepare('INSERT INTO extras (server_id, target, sha256, label, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(serverId, e.target, e.sha256, e.label, e.note, e.by, e.at);
    return Number(r.lastInsertRowid);
  }

  updateExtra(id: number, e: Pick<ExtraRow, 'sha256' | 'label' | 'note' | 'removed'>): void {
    this.handle.prepare('UPDATE extras SET sha256 = ?, label = ?, note = ?, removed = ? WHERE id = ?').run(e.sha256, e.label, e.note, e.removed ? 1 : 0, id);
  }

  deleteExtra(id: number): void {
    this.handle.prepare('DELETE FROM extras WHERE id = ?').run(id);
  }

  /** A server's Config edits, in the order they were added (the order they run in). */
  configEdits(serverId: string): EditRow[] {
    return this.handle
      .prepare('SELECT id, path, find, replace, note, by, at, failed_on AS failedOn FROM config_edits WHERE server_id = ? ORDER BY id')
      .all(serverId)
      .map((r) => ({ ...r }) as EditRow);
  }

  addEdit(serverId: string, e: Omit<EditRow, 'id' | 'failedOn'>): number {
    const r = this.handle
      .prepare('INSERT INTO config_edits (server_id, path, find, replace, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(serverId, e.path, e.find, e.replace, e.note, e.by, e.at);
    return Number(r.lastInsertRowid);
  }

  updateEdit(id: number, e: Pick<EditRow, 'path' | 'find' | 'replace' | 'note' | 'failedOn'>): void {
    this.handle.prepare('UPDATE config_edits SET path = ?, find = ?, replace = ?, note = ?, failed_on = ? WHERE id = ?').run(e.path, e.find, e.replace, e.note, e.failedOn, id);
  }

  deleteEdit(id: number): void {
    this.handle.prepare('DELETE FROM config_edits WHERE id = ?').run(id);
  }

  /** Starts a pack update's history row as `running` in Prepare; returns its id. */
  startPackUpdate(serverId: string, u: Pick<PackUpdateDbRow, 'from' | 'to' | 'changes' | 'by' | 'started'>): number {
    const r = this.handle
      .prepare("INSERT INTO pack_updates (server_id, from_version, to_version, changes, by, started, outcome, step, log) VALUES (?, ?, ?, ?, ?, ?, 'running', 'prepare', '')")
      .run(serverId, u.from, u.to, u.changes === null ? null : JSON.stringify(u.changes), u.by, u.started);
    return Number(r.lastInsertRowid);
  }

  /** Changes a pack update's row; never throws (the update goes on). */
  setPackUpdate(id: number, u: Partial<Pick<PackUpdateDbRow, 'finished' | 'outcome' | 'step' | 'backup' | 'log' | 'restored'>>): void {
    const columns = { finished: 'finished', outcome: 'outcome', step: 'step', backup: 'backup', log: 'log', restored: 'restored' } as const;
    const keys = Object.keys(u) as (keyof typeof columns)[];
    if (!keys.length) return;
    this.write('pack update', `UPDATE pack_updates SET ${keys.map((k) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => u[k] ?? null), id);
  }

  /** A server's pack updates, newest first (`serverId` undefined: every server's still running). */
  packUpdates(serverId: string | undefined, limit: number): PackUpdateDbRow[] {
    return this.handle
      .prepare(
        `SELECT id, server_id AS serverId, from_version AS "from", to_version AS "to", changes, by, started, finished, outcome, step, backup, log, restored
         FROM pack_updates WHERE (?1 IS NULL AND outcome = 'running') OR server_id = ?1 ORDER BY id DESC LIMIT ?2`,
      )
      .all(serverId ?? null, limit)
      .map((r) => ({ ...r, changes: r.changes === null ? null : JSON.parse(r.changes as string) }) as PackUpdateDbRow);
  }

  /** Whether any pack data is stored under a server id (a pack row, Extras or Config edits). */
  hasPackData(serverId: string): boolean {
    return ['packs', 'pack_files', 'extras', 'config_edits'].some((t) => this.handle.prepare(`SELECT 1 FROM ${t} WHERE server_id = ? LIMIT 1`).get(serverId) !== undefined);
  }

  /** Deletes a server id's pack row, manifest, Extras and Config edits (a failed install or a discarded Pending server). */
  deletePackData(serverId: string): void {
    this.handle.exec('BEGIN');
    try {
      for (const t of ['packs', 'pack_files', 'extras', 'config_edits']) this.handle.prepare(`DELETE FROM ${t} WHERE server_id = ?`).run(serverId);
      this.handle.exec('COMMIT');
    } catch (err) {
      this.handle.exec('ROLLBACK');
      throw err;
    }
  }
}

/** A server's installed pack as stored; `snapshot` is what the last apply laid over it, as JSON. */
export type PackRow = {
  name: string;
  version: string;
  source: string;
  sha256: string;
  by: string;
  at: number;
  how: 'adopted' | 'updated' | 'installed';
  snapshot: string;
  /** Its library entry; null when it has none (from before the library, until `packs/` is moved over). */
  libraryId: number | null;
};
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

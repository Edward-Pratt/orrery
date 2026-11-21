// `Db`'s pack library layer (over `db-packs.ts`): the library (`library`, `addLibraryEntry`, `deleteLibraryEntry`;
// unique on name and version, and on sha256), Java runtimes (`runtimes`, `addRuntime`, `deleteRuntime`) and Pending
// servers (`pending_servers`: `pendingServers`, `addPendingServer`, `deletePendingServer`), with their row types.
// Their writes throw, as the packs' do.

import { PacksDb } from './db-packs.ts';

/** `Db`'s pack library, Java runtimes and Pending servers. */
export class LibraryDb extends PacksDb {
  // The pack library. Its writes throw, as the packs' do.

  /** Every library entry, newest first. */
  library(): LibraryRow[] {
    return this.handle
      .prepare('SELECT id, name, version, mc, loader, sha256, size, source, by, at FROM library ORDER BY at DESC, id DESC')
      .all()
      .map((r) => ({ ...r }) as LibraryRow);
  }

  addLibraryEntry(e: Omit<LibraryRow, 'id'>): number {
    const r = this.handle
      .prepare('INSERT INTO library (name, version, mc, loader, sha256, size, source, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.name, e.version, e.mc, e.loader, e.sha256, e.size, e.source, e.by, e.at);
    return Number(r.lastInsertRowid);
  }

  deleteLibraryEntry(id: number): void {
    this.handle.prepare('DELETE FROM library WHERE id = ?').run(id);
  }

  /** Every installed Java runtime, newest first. */
  runtimes(): RuntimeRow[] {
    return this.handle
      .prepare('SELECT name, feature, size, sha256, by, at FROM runtimes ORDER BY at DESC, name DESC')
      .all()
      .map((r) => ({ ...r }) as RuntimeRow);
  }

  addRuntime(r: RuntimeRow): void {
    this.handle.prepare('INSERT INTO runtimes (name, feature, size, sha256, by, at) VALUES (?, ?, ?, ?, ?, ?)').run(r.name, r.feature, r.size, r.sha256, r.by, r.at);
  }

  deleteRuntime(name: string): void {
    this.handle.prepare('DELETE FROM runtimes WHERE name = ?').run(name);
  }

  // Pending servers: installed, not in config yet. Their writes throw.

  pendingServers(): PendingRow[] {
    return this.handle
      .prepare('SELECT id, name, dir, token, unit, game_port AS gamePort, runtime, by, at FROM pending_servers ORDER BY at, id')
      .all()
      .map((r) => ({ ...r }) as PendingRow);
  }

  addPendingServer(p: PendingRow): void {
    this.handle
      .prepare('INSERT INTO pending_servers (id, name, dir, token, unit, game_port, runtime, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, p.name, p.dir, p.token, p.unit, p.gamePort, p.runtime, p.by, p.at);
  }

  deletePendingServer(id: string): void {
    this.handle.prepare('DELETE FROM pending_servers WHERE id = ?').run(id);
  }
}

/** A Java runtime in the library; its JDK is `<root>/runtimes/<name>/`. `feature`: 8, 17, 21 or 25; `size`: the tarball's. */
export type RuntimeRow = { name: string; feature: number; size: number; sha256: string; by: string; at: number };
/** A Pending server: its folder, Mod token, unit name, game port and Java runtime (null: system java). */
export type PendingRow = { id: string; name: string; dir: string; token: string; unit: string; gamePort: number; runtime: string | null; by: string; at: number };
/** A pack version in the library; its zip is `<root>/library/<sha256>.zip`. */
export type LibraryRow = { id: number; name: string; version: string; mc: string; loader: string; sha256: string; size: number; source: string; by: string; at: number };

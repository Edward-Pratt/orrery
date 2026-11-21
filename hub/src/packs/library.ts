// `Library`, with packs (one per Environment): the state the flows share (`LibraryCtx`, `library-ctx.ts`, with the
// add's progress, end and events), the start and stop, and the public API, each method a call into the flow that does
// it: pack versions (`library-entries.ts`: `addPack`, the move of `packs/` and the relink), Java runtimes
// (`library-runtimes.ts`: `addRuntime`, `deleteRuntime`, `runtime(name)`), downloads and Actions artifacts
// (`library-download.ts`); this file re-exports the names callers import from it. `start` (clears adds' leftovers,
// `library/.add-*` and `work/runtime-*`, then moves `packs/` in and relinks); `state` (the entries newest first, each
// with `usedBy`: the servers whose pack row is it or whose running update installs it; `runtimes` with each one's
// linked servers; and the running add); `cancel` (until it is being stored; removes what it wrote); `deletePack` (409
// naming the servers while used), `entry(id)`, `zip(id)` and `busy` (a hub deploy and an install wait); adds are
// refused (409) while a New server install runs. Each add is audited at its start and end (`library add`, `library
// runtime add`), cancels and deletes too (target `library`), and posts `libraryAdd` target events. `LibraryRefused`
// (400/404/409). Hub core.

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibraryPack, LibraryRuntime, LibraryState } from '../api.ts';
import type { Db, LibraryRow, RuntimeRow } from '../stats/db.ts';
import type { ServerHub } from '../servers/servers.ts';
import type { Uploads } from './uploads.ts';
import { LibraryRefused, type LibraryCtx } from './library-ctx.ts';
import type { Fetch } from './library-download.ts';
import { moveOver, relink, startPack, TEMP } from './library-entries.ts';
import { deleteRuntime, linkedTo, runtime, startRuntime } from './library-runtimes.ts';

export { LibraryRefused } from './library-ctx.ts';
export { download, type Fetch } from './library-download.ts';
export { detect } from './library-entries.ts';
export { FEATURES, RUNTIME } from './library-runtimes.ts';

export type LibraryDeps = {
  hub: Pick<ServerHub, 'publishTarget' | 'audit'>;
  db: Db;
  /** Finished uploads, taken as a source. */
  uploads: Pick<Uploads, 'get' | 'take'>;
  /** The Environment's root (the folder holding `hub.db`): zips live in `<root>/library/<sha256>.zip`. */
  root: string;
  /** Downloads' HTTP requests. */
  download: Fetch;
  /** `GITHUB_TOKEN`, for Actions artifacts; sent only to api.github.com. */
  githubToken?: string;
  /** The servers whose running pack update installs an entry. */
  installing: (id: number) => string[];
  /** Whether a New server install runs: adds wait for it. */
  installRunning: () => boolean;
  /** Node's name for this host's architecture (default `process.arch`), for tests. */
  arch?: string;
};

/**
 * The Environment's Pack library: pack versions stored by sha256 under `<root>/library/`, named and versioned in the
 * `library` table. One add at a time, in the background, announced as `libraryAdd` events; adds are lost on a hub
 * restart. Hub core.
 */
export class Library {
  #d: LibraryDeps;
  #c: LibraryCtx; // what the library flows share with this (`library-ctx.ts`)

  constructor(deps: LibraryDeps) {
    this.#d = deps;
    this.#c = { d: deps, dir: join(deps.root, 'library'), add: undefined, next: 1, closed: false };
  }

  /** Clears what adds left when the last hub stopped, and moves the zips of `packs/` (from before the library) in. */
  async start(): Promise<void> {
    for (const f of await readdir(this.#c.dir).catch(() => [])) if (f.startsWith(TEMP)) await rm(join(this.#c.dir, f), { force: true });
    const work = join(this.#d.root, 'work');
    for (const f of await readdir(work).catch(() => [])) if (f.startsWith('runtime-')) await rm(join(work, f), { recursive: true, force: true });
    await moveOver(this.#c);
    relink(this.#c);
  }

  stop(): void {
    this.#c.closed = true;
    this.#c.add?.abort.abort();
  }

  /** Whether an add runs (a hub deploy waits for it). */
  busy(): boolean {
    return this.#c.add !== undefined;
  }

  state(): LibraryState {
    const a = this.#c.add;
    return {
      packs: this.#d.db.library().map((r): LibraryPack => ({ ...r, usedBy: this.#usedBy(r.id) })),
      runtimes: this.#d.db.runtimes().map((r): LibraryRuntime => ({ ...r, label: `Temurin ${r.name.slice('temurin-'.length)}`, usedBy: linkedTo(this.#c, r.name) })),
      running: a ? { add: a.add, kind: a.kind, name: a.name, version: a.version, by: a.by, started: a.started, detail: a.detail } : null,
    };
  }

  /** An entry, or undefined for an unknown id. */
  entry(id: number): LibraryRow | undefined {
    return this.#d.db.library().find((r) => r.id === id);
  }

  /** An entry's zip; 404 for an unknown id. */
  zip(id: number): string {
    return join(this.#c.dir, `${this.#entry(id).sha256}.zip`);
  }

  /** Starts adding a pack version from a URL or a finished upload; returns its add number at once. */
  addPack(body: unknown, by: string, byName: string): number {
    return startPack(this.#c, body, by, byName);
  }

  /** A runtime, or undefined. */
  runtime(name: string): RuntimeRow | undefined {
    return runtime(this.#c, name);
  }

  /** Starts adding the latest GA Temurin JDK of a Java version for this host; returns its add number at once. */
  addRuntime(body: unknown, by: string, byName: string): number {
    return startRuntime(this.#c, body, by, byName);
  }

  /** Deletes a runtime; refused (409, naming them) while a server's Java link points at it. */
  deleteRuntime(name: string, by: string): Promise<void> {
    return deleteRuntime(this.#c, name, by);
  }

  /** Stops the running add, leaving nothing behind; too late once it is being stored. */
  cancel(by: string): void {
    const a = this.#c.add;
    if (!a) throw new LibraryRefused(409, 'No add is running.');
    if (a.storing) throw new LibraryRefused(409, 'Too late to cancel: it is being stored.');
    this.#d.hub.audit(by, 'library cancel', 'library', `${a.name} ${a.version}`);
    a.cancelled = true;
    a.abort.abort();
  }

  /** Deletes an entry and its zip; refused (409, naming them) while a server's pack is it or an update installs it. */
  async deletePack(id: number, by: string): Promise<void> {
    const e = this.#entry(id);
    const users = this.#usedBy(id);
    if (users.length) throw new LibraryRefused(409, `${e.name} ${e.version} is used by ${users.join(', ')}.`);
    this.#d.db.deleteLibraryEntry(id);
    await rm(join(this.#c.dir, `${e.sha256}.zip`), { force: true });
    this.#d.hub.audit(by, 'library delete', 'library', `${e.name} ${e.version}`);
  }

  /** The servers using an entry: their pack is it, or their running update installs it. */
  #usedBy(id: number): string[] {
    return [...new Set([...this.#d.db.packsOf(id), ...this.#d.installing(id)])].sort();
  }

  #entry(id: number): LibraryRow {
    const e = this.entry(id);
    if (!e) throw new LibraryRefused(404, 'No such pack in the library.');
    return e;
  }
}

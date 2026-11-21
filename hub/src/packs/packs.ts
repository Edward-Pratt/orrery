// `Packs`, for a server with a folder, a linked service and a Mod token (`has`; others 404): the state the flows share
// (`PacksCtx`, `pack-ctx.ts`), the start and stop, and the public API, each method a call into the flow that does it:
// `state`, `setRuntime`, `rollback`, `restored` (`pack-state.ts`); `compare`/`adopt` (`pack-compare.ts`); Extras and
// Config edits (`pack-extras.ts`); `update` and `cancel` (`pack-update.ts`, its job's steps and waits `pack-job.ts`);
// New server: `install`, `pending()`, `discard(id)` (`pack-install.ts`), `installRunning()`; `busy`,
// `installing(libraryId)` (a running install's entry too) (the servers whose running update installs an entry: it
// can't be deleted). The pack zip's checks are `pack-zip.ts`'s, the request paths and Kept paths `pack-paths.ts`'s;
// this file re-exports the names callers import from it. At start: Compare's scratch (`work/<server>/`) is cleared; a
// Pending server whose id is in config with the same folder is a server (its row and pending file go; another folder
// is logged and left); an install the last hub left running (`work/installing.json` names its id) is removed; and a
// `running` `pack_updates` row left by a restart is closed as interrupted, but a factorio server's: a game update's
// row is `GameUpdates`'. Packs never deletes or moves a library zip. Hub core.

import { readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CompareReport, EditPreview, PackRollback, PackState, PendingServers } from '../api.ts';
import type { ServerSettings } from '../config.ts';
import type { Db } from '../stats/db.ts';
import type { Deploys } from '../updates/deploys.ts';
import type { Library } from './library.ts';
import type { RestartScheduler } from '../servers/restarts.ts';
import type { HubEvent, ServerHub } from '../servers/servers.ts';
import type { Services } from '../services/services.ts';
import type { Uploads } from './uploads.ts';
import type { Compared } from './pack-compare.ts';
import { adopt, compare } from './pack-compare.ts';
import { has, installMarker, settings, work, type PacksCtx } from './pack-ctx.ts';
import { addEdit, addExtra, previewEdit, removeEdit, removeExtra, updateEdit, updateExtra } from './pack-extras.ts';
import { discard, PENDING_FILE, pendingServers, removeInstall, SERVER_ID, startInstall } from './pack-install.ts';
import type { Job } from './pack-job.ts';
import { PRE, UPDATE } from './pack-paths.ts';
import { restored, rollbackOffer, setRuntime, state } from './pack-state.ts';
import { cancelUpdate, startUpdate } from './pack-update.ts';

export { SERVER_ID } from './pack-install.ts';
export { PackRefused } from './pack-paths.ts';
export { contentRoot, LOOP, sha256File, startScripts, zipEntries } from './pack-zip.ts';

/** Shortened in tests. */
export type PacksOptions = {
  /** How long the health gate waits for the Mod's hello (10 min). */
  gateMs?: number;
  /** How long the backup may take (30 min). */
  backupMs?: number;
  /** How often a stopping unit is read again (2 s). */
  pollMs?: number;
  /** How long a stop (countdown included) may take (15 min). */
  stopMs?: number;
  /** How long a Compare is held for Adopt (1 h). */
  compareMs?: number;
};

export type PacksDeps = {
  hub: Pick<ServerHub, 'get' | 'on' | 'off' | 'publish' | 'publishTarget' | 'audit' | 'backup'>;
  db: Db;
  services: Pick<Services, 'ofServer' | 'act' | 'read' | 'environment'>;
  restarts: Pick<RestartScheduler, 'cancel' | 'pending'>;
  servers: ServerSettings[];
  hasMod: (serverId: string) => boolean;
  /** The Environment's root (the folder holding `hub.db`): Compare's scratch (`work/<server>/`) and the Extras live under it. */
  dataDir: string;
  /** Finished uploads, taken as an Extra. */
  uploads: Pick<Uploads, 'get' | 'take'>;
  /** Where every pack comes from: Compare, Adopt and updates install a library entry's zip. */
  library: Pick<Library, 'entry' | 'zip' | 'runtime' | 'busy'>;
  /** Whether a restore runs on a server. */
  restoring: (serverId: string) => boolean;
  /** What deploy runs that a pack update on a server must wait for: a hub deploy, or a Mod deploy onto it. */
  deploying: (serverId: string) => 'hub' | 'mod' | null;
  /** New server, only with GitHub on: the Mod's releases, the hub's own unit (for the setup command) and its Mod port. */
  install?: {
    mods: Pick<Deploys, 'modBuild' | 'download'>;
    hubUnit: string;
    hubPort: number;
    /** Whether systemd knows a unit, loaded or not. */
    unitExists: (unit: string) => Promise<boolean>;
  };
};

/**
 * Server packs: the installed pack, its manifest, Extras, Config edits and changes pending; Adopt; pack updates (Prepare,
 * Backup, Stop, Swap, health gate, rollback), one per server, recorded in `pack_updates`, audited and announced as
 * `packUpdate*` notices. Only for a server with a folder, a linked service and a Mod token. Hub core.
 */
export class Packs {
  #d: PacksDeps;
  #c: PacksCtx; // what the pack flows share with this (`pack-ctx.ts`)
  #compared = new Map<string, Compared>();
  #jobs = new Map<string, Job>();
  /** Stops each wait and ticker without resolving it: a closing hub leaves a running update as a crash would. */
  #halts = new Set<() => void>();
  /** Servers whose Java runtime changed since their last start. ponytail: in memory, so a hub restart forgets it; a table if that matters. */
  #runtimeChanged = new Set<string>();
  #started = (e: HubEvent) => {
    if (e.type === 'connected') this.#runtimeChanged.delete(e.serverId);
  };

  constructor(deps: PacksDeps, o: PacksOptions = {}) {
    this.#d = deps;
    this.#c = {
      d: deps,
      o: { gateMs: 10 * 60_000, backupMs: 30 * 60_000, pollMs: 2_000, stopMs: 15 * 60_000, compareMs: 60 * 60_000, ...o },
      compared: this.#compared,
      jobs: this.#jobs,
      halts: this.#halts,
      runtimeChanged: this.#runtimeChanged,
      install: undefined,
      closed: false,
    };
  }

  /**
   * Clears Compare's leftover scratch, and closes the updates the last hub left running as interrupted, but a factorio
   * server's (game updates: `GameUpdates`').
   */
  async start(): Promise<void> {
    const c = this.#c;
    this.#d.hub.on('event', this.#started);
    // A Pending server whose id is in config now: the setup script ran, so it is a server.
    for (const p of this.#d.db.pendingServers()) {
      const s = settings(c, p.id);
      if (!s) continue;
      if (s.dir && resolve(s.dir) === resolve(p.dir)) {
        this.#d.db.deletePendingServer(p.id);
        await rm(join(p.dir, PENDING_FILE), { force: true });
        console.log(`[packs] ${p.id} is a server now`);
      } else console.warn(`[packs] ${p.id} is in config with another folder (${s.dir ?? 'none'}) than its Pending server's (${p.dir}): left as it is`);
    }
    // An install the last hub left running (it stopped or crashed): what it wrote goes, unless it got as far as a server.
    const marker = await readFile(installMarker(c), 'utf8').catch(() => undefined);
    const left = marker === undefined ? undefined : (JSON.parse(marker) as { id?: unknown }).id;
    if (typeof left === 'string' && SERVER_ID.test(left) && !settings(c, left) && !this.#d.db.pendingServers().some((p) => p.id === left)) {
      await removeInstall(c, left);
      console.log(`[packs] removed ${left}'s install, interrupted by the hub's restart`);
    }
    await rm(installMarker(c), { force: true });
    await rm(join(this.#d.dataDir, 'work', 'install'), { recursive: true, force: true });
    // `downloads/` and `staging/` are from before the library (#139).
    for (const old of ['downloads', 'staging']) await rm(join(this.#d.dataDir, old), { recursive: true, force: true });
    for (const s of this.#d.servers) await rm(work(c, s.id), { recursive: true, force: true });
    for (const row of this.#d.db.packUpdates(undefined, 1000)) {
      // A factorio server's rows are game updates, which GameUpdates closes: an Agent runs every factorio server.
      if (settings(c, row.serverId)?.game === 'factorio') continue;
      const dir = settings(c, row.serverId)?.dir;
      const swapped = ['swap', 'gate', 'rollback'].includes(row.step);
      const pre = swapped && dir ? (await readdir(dir).catch(() => [])).filter((f) => f.startsWith(PRE)).sort().at(-1) : undefined;
      if (dir && !swapped) await rm(join(dir, UPDATE), { recursive: true, force: true });
      const why = `interrupted during ${row.step}: the hub restarted${pre ? `. The old files are in ${pre}/` : ''}`;
      this.#d.db.setPackUpdate(row.id, { outcome: 'failed', finished: Date.now(), log: [row.log, why].filter(Boolean).join('\n') });
    }
  }

  stop(): void {
    this.#c.closed = true;
    this.#d.hub.off('event', this.#started);
    for (const halt of this.#halts) halt();
  }

  /** Whether a server can have a pack: a folder, a linked service and a Mod token. */
  has(serverId: string): boolean {
    return has(this.#c, serverId);
  }

  /** Whether a pack update runs on a server (`serverId` undefined: on any). */
  busy(serverId?: string): boolean {
    return serverId === undefined ? this.#jobs.size > 0 : this.#jobs.has(serverId);
  }

  /** The servers whose running update or install installs a library entry (it can't be deleted meanwhile). */
  installing(libraryId: number): string[] {
    const install = this.#c.install?.libraryId === libraryId ? [this.#c.install.id] : [];
    return [...[...this.#jobs.values()].filter((j) => j.libraryId === libraryId).map((j) => j.serverId), ...install];
  }

  /** Whether a New server install runs (a hub deploy and a library add wait for it). */
  installRunning(): boolean {
    return this.#c.install !== undefined;
  }

  /** The Pending servers, oldest first, each with its setup command, and the running install. */
  pending(): PendingServers {
    return pendingServers(this.#c);
  }

  /**
   * Starts installing a library pack as a new server in `<root>/servers/<id>`, and resolves with its id once every check
   * passed; the install runs in the background, announced as `install` events, and ends as a Pending server. Refused
   * (`PackRefused`) before anything is written.
   */
  install(body: Record<string, unknown>, by: string, byName: string): Promise<string> {
    return startInstall(this.#c, body, by, byName);
  }

  /** Deletes a Pending server: its folder, Java link, pack data and row. Refused (409) once its id is in config. */
  discard(id: string, by: string): Promise<void> {
    return discard(this.#c, id, by);
  }

  /** The restore offer after the server's latest update rolled back; null otherwise. */
  rollback(serverId: string): PackRollback | null {
    return rollbackOffer(this.#c, serverId);
  }

  /** A restore ran on the server: the rollback offer is done with. */
  restored(serverId: string): void {
    restored(this.#c, serverId);
  }

  state(serverId: string): Promise<PackState> {
    return state(this.#c, serverId);
  }

  /**
   * Sets the Java a server runs on from its next start: its link `<root>/java/<server>` swapped atomically to a runtime
   * (a new link renamed over it), or removed for the host's own `java` (`name` null).
   */
  setRuntime(serverId: string, name: unknown, by: string): Promise<PackState> {
    return setRuntime(this.#c, serverId, name, by);
  }

  /** Compares a pack with the server folder; held for `adopt`. Refused once the server has a pack. */
  compare(serverId: string, source: unknown, by: string): Promise<CompareReport> {
    return compare(this.#c, serverId, source, by);
  }

  /** Records the compared pack as installed, keeping the given report paths as Extras. Changes nothing in the server folder. */
  adopt(serverId: string, keep: unknown, by: string, byName: string): Promise<PackState> {
    return adopt(this.#c, serverId, keep, by, byName);
  }

  addExtra(serverId: string, body: Record<string, unknown>, by: string, byName: string): Promise<PackState> {
    return addExtra(this.#c, serverId, body, by, byName);
  }

  updateExtra(serverId: string, extraId: number, body: Record<string, unknown>, by: string): Promise<PackState> {
    return updateExtra(this.#c, serverId, extraId, body, by);
  }

  /** Marks an Extra removed until the next apply; one never applied goes at once. */
  removeExtra(serverId: string, extraId: number, by: string): Promise<PackState> {
    return removeExtra(this.#c, serverId, extraId, by);
  }

  addEdit(serverId: string, body: Record<string, unknown>, by: string, byName: string): Promise<PackState> {
    return addEdit(this.#c, serverId, body, by, byName);
  }

  updateEdit(serverId: string, editId: number, body: Record<string, unknown>, by: string): Promise<PackState> {
    return updateEdit(this.#c, serverId, editId, body, by);
  }

  removeEdit(serverId: string, editId: number, by: string): Promise<PackState> {
    return removeEdit(this.#c, serverId, editId, by);
  }

  /** How many lines of the file on the server now `find` matches in. */
  previewEdit(serverId: string, path: unknown, find: unknown): Promise<EditPreview> {
    return previewEdit(this.#c, serverId, path, find);
  }

  /**
   * Starts a pack update onto a new pack, or applies the changes pending onto the installed one, and resolves with its
   * history row's id at once; the steps run in the background. Refused (`PackRefused`) unless it can run now.
   */
  update(serverId: string, source: unknown, by: string, byName: string): number {
    return startUpdate(this.#c, serverId, source, by, byName);
  }

  /** Cancels a running update while nothing has been touched: in Prepare, or during the Stop countdown. */
  cancel(serverId: string, by: string, byName: string): void {
    cancelUpdate(this.#c, serverId, by, byName);
  }
}

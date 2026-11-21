// What the pack flows outside the class share with `Packs` (`PacksCtx`): its deps and options, its maps and sets (by
// reference), the running install and whether the hub is closing (both read and written here, so `stop()` reaches a
// running update); and the lookups they all use: a server's settings, whether it can have a pack (`has`: a folder, a
// linked service and a Mod token; else 404), one with an adopted pack and no update running (else 409), why an update
// can't start now (`blockedReason`: an update, a restore, a Mod or hub deploy, a countdown), the folders under the
// Environment's root (`extras/<server>/`, `java/<server>`, `work/<server>/`, `servers/<id>`, `work/installing.json`)
// and a source (`{ library: <id> }`, an entry in the library). Hub core.

import { join } from 'node:path';
import type { ServerSettings } from '../config.ts';
import type { LibraryRow } from '../stats/db.ts';
import type { Compared } from './pack-compare.ts';
import type { Install } from './pack-install.ts';
import type { Job } from './pack-job.ts';
import { PackRefused } from './pack-paths.ts';
import type { PacksDeps, PacksOptions } from './packs.ts';

/** What the pack flows need of `Packs`: see the header. */
export type PacksCtx = {
  d: PacksDeps;
  o: Required<PacksOptions>;
  // The class's own, by reference: see `Packs`.
  compared: Map<string, Compared>;
  jobs: Map<string, Job>;
  halts: Set<() => void>;
  runtimeChanged: Set<string>;
  install: Install | undefined;
  closed: boolean;
};

export function settings(c: PacksCtx, serverId: string): ServerSettings | undefined {
  return c.d.servers.find((s) => s.id === serverId);
}

export function has(c: PacksCtx, serverId: string): boolean {
  return Boolean(settings(c, serverId)?.dir && c.d.services.ofServer(serverId) && c.d.hasMod(serverId));
}

/** A server that can have a pack, else 404. */
export function server(c: PacksCtx, serverId: string): ServerSettings {
  if (!has(c, serverId)) throw new PackRefused(404, 'No such server, or it has no pack.');
  return settings(c, serverId)!;
}

/** A server with an adopted pack and no update running, else 404 or 409: Extras and edits change only between updates. */
export function adopted(c: PacksCtx, serverId: string): ServerSettings {
  const s = server(c, serverId);
  if (!c.d.db.pack(serverId)) throw new PackRefused(409, `orrery doesn't know ${s.name}'s pack yet: adopt it first.`);
  if (c.jobs.has(serverId)) throw new PackRefused(409, `A pack update is running on ${s.name}: change Extras and edits once it is done.`);
  return s;
}

export function blockedReason(c: PacksCtx, serverId: string, name: string): string | null {
  if (c.jobs.has(serverId)) return `A pack update is running on ${name}.`;
  if (c.d.restoring(serverId)) return `A restore is running on ${name}.`;
  const deploy = c.d.deploying(serverId);
  if (deploy === 'mod') return `A Mod deploy onto ${name} is running.`;
  if (deploy === 'hub') return 'A hub deploy is running.';
  // Its Stop would clash with the countdown (`CountdownRunning`), after the backup.
  if (c.d.restarts.pending(serverId)) return `A countdown is running on ${name}: cancel it first.`;
  return null;
}

export function extrasDir(c: PacksCtx, serverId: string): string {
  return join(c.d.dataDir, 'extras', serverId);
}

/** A server's Java link, which its unit names in `PATH` and `JAVA_HOME`. */
export function javaLink(c: PacksCtx, serverId: string): string {
  return join(c.d.dataDir, 'java', serverId);
}

/** Compare's scratch folder for a server. */
export function work(c: PacksCtx, serverId: string): string {
  return join(c.d.dataDir, 'work', serverId);
}

export function serverDir(c: PacksCtx, id: string): string {
  return join(c.d.dataDir, 'servers', id);
}

/** Names the running install's id, so the next hub can clean up after a crash. */
export function installMarker(c: PacksCtx): string {
  return join(c.d.dataDir, 'work', 'installing.json');
}

/** A source: `{ library: <id> }`, an entry in the library. */
export function sourceEntry(c: PacksCtx, raw: unknown): LibraryRow {
  const id = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!Number.isSafeInteger(id.library) || (id.library as number) < 1) throw new PackRefused(400, 'Pick a pack version from the library.');
  const entry = c.d.library.entry(id.library as number);
  if (!entry) throw new PackRefused(404, 'No such pack in the library.');
  return entry;
}

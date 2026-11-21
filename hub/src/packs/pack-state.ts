// A server's pack as `Packs` answers it: `state` (`PackState`: the installed pack, Kept paths (`keep`, then the
// built-in ones, `pack-paths.ts`), Extras, Config edits, pending changes, history (the last 50), the running update
// with its steps, `blocked`, the rollback offer); the rollback offer (`rollbackOffer`: after the server's latest update
// rolled back, until `restored`, as a restore ran); `setRuntime(id, name | null)` (swaps `<root>/java/<server>` to
// `<root>/runtimes/<name>` atomically, a new link renamed over it, or removes it for system java; audited as `pack
// runtime`) and `PackState.runtime` (what the link points at, `pending` until the server's next hello after a change
// (in memory), and the two `Environment=` lines when `Services.environment` shows the unit doesn't name the link); the
// last apply's snapshot (`snapshotOf`) and the changes pending per file against it (`pendingChanges`). Hub core.

import { mkdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Extra, InstalledPack, PackChange, PackRollback, PackRuntime, PackState, PendingChange } from '../api.ts';
import type { ServerSettings } from '../config.ts';
import type { PackRow } from '../stats/db.ts';
import { RUNTIME } from './library.ts';
import { blockedReason, has, javaLink, server, type PacksCtx } from './pack-ctx.ts';
import { builtIn, modJars, PackRefused } from './pack-paths.ts';

const HISTORY = 50;

/** What the last apply laid over the pack: each Extra's sha256 by target, and each edited file's edits as JSON. */
export type Snapshot = { extras: Record<string, string>; edits: Record<string, string> };

export function rollbackOffer(c: PacksCtx, serverId: string): PackRollback | null {
  if (!has(c, serverId) || c.jobs.has(serverId)) return null;
  const last = c.d.db.packUpdates(serverId, 1)[0];
  return last?.outcome === 'rolled back' && last.restored === null ? { to: last.to, backup: last.backup } : null;
}

export function restored(c: PacksCtx, serverId: string): void {
  const last = c.d.db.packUpdates(serverId, 1)[0];
  if (last?.outcome === 'rolled back' && last.restored === null) c.d.db.setPackUpdate(last.id, { restored: Date.now() });
}

export async function state(c: PacksCtx, serverId: string): Promise<PackState> {
  const s = server(c, serverId);
  const pack = c.d.db.pack(serverId);
  const own = new Set(c.d.db.packFiles(serverId, true));
  const snap: Snapshot = pack ? JSON.parse(pack.snapshot) : { extras: {}, edits: {} };
  const job = c.jobs.get(serverId);
  const extras: Extra[] = c.d.db.extras(serverId).map((e) => {
    const was = snap.extras[e.target];
    const change: PackChange | null = e.removed ? (was ? 'removed' : null) : !was ? 'added' : was !== e.sha256 ? 'replaced' : null;
    return { ...e, replaces: own.has(e.target), change };
  });
  return {
    installed: pack ? installed(pack) : null,
    kept: { server: s.keep ?? [], builtIn: await builtIn(s) },
    extras,
    edits: c.d.db.configEdits(serverId),
    pending: pack ? pendingChanges(c, serverId, snap) : [],
    history: c.d.db.packUpdates(serverId, HISTORY).map(({ serverId: _, restored: __, ...row }) => row),
    running: job ? { id: job.id, name: job.name, version: job.version, by: job.byName, started: job.started, steps: job.steps, cancellable: job.window !== null } : null,
    mod: (await modJars(s.dir!))[0] ?? null,
    blocked: blockedReason(c, serverId, s.name),
    rolledBack: rollbackOffer(c, serverId),
    packFiles: [...own],
    runtime: await runtimeOf(c, s),
  };
}

export async function setRuntime(c: PacksCtx, serverId: string, name: unknown, by: string): Promise<PackState> {
  const s = server(c, serverId);
  if (name !== null && (typeof name !== 'string' || !RUNTIME.test(name) || !c.d.library.runtime(name))) {
    throw new PackRefused(404, 'No such runtime in the library.');
  }
  const link = javaLink(c, serverId);
  if (name === null) await rm(link, { force: true });
  else {
    await mkdir(dirname(link), { recursive: true });
    const next = `${link}.new-${process.pid}-${Date.now()}`;
    await symlink(join(c.d.dataDir, 'runtimes', name), next);
    await rename(next, link).catch(async (err) => {
      await rm(next, { force: true });
      throw err;
    });
  }
  c.runtimeChanged.add(serverId);
  c.d.hub.audit(by, 'pack runtime', serverId, name ?? 'system java');
  return state(c, s.id);
}

/** What the server's Java link points at, whether that waits for a restart, and the unit lines it lacks. */
async function runtimeOf(c: PacksCtx, s: ServerSettings): Promise<PackRuntime> {
  const link = javaLink(c, s.id);
  const target = await readlink(link).catch(() => null);
  const runtimes = join(c.d.dataDir, 'runtimes');
  const name = target && dirname(target) === runtimes ? target.slice(runtimes.length + 1) : null;
  const env = await c.d.services.environment(c.d.services.ofServer(s.id)!.id);
  const names = env !== undefined && (env.split(/\s+/).includes(`JAVA_HOME=${link}`) || env.includes(`${link}/bin`));
  return {
    name,
    pending: c.runtimeChanged.has(s.id),
    unitLines: names ? null : [`Environment=PATH=${link}/bin:/usr/local/bin:/usr/bin:/bin`, `Environment=JAVA_HOME=${link}`],
  };
}

export function snapshotOf(c: PacksCtx, serverId: string): Snapshot {
  const extras = Object.fromEntries(c.d.db.extras(serverId).filter((e) => !e.removed).map((e) => [e.target, e.sha256]));
  const byPath = new Map<string, [string, string][]>();
  for (const e of c.d.db.configEdits(serverId)) byPath.set(e.path, [...(byPath.get(e.path) ?? []), [e.find, e.replace]]);
  return { extras, edits: Object.fromEntries([...byPath].map(([p, list]) => [p, JSON.stringify(list)])) };
}

/** What the next apply changes, per file, against what the last one applied. */
export function pendingChanges(c: PacksCtx, serverId: string, applied: Snapshot): PendingChange[] {
  const now = snapshotOf(c, serverId);
  const diff = (kind: 'extra' | 'edit', was: Record<string, string>, is: Record<string, string>): PendingChange[] =>
    [...new Set([...Object.keys(was), ...Object.keys(is)])].sort().flatMap((path) => {
      const change: PackChange | null = !was[path] ? 'added' : !is[path] ? 'removed' : was[path] !== is[path] ? 'replaced' : null;
      return change ? [{ path, kind, change }] : [];
    });
  return [...diff('extra', applied.extras, now.extras), ...diff('edit', applied.edits, now.edits)];
}

const installed = ({ name, version, source, sha256, by, at, how }: PackRow): InstalledPack => ({ name, version, source, sha256, by, at, how });

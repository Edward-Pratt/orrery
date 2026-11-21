// A pack update, for `Packs`: `startUpdate(id, { library } | 'pending')` (one per server, returns at once; never
// downloads: the new entry's zip, or for pending changes the installed one's, refused (409) when the pack has no
// entry; the same sha256 and version with nothing pending refused up front; refused while a countdown runs on the
// server), then in the background: Prepare (a leftover `.orrery-staging` deleted, the library zip checked with `unzip
// -Z` before `unzip` into `<dir>/.orrery-update`, Kept paths dropped, Extras, the Mod's jar, edits last; an edit
// matching nothing fails it; staged files checked inside the folder), Backup, Stop (`Services.act`, the countdown with
// players online; a cancelled countdown cancels the update), Swap (the old manifest's files and Mod jar into
// `.pre-update-<time>/`, older ones deleted), the health gate and, without one, a rollback (the old files copied back:
// the folder stays for recovery). `cancelUpdate` in Prepare or the countdown. An error after the stop but before the
// swap ends as `failed before swap` (the old pack is started again). The job's steps and waits: `pack-job.ts`. Hub core.

import { copyFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ServerSettings } from '../config.ts';
import type { EditRow, LibraryRow, PackRow } from '../stats/db.ts';
import { formatDuration } from '../units.ts';
import { blockedReason, extrasDir, server, sourceEntry, type PacksCtx } from './pack-ctx.ts';
import { purge } from './pack-extras.ts';
import { backup, cancelled, clock, end, gate, inactive, log, setStep, STEPS, ticker, wait, type Job } from './pack-job.ts';
import { exists, inside, isFile, keptBy, keptPaths, LEGACY_STAGING, MOD_JAR, modJars, PackRefused, PRE, UPDATE, walk } from './pack-paths.ts';
import { pendingChanges, snapshotOf } from './pack-state.ts';
import { unpack } from './pack-zip.ts';

export function startUpdate(c: PacksCtx, serverId: string, source: unknown, by: string, byName: string): number {
  const s = server(c, serverId);
  if (c.jobs.has(serverId)) throw new PackRefused(409, `A pack update is already running on ${s.name}.`);
  const pack = c.d.db.pack(serverId);
  if (!pack) throw new PackRefused(409, `orrery doesn't know ${s.name}'s pack yet: adopt it first.`);
  const blocked = blockedReason(c, serverId, s.name);
  if (blocked) throw new PackRefused(409, blocked);
  if (!c.d.hub.get(serverId)?.online) throw new PackRefused(409, `${s.name} is offline: an update needs it running, for the backup.`);
  const pending = pendingChanges(c, serverId, JSON.parse(pack.snapshot));
  let entry: LibraryRow | undefined;
  if (source === 'pending') {
    if (!pending.length) throw new PackRefused(409, `Nothing is pending: ${pack.version} is installed as it is.`);
    if (pack.libraryId === null || !c.d.library.entry(pack.libraryId)) {
      throw new PackRefused(409, `${pack.name} ${pack.version} isn't in the library: update to a version from the library instead.`);
    }
  } else {
    entry = sourceEntry(c, source);
    if (entry.sha256 === pack.sha256 && entry.version === pack.version && !pending.length) {
      throw new PackRefused(409, `${pack.name} ${pack.version} is installed already, with nothing pending.`);
    }
  }
  const changes = entry ? null : pending.map((p) => `${p.path} ${p.change}`);
  const job: Job = {
    id: 0,
    serverId,
    name: entry?.name ?? pack.name,
    version: entry?.version ?? pack.version,
    libraryId: entry?.id ?? pack.libraryId!,
    from: pack.version,
    actor: by,
    byName,
    started: Date.now(),
    steps: STEPS.map((step) => ({ step, state: 'waiting', detail: '' })),
    cancelled: false,
    window: 'prepare',
    stopped: false,
    touched: false,
    log: [],
    backup: null,
    pre: null,
  };
  job.id = c.d.db.startPackUpdate(serverId, { from: job.from, to: job.version, changes, by: byName, started: job.started });
  c.jobs.set(serverId, job);
  c.d.hub.audit(by, 'pack update', serverId, changes ? `changes applied to ${job.version}: ${changes.join(', ')}` : `${job.from} → ${job.version}`);
  c.d.hub.publish(serverId, { severity: 'info', kind: 'packUpdateStarted', from: job.from, to: job.version, by: byName });
  void run(c, job, s, pack, entry);
  return job.id;
}

export function cancelUpdate(c: PacksCtx, serverId: string, by: string, byName: string): void {
  const s = server(c, serverId);
  const job = c.jobs.get(serverId);
  if (!job) throw new PackRefused(409, `No pack update is running on ${s.name}.`);
  if (!job.window) throw new PackRefused(409, 'Too late to cancel: only while preparing or during the countdown.');
  c.d.hub.audit(by, 'pack update cancel', serverId, `${job.from} → ${job.version}`);
  if (job.window === 'countdown') c.d.restarts.cancel(serverId, by, byName); // the update sees the cancelled countdown
  else job.cancelled = true;
}

async function run(c: PacksCtx, job: Job, s: ServerSettings, pack: PackRow, entry: LibraryRow | undefined): Promise<void> {
  const dir = s.dir!;
  const staging = join(dir, UPDATE);
  const service = c.d.services.ofServer(s.id)!;
  const oldFiles = c.d.db.packFiles(s.id);
  const oldOwn = new Set(c.d.db.packFiles(s.id, true));
  let next: PackRow | undefined;
  let manifest: string[] = [];
  let own = new Set<string>();
  try {
    // 1. Prepare: the staged set, while the server runs.
    setStep(c, job, 'prepare', 'running', 'Unpacking');
    await rm(join(dir, LEGACY_STAGING), { recursive: true, force: true });
    const { root, files } = await unpack(c.d.library.zip(job.libraryId), join(staging, 'zip'));
    const kept = await keptPaths(s);
    for (const f of files) if (keptBy(f, kept)) await rm(join(root, f), { force: true });
    own = new Set(files.filter((f) => !keptBy(f, kept)));
    const snapshot = snapshotOf(c, s.id);
    for (const e of c.d.db.extras(s.id)) {
      if (e.removed || keptBy(e.target, kept)) continue;
      await mkdir(dirname(join(root, e.target)), { recursive: true });
      await copyFile(join(extrasDir(c, s.id), String(e.id)), join(root, e.target));
    }
    for (const jar of await modJars(dir)) {
      await mkdir(join(root, 'mods'), { recursive: true });
      await copyFile(join(dir, jar), join(root, jar));
    }
    for (const e of c.d.db.configEdits(s.id)) await applyEdit(c, job, root, e);
    const staged = await walk(root);
    for (const f of staged) if (!(await inside(dir, f))) throw new Error(`${f} would be written outside the server folder.`);
    manifest = staged.filter((f) => !MOD_JAR.test(f)).sort();
    next = {
      name: job.name,
      version: job.version,
      source: entry?.source ?? pack.source,
      sha256: entry?.sha256 ?? pack.sha256,
      by: job.byName,
      at: 0,
      how: 'updated',
      snapshot: JSON.stringify(snapshot),
      libraryId: job.libraryId,
    };
    cancelled(job);
    job.window = null;
    setStep(c, job, 'prepare', 'done', `Staged: ${manifest.length.toLocaleString('en')} files`);

    // 2. Backup: mandatory, through the Mod.
    setStep(c, job, 'backup', 'running', 'Backing up');
    job.backup = await backup(c, job, s);
    c.d.db.setPackUpdate(job.id, { backup: job.backup });
    setStep(c, job, 'backup', 'done', job.backup ?? 'Backed up');

    // 3. Stop, with the countdown when players are online.
    setStep(c, job, 'stop', 'running', 'Stopping');
    const countdown = wait(c, s.id, (e) =>
      e.type === 'notice' ? (e.kind === 'restartNow' ? 'fired' : e.kind === 'restartCancelled' || e.kind === 'restartCancelledDown' ? 'cancelled' : undefined) : undefined,
    c.o.stopMs);
    let at: number | null;
    try {
      at = await c.d.services.act(service.id, 'stop', job.actor, job.byName);
    } catch (err) {
      countdown.stop();
      throw err;
    }
    job.stopped = true;
    if (at === null) countdown.stop();
    else {
      job.window = 'countdown';
      const players = c.d.hub.get(s.id)?.players.length ?? 0;
      const tick = ticker(c, () => setStep(c, job, 'stop', 'running', `${players} player${players === 1 ? '' : 's'} online: stopping in ${clock(at! - Date.now())}`));
      const how = await countdown.done;
      tick();
      job.window = null;
      if (how === 'cancelled') {
        job.stopped = false;
        return await end(c, job, 'cancelled', staging);
      }
      if (how === undefined) throw new Error("The countdown didn't end in time.");
    }
    await inactive(c, service.id);
    setStep(c, job, 'stop', 'done', at === null ? 'Stopped' : 'Stopped after the countdown');

    // 4. Swap: the old manifest's files out to .pre-update-<time>/, the staged set in.
    job.touched = true;
    const pre = `${PRE}${new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')}`;
    job.pre = pre;
    setStep(c, job, 'swap', 'running', `Moving ${oldFiles.length.toLocaleString('en')} old files to ${pre}/`);
    for (const f of await readdir(dir)) if (f.startsWith(PRE)) await rm(join(dir, f), { recursive: true, force: true });
    const out = async (f: string) => {
      if (!(await exists(join(dir, f)))) return;
      await mkdir(dirname(join(dir, pre, f)), { recursive: true });
      await rename(join(dir, f), join(dir, pre, f));
    };
    for (const f of [...oldFiles, ...(await modJars(dir))]) await out(f);
    for (const f of staged) {
      await out(f); // a file the old manifest didn't list: kept with the old ones, not lost
      await mkdir(dirname(join(dir, f)), { recursive: true });
      await rename(join(root, f), join(dir, f));
    }
    c.d.db.setPack(s.id, { ...next, at: Date.now() }, manifest, own);
    await rm(staging, { recursive: true, force: true });
    log(c, job, `The old files are in ${pre}/`);
    setStep(c, job, 'swap', 'done', `Swapped: ${staged.length.toLocaleString('en')} files in, old ones in ${pre}/`);

    // 5. Health gate: the Mod's hello.
    const waited = await gate(c, job, service.id, 'gate');
    if (waited !== null) {
      for (const e of c.d.db.extras(s.id)) if (e.removed) await purge(c, s.id, e.id);
      for (const e of c.d.db.configEdits(s.id)) if (e.failedOn) c.d.db.updateEdit(e.id, { ...e, failedOn: null });
      setStep(c, job, 'gate', 'done', `Hello after ${clock(waited)}`);
      return await end(c, job, 'ok', staging);
    }
    setStep(c, job, 'gate', 'failed', `No hello within ${formatDuration(c.o.gateMs)}`);
    return await rollback(c, job, s, service.id, pack, { oldFiles, oldOwn, manifest });
  } catch (err) {
    if (c.closed) return; // left running: the next hub closes it as interrupted
    const why = (err as Error).message;
    log(c, job, why);
    const at = job.steps.find((x) => x.state === 'running');
    if (at) setStep(c, job, at.step, 'failed', why);
    if (job.touched) return await rollback(c, job, s, service.id, pack, { oldFiles, oldOwn, manifest });
    if (job.stopped) {
      await c.d.services.act(service.id, 'start', job.actor, job.byName).catch(() => {});
      return await end(c, job, 'failed before swap', staging);
    }
    return await end(c, job, job.cancelled ? 'cancelled' : 'failed in staging', staging);
  }
}

/** Puts the old files and records back after the health gate failed (or the swap broke), and starts the server again. */
async function rollback(
  c: PacksCtx,
  job: Job,
  s: ServerSettings,
  serviceId: string,
  pack: PackRow,
  { oldFiles, oldOwn, manifest }: { oldFiles: string[]; oldOwn: Set<string>; manifest: string[] },
): Promise<void> {
  const dir = s.dir!;
  try {
    setStep(c, job, 'rollback', 'running', 'Putting the old files back');
    await c.d.services.act(serviceId, 'stop', job.actor, job.byName);
    await inactive(c, serviceId);
    for (const f of [...manifest, ...(await modJars(dir))]) await rm(join(dir, f), { force: true });
    // Copied, not moved: the folder stays for recovery by hand until the next update that succeeds.
    await cp(join(dir, job.pre!), dir, { recursive: true, force: true, verbatimSymlinks: true });
    c.d.db.setPack(s.id, pack, oldFiles, oldOwn);
    const waited = await gate(c, job, serviceId, 'rollback');
    if (waited !== null) {
      setStep(c, job, 'rollback', 'done', `${pack.version} is running again`);
      return await end(c, job, 'rolled back', join(dir, UPDATE));
    }
    log(c, job, `${s.name} didn't come back after the rollback either. The old files are in ${job.pre}/`);
    setStep(c, job, 'rollback', 'failed', `No hello after the rollback either. The old files are in ${job.pre}/`);
  } catch (err) {
    if (c.closed) return;
    log(c, job, `The rollback failed: ${(err as Error).message}. The old files are in ${job.pre}/`);
    setStep(c, job, 'rollback', 'failed', (err as Error).message);
  }
  return await end(c, job, 'failed', join(dir, UPDATE));
}

async function applyEdit(c: PacksCtx, job: Job, root: string, e: EditRow): Promise<void> {
  const file = join(root, e.path);
  const content = (await isFile(file)) ? await readFile(file, 'utf8') : undefined;
  const re = new RegExp(e.find, 'gm');
  if (!content?.match(re)) {
    c.d.db.updateEdit(e.id, { ...e, failedOn: job.version });
    throw new Error(`The Config edit on ${e.path} (${e.find}) ${content === undefined ? 'has no file' : 'matched nothing'} in ${job.version}.`);
  }
  await writeFile(file, content.replace(re, e.replace));
}

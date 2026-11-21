// A game update's swap, gate and rollback, and its waits on the unit (`Updates` in `update.ts`). **swap**: the unit must
// read inactive or failed within 5 minutes (`waitStopped`, "Checking that the server is stopped"), then (after the
// rollback's save, `keep` in `update-backup.ts`) `mod-settings.dat` copied again (Factorio writes it as it stops),
// `<install>/current` flipped (`flip`), `mods` to `mods.prev`, `mods.next` to `mods`, the unit started. **gate**, 5
// minutes: a `/orrery-status` since the start with the target version and exactly the expected mods (the own mods the
// staged list enables, and the update's), and `gameUp`. **rollback** after a failed swap or gate (its own
// `update.json` write may fail, a full disk: logged, it goes on): the unit stopped, the old `current`, `mods.prev` back
// (with its `mod-settings.dat`), the swap's copy copied as the newest save (`Saves.restore`), started, gated again on
// the old version (and its mods, if known), the game connection asked for only while the Agent connection is up
// (`connected`: the old server ran with the hub before, so with the hub unreachable its RCON answer is enough and a
// recovery rollback ends `rolled back`, not `failed`): `rolled back` or `failed`. After a failure before the swap the
// old server is started again if the hub had stopped it (`startOld`); after `updateCancel`, only when it was active at
// the backup and reads inactive or failed (once a `deactivating` is over, 5 minutes at most: `startAfterCancel`).
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PackFinished } from '../../hub/src/types.ts';
import type { UpdatesCtx } from './update-ctx.ts';
import { there } from './update-files.ts';
import { Fail, jobFile, plural, reason, save as saveJob, stopped, type Job, type Running } from './update-job.ts';
import { copySettings } from './update-prepare.ts';
import { flip } from './update-release.ts';
import { step } from './update-steps.ts';

const count = (mods: Record<string, string>) => Object.keys(mods).length;

/** How a mod set differs from the one expected, briefly. */
function differences(want: Record<string, string>, got: Record<string, string>): string | null {
  const out: string[] = [];
  for (const [name, version] of Object.entries(want)) {
    if (!Object.hasOwn(got, name)) out.push(`${name} missing`);
    else if (got[name] !== version) out.push(`${name} ${got[name]}, not ${version}`);
  }
  for (const name of Object.keys(got)) if (!Object.hasOwn(want, name)) out.push(`${name} extra`);
  if (out.length === 0) return null;
  return out.length > 5 ? `${out.slice(0, 5).join(', ')} and ${out.length - 5} more` : out.join(', ');
}

export async function swap(c: UpdatesCtx, r: Running): Promise<void> {
  const { job } = r;
  const { data } = c.o;
  step(c, r, 'swap', 'running', `Putting Factorio ${job.factorio} and ${plural(job.mods.length, 'mod')} in place`);
  c.clearLatest();
  // Factorio writes mod-settings.dat as it stops: the copy prepare made is taken again, as it is now.
  const settings = await copySettings(c);
  await flip(c, `releases/${job.factorio}`);
  await rm(join(data, 'mods.prev'), { recursive: true, force: true });
  if (await there(join(data, 'mods'))) await rename(join(data, 'mods'), join(data, 'mods.prev'));
  await rename(join(data, 'mods.next'), join(data, 'mods'));
  job.phase = 'gate';
  await saveJob(c, job);
  await c.o.unit.act('start');
  step(c, r, 'swap', 'done', `Factorio ${job.factorio} and ${plural(job.mods.length, 'mod')} in place${settings ? ', with mod-settings.dat' : ''}; the server is starting`);
}

/**
 * Resolves with the gate's detail once `/orrery-status` says `version` with exactly `mods` (unless null) and the
 * game connection is up. A rollback's (`back`) asks for the game connection only while the Agent connection is up:
 * the old server ran with the hub before, so with the hub unreachable its RCON answer is enough.
 */
export async function gate(c: UpdatesCtx, version: string, mods: Record<string, string> | null, back = false): Promise<string> {
  const until = performance.now() + c.o.gateMs;
  let why = 'no /orrery-status answer';
  for (;;) {
    const s = c.latest();
    if (s) {
      const diff = mods && differences(mods, s.mods);
      const game = c.o.gameUp();
      if (s.version !== version) why = `/orrery-status says Factorio ${s.version}, not ${version}`;
      else if (diff) why = `/orrery-status lists other mods: ${diff}`;
      else if (!game && (!back || c.o.connected())) why = 'the game connection to the hub is not up';
      else return `Factorio ${version} answers with ${mods ? `exactly its ${plural(count(mods), 'mod')}` : 'its mods'}, ${game ? 'and the game connection is up' : 'with the hub unreachable'}`;
    }
    if (performance.now() >= until) throw new Fail(`Not up within ${Math.round(c.o.gateMs / 1000)} s: ${why}`);
    await sleep(c.o.pollMs);
  }
}

export async function rollback(c: UpdatesCtx, r: Running): Promise<PackFinished> {
  const { job } = r;
  const { data } = c.o;
  const back = job.previous.slice('releases/'.length);
  step(c, r, 'rollback', 'running', `Going back to Factorio ${back}, its mods and the pre-update save`);
  try {
    job.phase = 'rollback';
    // Not written (a full disk): a restart finds the swap or the gate there, and rolls back the same way.
    await saveJob(c, job).catch((err: Error) => console.error(`[update] can't write ${jobFile(c)}: ${reason(err)}`));
    const unit = await c.o.unit.read();
    if (!stopped(unit)) await c.o.unit.act('stop');
    await waitStopped(c);
    c.clearLatest();
    await flip(c, job.previous);
    if (await there(join(data, 'mods.prev'))) {
      await rm(join(data, 'mods'), { recursive: true, force: true });
      await rename(join(data, 'mods.prev'), join(data, 'mods'));
    }
    await rm(join(data, 'mods.next'), { recursive: true, force: true });
    let save = '';
    if (job.backup) {
      try {
        await c.o.saves.restore(job.backup);
        save = `, ${job.backup} copied as the newest save`;
      } catch (err) {
        console.error(`[update] ${job.id}: can't copy ${job.backup} as the newest save: ${reason(err)}`);
        save = `; ${job.backup} could not be copied as the newest save (${reason(err)})`;
      }
    }
    await c.o.unit.act('start');
    step(c, r, 'rollback', 'running', `Back on Factorio ${back}${save}: waiting for it to come up`);
    await gate(c, back, job.from.mods, true);
    step(c, r, 'rollback', 'done', `Back on Factorio ${back} with its mods${save}`);
    return 'rolled back';
  } catch (err) {
    step(c, r, 'rollback', 'failed', reason(err));
    return 'failed';
  }
}

/** Waits until the unit is inactive or failed, 5 minutes at most. */
export async function waitStopped(c: UpdatesCtx): Promise<void> {
  const until = performance.now() + c.o.stopWaitMs;
  for (;;) {
    const s = await c.o.unit.read();
    if (stopped(s)) return;
    if (performance.now() >= until) throw new Fail(`The server is still ${s.active} (${s.sub}) after ${Math.round(c.o.stopWaitMs / 1000)} s`);
    await sleep(c.o.pollMs);
  }
}

/**
 * After a cancel: a server that ran at the backup and is stopped now (or still stopping: waited for, 5 minutes at
 * most) was stopped by the hub, which starts it again, unless it restarted meanwhile and doesn't know: so it is
 * started here too (a second start does nothing). Running (a countdown cancelled), it is left alone.
 */
export async function startAfterCancel(c: UpdatesCtx, job: Job): Promise<void> {
  if (!job.wasActive) return;
  try {
    let s = await c.o.unit.read();
    if (s.active === 'deactivating') {
      await waitStopped(c);
      s = await c.o.unit.read();
    }
    if (!stopped(s)) return;
    console.log(`[update] ${job.id}: cancelled with the server stopped, which ran before the update: starting it again`);
    await c.o.unit.act('start');
  } catch (err) {
    console.error(`[update] can't start the server again: ${reason(err)}`);
  }
}

/** The old server again, after a failure before the swap, if the hub had stopped it. */
export async function startOld(c: UpdatesCtx): Promise<void> {
  try {
    const s = await c.o.unit.read();
    if (stopped(s)) await c.o.unit.act('start');
  } catch (err) {
    console.error(`[update] can't start the server again: ${reason(err)}`);
  }
}

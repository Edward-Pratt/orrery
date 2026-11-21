// A game update's run (`Updates.update` in `update.ts` starts it): its steps in order, each in its own module, and how
// a failure ends it. A failure before the swap is `failed in staging`, or `failed before swap` once the hub had stopped
// the server (`updateResume` for a server that ran at the backup: it is started again; one stopped before the update
// stays stopped, `failed in staging`); `updateCancel` only before the swap: downloads aborted, `cancelled`, the unit
// never stopped, and started only when it was active at the backup and reads inactive or failed: the hub starts a
// server it stopped, unless it restarted during its stop and doesn't know (a second start does nothing). The end is
// the class's (`finish`, through the context).
//
// 1. prepare: the hub's `update` checked (`checkUpdate`; a refusal is the reply's); the game's sha256 checked against
//    factorio.com's list and each mod's sha1 against the mod portal's, before any download; the tarball downloaded to
//    `<install>/.incoming/` (only when the release isn't there yet), checked, unpacked (`unpack`) and its binary's
//    glibc need checked against the image's (`image.json`) before it becomes `<install>/releases/<ver>/`; the mods
//    downloaded to `<data>/.incoming/`, checked and staged in `<data>/mods.next/` with a `mod-list.json` (the release's
//    own mods on or off as the current one has them, one new in the release on, and the update's on) and
//    `mod-settings.dat` carried over. Downloads follow redirects only to `ALLOWED_HOSTS`, at most 5, with caps, and
//    stop after `STALL_MS` without a byte. (`update-prepare.ts`, `update-download.ts`)
// 2. backup: a pre-update save while the server runs, else the newest save; held from pruning until the swap.
//    (`update-backup.ts`)
// 3. stop, the hub's: `waiting` (its only state that goes out) until the hub stopped the server (`updateResume`) or
//    cancelled the update (`updateCancel`, which never stops the unit; it starts it only if it ran at the backup and
//    is stopped now: the hub stopped it, and may have restarted since without knowing). (`update-backup.ts`)
// 4. swap: the unit checked stopped, the newest save (the one the stop just wrote) copied as the rollback's save
//    (`Saves.keep`: older than it, so the new release never loads or writes the copy; a copy that fails ends the
//    update before anything moves, `failed before swap`), `current` flipped to the new release, `mods` to
//    `mods.prev`, `mods.next` to `mods`, the unit started. (`update-swap.ts`)
// 5. gate, 5 minutes at most: `/orrery-status` with the new version and exactly the expected mods, and the game
//    connection up. (`update-swap.ts`)
// 6. rollback, when the swap or the gate failed: the old `current`, `mods.prev` back (its `mod-settings.dat` with it),
//    the swap's copy copied as the newest save (none if there was no save to copy), started and gated again (the
//    game connection only while the Agent connection is up): `rolled back`, or `failed`. (`update-swap.ts`)
import type { PackFinished, PackStep } from '../../hub/src/types.ts';
import { backup, hubStop, keep } from './update-backup.ts';
import type { UpdatesCtx } from './update-ctx.ts';
import { check, Fail, hubStopped, reason, type Running } from './update-job.ts';
import { prepare } from './update-prepare.ts';
import { clean } from './update-release.ts';
import { step as stepOut } from './update-steps.ts';
import { gate, rollback, startAfterCancel, startOld, swap, waitStopped } from './update-swap.ts';
import type { Request } from './wire.ts';

export async function run(c: UpdatesCtx, r: Running, req: Request<'update'>): Promise<void> {
  const { job } = r;
  let step: PackStep = 'prepare';
  try {
    await prepare(c, r, req);
    check(r);
    step = 'backup';
    await backup(c, r);
    check(r);
    step = 'stop';
    await hubStop(c, r);
    // The stop is the hub's: the swap starts by checking that it is done.
    step = 'swap';
    stepOut(c, r, 'swap', 'running', 'Checking that the server is stopped');
    await waitStopped(c);
    check(r);
    job.phase = 'swap'; // at once: no cancel from here on
    await keep(c, job); // and the swap phase recorded, before anything moves: a copy that fails ends it here
  } catch (err) {
    stepOut(c, r, step, 'failed', r.cancelled ? 'Cancelled by the hub' : reason(err));
    if (!r.cancelled && !(err instanceof Fail)) console.error(`[update] ${job.id}: ${reason(err)}`);
    await clean(c);
    if (r.cancelled) await startAfterCancel(c, job);
    else if (hubStopped(job)) await startOld(c);
    return c.finish(r, r.cancelled ? 'cancelled' : hubStopped(job) ? 'failed before swap' : 'failed in staging');
  }
  let outcome: PackFinished;
  step = 'swap';
  try {
    await swap(c, r);
    step = 'gate';
    stepOut(c, r, 'gate', 'running', `Waiting for Factorio ${job.factorio} with exactly its mods, and the game connection (${Math.round(c.o.gateMs / 1000)} s at most)`);
    const ok = await gate(c, job.factorio, job.expect);
    stepOut(c, r, 'gate', 'done', ok);
    outcome = 'ok';
  } catch (err) {
    stepOut(c, r, step, 'failed', reason(err));
    outcome = await rollback(c, r);
  }
  await c.finish(r, outcome);
}

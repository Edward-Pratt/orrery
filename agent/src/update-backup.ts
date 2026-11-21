// A game update's saves and the hub's stop (`Updates` in `update.ts`). **backup**: `Saves.preUpdate` while the unit is
// active, else the newest save, held until the swap; whether the unit was active is recorded. **stop**, the hub's:
// `waiting` until `updateResume` or `updateCancel` (each with a request id of its own, acting on the one update
// running; with none running, refused), the only state of this step that goes out (a cancel or a restart in it is only
// logged). Then, once the unit reads stopped, the rollback's save (`keep`): the newest save (the one the stop just
// wrote, with all play up to it) copied by `Saves.keep`, held in the backup step's place (released only once the copy
// is there) and recorded with the swap phase before anything moves (a copy that fails, a full disk, ends the update
// there as `failed before swap`, the backup step's save still held and named, the old server started again: the new
// release would write the newest save in its own format at a rollback's stop, leaving the old one nothing it could
// load; so does a swap record that can't be written, as a restart after the flip would find no swap to roll back).
import type { UpdatesCtx } from './update-ctx.ts';
import { Cancelled, reason, save, type Job, type Running } from './update-job.ts';
import { step } from './update-steps.ts';

export async function backup(c: UpdatesCtx, r: Running): Promise<void> {
  const { job } = r;
  job.phase = 'backup';
  await save(c, job);
  step(c, r, 'backup', 'running', `Saving the game as orrery-pre-update-${job.from.factorio}`);
  const unit = await c.o.unit.read();
  job.wasActive = unit.active === 'active';
  if (job.wasActive) {
    job.backup = await c.o.saves.preUpdate(job.from.factorio);
    await save(c, job);
    return step(c, r, 'backup', 'done', `Saved ${job.backup}`);
  }
  job.backup = (await c.o.saves.list()).saves[0]?.name ?? null;
  if (job.backup) c.o.saves.hold(job.backup);
  await save(c, job);
  step(c, r, 'backup', 'done', job.backup ? `The server is stopped: no save made; the swap keeps a copy of ${job.backup}, the newest, for a rollback` : 'The server is stopped and has no saves');
}

/** The stop step, the hub's: `waiting` until its `updateResume` (it stopped the server) or `updateCancel`. */
export async function hubStop(c: UpdatesCtx, r: Running): Promise<void> {
  const { job } = r;
  job.phase = 'stop';
  await save(c, job);
  step(c, r, 'stop', 'waiting', 'Waiting for the hub to stop the server');
  const how = await new Promise<'resume' | 'cancel'>((resolve) => {
    r.wake = resolve;
    if (r.cancelled) resolve('cancel');
  });
  r.wake = null;
  if (how === 'cancel') throw new Cancelled('cancelled');
  job.resumed = true;
  await save(c, job);
}

/**
 * The rollback's save, taken once the server is stopped and before anything moves: a copy of the newest save, which
 * the stop just wrote with all the play up to it (`Saves.keep`), held instead of the backup step's save, which is
 * released only once the copy is there. The new release loads (and on a stop writes, in its own format) that newest
 * file, never the copy. A copy that fails throws, the backup step's save still held: nothing has moved yet, so the
 * update ends there (`failed before swap`, the old server started again) rather than swap with no save a rollback
 * could load. Recorded with the swap phase, before the flip: a restart before that ends the update before the swap.
 */
export async function keep(c: UpdatesCtx, job: Job): Promise<void> {
  const prior = job.backup;
  let newest: string | undefined;
  try {
    newest = (await c.o.saves.list()).saves[0]?.name;
    job.backup = newest ? await c.o.saves.keep(newest, job.from.factorio) : null;
  } catch (err) {
    throw new Error(`Can't keep a copy of ${newest ?? 'the newest save'} for a rollback, so nothing was changed: ${reason(err)}`);
  }
  if (prior) c.o.saves.release(prior);
  await save(c, job);
}

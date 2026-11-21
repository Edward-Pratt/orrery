// The hub's step of a game update, for `game-run.ts` (`hubStop`): on the Agent's `stop` `waiting`, the hub's stop
// (`Services.act` `stop`, the 5-minute countdown with players on, cancellable; none for an inactive or failed unit),
// the unit read until inactive (15 min), then `updateResume`; a stop that fails ends it `failed before swap` (the
// server started again) or `failed in staging`; a cancelled countdown has the Agent sent `updateCancel`; an update
// that ends (its `updateDone`) while the hub stops the server drops that stop: its countdown cancelled
// (`RestartScheduler.cancel` as `hub:game-update`), the waits ended, a server the hub stopped started again, no
// `updateResume`. Hub core.

import { arm, end, ENDED_BY, inactive, log, setStep, tellCancel, ticker, wait, type Job } from './game-job.ts';
import type { GameCtx } from './game-ctx.ts';
import { redact } from './game-messages.ts';

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/**
 * The hub's step: stops the server (with the countdown when players are on), then tells the Agent to go on. An
 * update that ends meanwhile (its `updateDone`) drops it: `end` cancels the countdown, the waits end, and a server
 * the hub stopped starts again.
 */
export async function hubStop(c: GameCtx, job: Job): Promise<void> {
  job.stopping = true;
  job.window = null;
  arm(c, job); // off while the hub stops: its own waits are bounded
  const service = c.d.services.ofServer(job.serverId)!; // a factorio server has one, an Agent's
  /** Its end came first (`end`, which never runs once the hub closes). */
  const ended = () => c.jobs.get(job.serverId) !== job;
  let stopped = false;
  try {
    const unit = (await c.d.services.read(service.id))?.state;
    if (c.closed || ended()) return;
    if (unit === 'inactive' || unit === 'failed') setStep(c, job, 'stop', 'done', 'Already stopped');
    else {
      setStep(c, job, 'stop', 'running', 'Stopping');
      const countdown = wait(c, job.serverId, (e) =>
        e.type === 'notice' ? (e.kind === 'restartNow' ? 'fired' : e.kind === 'restartCancelled' || e.kind === 'restartCancelledDown' ? 'cancelled' : undefined) : undefined,
      c.o.stopMs);
      let at: number | null;
      try {
        at = await c.d.services.act(service.id, 'stop', job.actor, job.byName);
      } catch (err) {
        countdown.stop();
        throw err;
      }
      if (at === null) {
        stopped = true;
        countdown.stop();
      } else if (ended()) {
        // It ended while the countdown was being set up: no stop now.
        countdown.stop();
        if (!c.closed) c.d.restarts.cancel(job.serverId, ENDED_BY, 'the hub');
        return;
      } else {
        job.window = 'countdown';
        const players = c.d.hub.get(job.serverId)?.players.length ?? 0;
        const tick = ticker(c, () => setStep(c, job, 'stop', 'running', `${plural(players, 'player')} online: stopping in ${clock(at! - Date.now())}`));
        const how = await countdown.done;
        tick();
        job.window = null;
        stopped = how !== 'cancelled';
        if (c.closed) return;
        if (ended()) return await startAgain(c, job, service.id, stopped);
        if (how === 'cancelled') return await countdownCancelled(c, job);
        if (how === undefined) throw new Error("The countdown didn't end in time.");
      }
      await inactive(c, service.id, ended);
      if (c.closed) return;
      if (ended()) return await startAgain(c, job, service.id, stopped);
      setStep(c, job, 'stop', 'done', at === null ? 'Stopped' : 'Stopped after the countdown');
    }
    job.resumed = true;
    arm(c, job);
    await c.d.agents.request(job.agentId, { type: 'updateResume' });
  } catch (err) {
    if (c.closed) return;
    // Ended first: the Agent's end stands; a server it was never told to swap starts again.
    if (ended()) return job.resumed ? undefined : await startAgain(c, job, service.id, stopped);
    const why = redact((err as Error).message);
    if (job.resumed) log(c, job, `The Agent didn't take the go-ahead: ${why}`);
    else setStep(c, job, 'stop', 'failed', why);
    // Nothing swapped: the Agent drops the update, and a server the hub stopped starts again.
    tellCancel(c, job.agentId);
    if (stopped) await c.d.services.act(service.id, 'start', job.actor, job.byName).catch(() => {});
    end(c, job, stopped ? 'failed before swap' : 'failed in staging');
  }
}

/** The update ended while the hub stopped its server: one it did stop starts again, as nothing was swapped. */
async function startAgain(c: GameCtx, job: Job, serviceId: string, stopped: boolean): Promise<void> {
  if (stopped) await c.d.services.act(serviceId, 'start', job.actor, job.byName).catch(() => {});
}

async function countdownCancelled(c: GameCtx, job: Job): Promise<void> {
  log(c, job, 'The countdown was cancelled.');
  job.cancelling = true;
  try {
    await c.d.agents.request(job.agentId, { type: 'updateCancel' });
    arm(c, job); // its end follows
  } catch (err) {
    if (c.closed || c.jobs.get(job.serverId) !== job) return;
    if (!c.d.agents.get(job.agentId)?.connected) c.cancelOnConnect.add(job.agentId);
    log(c, job, `The Agent didn't cancel: ${redact((err as Error).message)}`);
    end(c, job, 'cancelled');
  }
}

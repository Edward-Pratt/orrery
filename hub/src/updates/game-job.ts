// A game update's job, for `game-run.ts` and `game-stop.ts`: its `Job` (the steps, the Cancel window, the hub's stop,
// the log), each step set and put on the stream (`setStep`; the row keeps the step the update is at), the log (its
// last 40 lines on the row), the quiet give-up (`arm`, `silent`: an Agent quiet about the update for 15 min (not while
// the hub stops the server) has it given up and is told to cancel before the swap; it counts from the Agent's latest
// step for the update (or the hub's latest request), as `docs/protocol.md` has the Agent repeat a running step at
// least every 60 s), `tellCancel` (`updateCancel` that can't reach it goes on its next `agentUp`), the waits (`wait`,
// a server event or a time-out; `ticker`, live detail every second; `inactive`, the unit read until stopped or the hub closes) and the
// end (`end`: the row closed, audited `game update`, announced as `packUpdateFinished`; one the hub ends, not the
// Agent, awaits the Agent's later end). A closing hub stops each wait and ticker without resolving it. Hub core.

import type { HubEvent } from '../servers/servers.ts';
import { untilStopped } from '../services/until-stopped.ts';
import type { PackFinished, PackStep, PackStepState, Severity } from '../types.ts';
import { formatDuration } from '../units.ts';
import type { GameCtx } from './game-ctx.ts';

export const STEPS: PackStep[] = ['prepare', 'backup', 'stop', 'swap', 'gate'];
/** Steps from which the Agent has changed the server: no cancel any more. */
export const SWAPPED = new Set<PackStep>(['swap', 'gate', 'rollback']);
export const HISTORY = 50;
const LOG_LINES = 40;
/** How often the countdown's detail goes on the stream. */
const TICK_MS = 1_000;
/** Who cancels a countdown the update's own end made pointless (`RestartScheduler.cancel`). */
export const ENDED_BY = 'hub:game-update';

export type Job = {
  /** Its history row. */
  id: number;
  /** The `update` request's id, which the Agent's steps and end carry. */
  update: string;
  serverId: string;
  agentId: string;
  name: string;
  from: string;
  to: string;
  actor: string;
  byName: string;
  started: number;
  steps: PackStepState[];
  /** Where Cancel is accepted now. */
  window: 'prepare' | 'countdown' | null;
  /** The Agent has swapped (or rolls back): nothing to cancel. */
  swapped: boolean;
  /** The hub's stop began (the Agent waits for it); `resumed`: the Agent was told to go on. */
  stopping: boolean;
  resumed: boolean;
  /** The Agent was told to cancel: its end follows. */
  cancelling: boolean;
  /** The row's step, as last written. */
  rowStep: PackStep;
  log: string[];
  backup: string | null;
  quiet: NodeJS.Timeout | undefined;
};

/** The Agent said nothing about the update for `quietMs`: the hub gives it up (its later end still goes on the row). */
function silent(c: GameCtx, job: Job): void {
  if (c.closed || c.jobs.get(job.serverId) !== job) return;
  const why = `No word from the Agent for ${formatDuration(c.o.quietMs)}`;
  const at = job.steps.find((s) => s.state === 'running');
  if (at) setStep(c, job, at.step, 'failed', why);
  else log(c, job, why);
  if (!job.swapped && !job.resumed) tellCancel(c, job.agentId);
  end(c, job, job.cancelling ? 'cancelled' : job.swapped || job.resumed ? 'failed' : 'failed in staging');
}

/** (Re)starts the wait for the Agent's next word; off while the hub's own stop runs. */
export function arm(c: GameCtx, job: Job): void {
  clearTimeout(job.quiet);
  job.quiet = undefined;
  if (c.closed || (job.stopping && !job.resumed && !job.cancelling)) return;
  job.quiet = setTimeout(() => silent(c, job), c.o.quietMs);
}

/**
 * `updateCancel` to an Agent, answered or not; one that isn't connected gets it when it connects. `refused`: it is
 * connected and didn't take it.
 */
export function tellCancel(c: GameCtx, agentId: string, refused?: () => void): void {
  c.d.agents.request(agentId, { type: 'updateCancel' }).catch(() => {
    if (!c.d.agents.get(agentId)?.connected) c.cancelOnConnect.add(agentId);
    else refused?.();
  });
}

/** Closes the row, announces the end; `fromAgent`: the Agent's `updateDone`, else its later one is recorded too. */
export function end(c: GameCtx, job: Job, outcome: PackFinished, fromAgent = false): void {
  if (c.closed) return;
  clearTimeout(job.quiet);
  c.jobs.delete(job.serverId);
  // Ended during the hub's countdown (its `updateDone`): no stop now, and `hubStop` sees the countdown cancelled.
  if (job.stopping && !job.resumed && job.window === 'countdown') c.d.restarts.cancel(job.serverId, ENDED_BY, 'the hub');
  if (!fromAgent) c.late.set(job.serverId, { row: job.id, update: job.update, from: job.from, to: job.to, started: job.started });
  if (outcome === 'cancelled') log(c, job, 'Cancelled before the swap.');
  const finished = Date.now();
  c.d.db.setPackUpdate(job.id, { outcome, finished, backup: job.backup, log: job.log.slice(-LOG_LINES).join('\n') });
  c.d.hub.audit(job.actor, 'game update', job.serverId, `${job.from} → ${job.to}: ${outcome}`);
  announceEnd(c, job.serverId, outcome, job.from, job.to, finished - job.started, job.backup);
}

/** Announces an update's end (`packUpdateFinished`). */
export function announceEnd(c: GameCtx, serverId: string, outcome: PackFinished, from: string, to: string, ms: number, backup: string | null): void {
  const severity: Severity = outcome === 'ok' ? 'good' : ['rolled back', 'failed', 'failed before swap'].includes(outcome) ? 'problem' : 'info';
  c.d.hub.publish(serverId, { severity, kind: 'packUpdateFinished', outcome, from, to, ms, ...(outcome === 'rolled back' && backup && { backup }) });
}

/** Sets a step's state and puts it on the stream; the row keeps the step the update is at. */
export function setStep(c: GameCtx, job: Job, step: PackStep, state: PackStepState['state'], detail: string): void {
  const i = job.steps.findIndex((x) => x.step === step);
  if (i === -1) job.steps.push({ step, state, detail });
  else job.steps[i] = { step, state, detail };
  if (state !== 'waiting' && job.rowStep !== step) {
    job.rowStep = step;
    c.d.db.setPackUpdate(job.id, { step });
  }
  if (state !== 'running') log(c, job, `${step}: ${state}${detail ? `: ${detail}` : ''}`);
  c.d.hub.publish(job.serverId, { severity: 'info', kind: 'packUpdateStep', step, state, detail, cancellable: cancellable(job) });
}

export function log(c: GameCtx, job: Job, line: string): void {
  job.log.push(line);
  c.d.db.setPackUpdate(job.id, { log: job.log.slice(-LOG_LINES).join('\n') });
}

export function cancellable(job: Job): boolean {
  return job.window !== null && !job.swapped && !job.cancelling;
}

/** Polls the unit until it is stopped, `ended` says the update is over, or the hub closes. */
export function inactive(c: GameCtx, serviceId: string, ended: () => boolean): Promise<void> {
  return untilStopped(c.d.services, serviceId, c.o, () => c.closed || ended());
}

/** Runs `fn` now and every second until the returned stop is called. */
export function ticker(c: GameCtx, fn: () => void): () => void {
  fn();
  const timer = setInterval(fn, TICK_MS);
  const stop = () => {
    clearInterval(timer);
    c.halts.delete(stop);
  };
  c.halts.add(stop);
  return stop;
}

/** Waits for a server event `pick` turns into a value; `done` resolves with it, or undefined after `ms` or `stop`. */
export function wait<T>(c: GameCtx, serverId: string, pick: (e: HubEvent) => T | undefined, ms: number): { done: Promise<T | undefined>; stop: () => void } {
  let stop!: () => void;
  const done = new Promise<T | undefined>((resolve) => {
    const listen = (e: HubEvent) => {
      if (e.serverId !== serverId) return;
      const v = pick(e);
      if (v !== undefined) {
        resolve(v); // first: stop resolves with undefined
        stop();
      }
    };
    const timer = setTimeout(() => stop(), ms);
    const halt = () => {
      clearTimeout(timer);
      c.d.hub.off('event', listen);
      c.halts.delete(halt);
    };
    stop = () => {
      halt();
      resolve(undefined);
    };
    c.d.hub.on('event', listen);
    c.halts.add(halt);
  });
  return { done, stop };
}

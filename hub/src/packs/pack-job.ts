// A pack update's job, for `pack-update.ts`: its `Job` (steps, the Cancel window, the log), each step set and put on
// the stream (`setStep`), the log (its last 40 lines on the row), the waits (`wait`, a server event or a time-out;
// `ticker`, live detail every second), the Backup (`ServerHub.backup`: `backup start`, the Mod's `backup` event, 30
// min), the stop's poll (`inactive`, every 2 s for 15 min), the health gate (`gate`: the Mod's hello, 10 min) and the
// end (`end`). Each update is a `pack_updates` row, audited, and announced as `packUpdateStarted`/`packUpdateStep`
// (stream only)/`packUpdateFinished` notices. A closing hub stops each wait and ticker without resolving it, leaving a
// running update as a crash would. Hub core.

import { rm } from 'node:fs/promises';
import { listBackups } from '../backups/backups.ts';
import type { ServerSettings } from '../config.ts';
import type { HubEvent } from '../servers/servers.ts';
import type { PackFinished, PackStep, PackStepState, Severity } from '../types.ts';
import { formatDuration } from '../units.ts';
import type { PacksCtx } from './pack-ctx.ts';

const LOG_LINES = 40;

/** How often live detail (countdown, gate) goes on the stream. */
const TICK_MS = 1_000;
export const STEPS: PackStep[] = ['prepare', 'backup', 'stop', 'swap', 'gate'];

export type Job = {
  id: number;
  serverId: string;
  name: string;
  version: string;
  /** The library entry it installs. */
  libraryId: number;
  from: string;
  actor: string;
  byName: string;
  started: number;
  steps: PackStepState[];
  /** Set by `cancel`; Prepare checks it between its parts. */
  cancelled: boolean;
  /** Where Cancel is accepted now. */
  window: 'prepare' | 'countdown' | null;
  stopped: boolean;
  touched: boolean;
  log: string[];
  backup: string | null;
  pre: string | null;
};

export const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Starts the service and waits for the Mod's hello; resolves with how long it took, or null without one. */
export async function gate(c: PacksCtx, job: Job, serviceId: string, step: 'gate' | 'rollback'): Promise<number | null> {
  const from = Date.now();
  const hello = wait(c, job.serverId, (e) => (e.type === 'connected' ? true : undefined), c.o.gateMs);
  const tick = ticker(c, () =>
    setStep(c, job, step, 'running', `${step === 'rollback' ? 'Old files back. ' : ''}Waiting for the Mod's hello: ${clock(Date.now() - from)} of ${clock(c.o.gateMs)}`),
  );
  try {
    await c.d.services.act(serviceId, 'start', job.actor, job.byName);
    return (await hello.done) ? Date.now() - from : null;
  } finally {
    hello.stop();
    tick();
  }
}

export async function backup(c: PacksCtx, job: Job, s: ServerSettings): Promise<string | null> {
  const done = wait(c, s.id, (e) => (e.type === 'backup' ? e : undefined), c.o.backupMs);
  try {
    await c.d.hub.backup(s.id, job.actor);
    const e = await done.done;
    if (!e) throw new Error(`No backup within ${formatDuration(c.o.backupMs)}.`);
    if (!e.ok) throw new Error(`The backup failed: ${e.detail}`);
  } finally {
    done.stop();
  }
  return (await listBackups(s.backupDir ?? ''))[0]?.name ?? null;
}

/** Polls the unit until it is stopped. */
export async function inactive(c: PacksCtx, serviceId: string): Promise<void> {
  const end = Date.now() + c.o.stopMs;
  for (;;) {
    const state = (await c.d.services.read(serviceId))?.state;
    if (state === 'inactive' || state === 'failed') return;
    if (Date.now() > end) throw new Error(`The service didn't stop within ${formatDuration(c.o.stopMs)}.`);
    await new Promise((r) => setTimeout(r, c.o.pollMs));
  }
}

export function cancelled(job: Job): void {
  if (job.cancelled) throw new Error('Cancelled.');
}

export async function end(c: PacksCtx, job: Job, outcome: PackFinished, staging: string): Promise<void> {
  if (c.closed) return;
  await rm(staging, { recursive: true, force: true }).catch(() => {});
  if (outcome === 'cancelled') log(c, job, 'Cancelled: the server was not touched.');
  const finished = Date.now();
  c.d.db.setPackUpdate(job.id, { outcome, finished, log: job.log.slice(-LOG_LINES).join('\n') });
  c.jobs.delete(job.serverId);
  c.d.hub.audit(job.actor, 'pack update', job.serverId, `${job.from} → ${job.version}: ${outcome}`);
  const severity: Severity = outcome === 'ok' ? 'good' : ['rolled back', 'failed', 'failed before swap'].includes(outcome) ? 'problem' : 'info';
  c.d.hub.publish(job.serverId, {
    severity,
    kind: 'packUpdateFinished',
    outcome,
    from: job.from,
    to: job.version,
    ms: finished - job.started,
    ...(outcome === 'rolled back' && job.backup && { backup: job.backup }),
  });
}

/** Sets a step's state and puts it on the stream; a step that starts is the row's current one. */
export function setStep(c: PacksCtx, job: Job, step: PackStep, state: PackStepState['state'], detail: string): void {
  if (c.closed) throw new Error('The hub is closing.');
  const i = job.steps.findIndex((x) => x.step === step);
  const was = job.steps[i];
  if (i === -1) job.steps.push({ step, state, detail });
  else job.steps[i] = { step, state, detail };
  if (state === 'running' && was?.state !== 'running') c.d.db.setPackUpdate(job.id, { step });
  if (state !== 'running') log(c, job, `${step}: ${state}${detail ? `: ${detail}` : ''}`);
  c.d.hub.publish(job.serverId, { severity: 'info', kind: 'packUpdateStep', step, state, detail, cancellable: job.window !== null });
}

export function log(c: PacksCtx, job: Job, line: string): void {
  job.log.push(line);
  c.d.db.setPackUpdate(job.id, { log: job.log.slice(-LOG_LINES).join('\n') });
}

/** Runs `fn` now and every second until the returned stop is called. */
export function ticker(c: PacksCtx, fn: () => void): () => void {
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
export function wait<T>(c: PacksCtx, serverId: string, pick: (e: HubEvent) => T | undefined, ms: number): { done: Promise<T | undefined>; stop: () => void } {
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

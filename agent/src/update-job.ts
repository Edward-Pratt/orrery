// A game update's bookkeeping (`Updates` in `update.ts`): the job as `<state>/update.json` keeps it (the agent's folder;
// nothing under the data folder is ever read for it), written before each phase acts (`save`) and read back
// shape-checked after a restart (`readJob`); the phases, the ones before the swap (cancellable, ended by a restart
// without a rollback) and the outcomes; a running update's in-memory state (`Running`: its abort, the stop step's wake,
// the step throttle's latest, held and sent steps and timers); its `updateDone` (`doneMsg`, with the backup the update
// held); and what the steps fail with (`Fail`, a step's detail; `Cancelled`, the hub's cancel). Every detail and error
// goes through `redact` (`reason`).
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMsg, FactorioMod, PackFinished, PackStep, PackStepState } from '../../hub/src/types.ts';
import { redact } from './logs.ts';
import type { UnitState } from './service.ts';
import { MOD_NAME, RELEASE, VERSION } from './update-checks.ts';
import type { UpdatesCtx } from './update-ctx.ts';
import { LIMITS } from './wire.ts';

const PHASES = ['prepare', 'backup', 'stop', 'swap', 'gate', 'rollback', 'done'] as const;
export type Phase = (typeof PHASES)[number];
/** The phases an update can still be cancelled in, and that a restart of the agent ends without a rollback. */
export const BEFORE_SWAP: readonly Phase[] = ['prepare', 'backup', 'stop'];
const OUTCOMES: readonly PackFinished[] = ['ok', 'rolled back', 'failed in staging', 'failed before swap', 'failed', 'cancelled'];

/** An update as `state/update.json` keeps it: enough to roll back, or to report, after a restart of the agent. */
export type Job = {
  id: string;
  factorio: string;
  /** The portal mods it installs. */
  mods: FactorioMod[];
  /**
   * The gate's mod set, by name: the release's own mods (`base`, …) that the staged `mod-list.json` enables (as the
   * server's current one had them; one new in the release on) and `mods`; known once prepare has the release.
   */
  expect: Record<string, string> | null;
  /** What ran before: its version, and its mods as `/orrery-status` last said (null: not known). */
  from: { factorio: string; mods: Record<string, string> | null };
  /** `updateDone`'s `from` and `to` (`labels`). */
  label: { from: string; to: string };
  /** `current`'s target before the update, `releases/X.Y.Z`. */
  previous: string;
  /**
   * The save the update holds: until the swap the pre-update save (or, the server stopped, the newest one); from the
   * swap the copy of the newest save as the stop left it (`Saves.keep`), which a rollback restores; null: none.
   */
  backup: string | null;
  /** The unit was active at the backup: a cancel finding it stopped then starts it again (the hub stopped it). */
  wasActive?: boolean;
  phase: Phase;
  outcome: PackFinished | null;
  /** The hub resumed it (`updateResume`): with `wasActive`, it stopped the server, so a failure before the swap starts the old one again. */
  resumed: boolean;
};

/**
 * Whether the hub stopped the server for the update: it resumed it, and the server ran at the backup. A server stopped
 * before the update stays stopped after one that fails before the swap. An `update.json` from before `wasActive` was
 * kept counts as having run, as an older agent took it.
 */
export const hubStopped = (job: Job): boolean => job.resumed && job.wasActive !== false;

export type StepMsg = Extract<AgentMsg, { type: 'updateStep' }>;
export type Running = {
  job: Job;
  abort: AbortController;
  /** While the update waits in its stop step: the hub's `updateResume` or `updateCancel` ends the wait. */
  wake: ((how: 'resume' | 'cancel') => void) | null;
  cancelled: boolean;
  /** The latest step, sent or held back by the throttle: sent again on each connect. */
  current: StepMsg | null;
  /** A step held back by the throttle, sent by `later` unless another goes out first. */
  pending: StepMsg | null;
  sent: Map<PackStep, { state: PackStepState['state']; at: number }>;
  later: NodeJS.Timeout | undefined;
  /** Sends a running step again once none went out for `beatMs`. */
  beat: NodeJS.Timeout | undefined;
};

/** A step that failed, with the detail it fails with. */
export class Fail extends Error {}
/** The hub cancelled the update. */
export class Cancelled extends Error {}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
export const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
export const reason = (err: unknown) => redact(err instanceof Error ? err.message : String(err));
export const stopped = (s: UnitState) => s.active === 'inactive' || s.active === 'failed';

export function check(r: Running): void {
  if (r.cancelled) throw new Cancelled('cancelled');
}

/** `update.json` as the agent wrote it (its own folder), shape-checked anyway; null if it isn't one. */
export function readJob(raw: unknown): Job | null {
  if (!isObject(raw) || !isObject(raw.from)) return null;
  const from = raw.from;
  const record = (v: unknown) => v === null || (isObject(v) && Object.values(v).every((x) => typeof x === 'string' && VERSION.test(x)));
  const ok =
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    raw.id.length <= LIMITS.text &&
    typeof raw.factorio === 'string' &&
    VERSION.test(raw.factorio) &&
    Array.isArray(raw.mods) &&
    raw.mods.length <= LIMITS.mods &&
    raw.mods.every((m) => isObject(m) && typeof m.name === 'string' && MOD_NAME.test(m.name) && typeof m.version === 'string' && VERSION.test(m.version)) &&
    record(raw.expect) &&
    typeof from.factorio === 'string' &&
    VERSION.test(from.factorio) &&
    record(from.mods) &&
    isObject(raw.label) &&
    [raw.label.from, raw.label.to].every((l) => typeof l === 'string' && l.length > 0 && l.length <= LIMITS.text) &&
    typeof raw.previous === 'string' &&
    RELEASE.test(raw.previous) &&
    (raw.backup === null || (typeof raw.backup === 'string' && raw.backup.length <= LIMITS.text && /^[^/\0]+\.zip$/.test(raw.backup))) &&
    (raw.wasActive === undefined || typeof raw.wasActive === 'boolean') &&
    PHASES.includes(raw.phase as Phase) &&
    (raw.outcome === null || OUTCOMES.includes(raw.outcome as PackFinished)) &&
    typeof raw.resumed === 'boolean';
  return ok ? (raw as unknown as Job) : null;
}

/** `<state>/update.json`. */
export const jobFile = (c: UpdatesCtx): string => join(c.o.state, 'update.json');

export async function save(c: UpdatesCtx, job: Job): Promise<void> {
  await mkdir(c.o.state, { recursive: true });
  const tmp = `${jobFile(c)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(job) + '\n');
  await rename(tmp, jobFile(c));
}

export function doneMsg(job: Job): Extract<AgentMsg, { type: 'updateDone' }> {
  const outcome = job.outcome ?? 'failed';
  const msg = { type: 'updateDone', id: job.id, outcome, from: job.label.from, to: job.label.to } as const;
  return job.backup ? { ...msg, backup: job.backup } : msg;
}

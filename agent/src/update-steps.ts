// A game update's `updateStep`s (`Updates` in `update.ts`): one per step at most once per `STEP_MS` (1 s) unless its
// state changes (a held one goes out when the second is up, never after a newer one), the latest again on `connected`
// (`send`), and a running one again, as it is, after `BEAT_MS` (60 s) without a step (never a `waiting` one, which asks
// the hub to stop the server), as the hub gives an update up after 15 minutes without a word. Of the `stop` step only
// `waiting` goes out. Every detail is cut to 2 KiB and goes through `redact`. All synchronous: no step waits.
import type { PackStep, PackStepState } from '../../hub/src/types.ts';
import { redact } from './logs.ts';
import type { UpdatesCtx } from './update-ctx.ts';
import type { Running, StepMsg } from './update-job.ts';
import { LIMITS, cut } from './wire.ts';

/**
 * An `updateStep`, cut and redacted, and logged. The stop is the hub's (docs/protocol.md, "Game updates"): of the
 * `stop` step only `waiting` goes out, and how it ended (a cancel, a restart of the agent) is only logged.
 */
export function step(c: UpdatesCtx, r: Running, step: PackStep, state: PackStepState['state'], detail: string): void {
  const msg: StepMsg = { type: 'updateStep', id: r.job.id, step, state, detail: cut(redact(detail), LIMITS.detail) };
  console.log(`[update] ${r.job.id}: ${step} ${state}: ${msg.detail}`);
  if (step === 'stop' && state !== 'waiting') return;
  emit(c, r, msg);
}

/** A download's progress, as a prepare step's detail: not logged. */
export function progressStep(c: UpdatesCtx, r: Running, detail: string): void {
  emit(c, r, { type: 'updateStep', id: r.job.id, step: 'prepare', state: 'running', detail: cut(redact(detail), LIMITS.detail) });
}

/**
 * Sends a step, unless the same step went out in the same state less than a second ago: then it is held, and sent
 * once the second is up unless another goes out first (a held one never follows a newer one).
 */
function emit(c: UpdatesCtx, r: Running, msg: StepMsg): void {
  r.current = msg;
  const last = r.sent.get(msg.step);
  const now = c.o.clock();
  if (last && last.state === msg.state && now - last.at < c.o.stepMs) {
    r.pending = msg;
    r.later ??= setTimeout(() => {
      r.later = undefined;
      const held = r.pending;
      if (held && c.running() === r) send(c, r, held);
    }, c.o.stepMs - (now - last.at));
    return;
  }
  send(c, r, msg);
}

export function send(c: UpdatesCtx, r: Running, msg: StepMsg): void {
  r.pending = null;
  r.sent.set(msg.step, { state: msg.state, at: c.o.clock() });
  c.o.send(msg);
  clearTimeout(r.beat);
  r.beat = setTimeout(() => beat(c, r), c.o.beatMs).unref();
}

/**
 * No step went out for `beatMs`: a running one goes again, as it is (through the throttle). Never a `waiting` one,
 * which asks the hub to stop the server (and the hub doesn't count its own stop as the agent's silence).
 */
function beat(c: UpdatesCtx, r: Running): void {
  r.beat = undefined;
  if (c.running() === r && r.current?.state === 'running') emit(c, r, r.current);
}

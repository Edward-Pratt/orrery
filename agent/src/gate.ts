// The start gate (docs/notes/factorio-world-settings.md): the server's starts as the Agent judges them. A start is
// good once RCON answers within 300 s of the unit becoming active; armed by a write, the gate watches the next start
// and calls it failed when the unit fails or auto-restarts before RCON answered. A start RCON answers in later than
// that is only `late`: not judged good, but not a failed start either.
import { EventEmitter } from 'node:events';
import type { UnitState } from './service.ts';

/** How long after the unit became active RCON may first answer for the start to count as good: `TimeoutStartSec`. */
export const GOOD_WITHIN_MS = 300_000;

/**
 * systemd's change times have whole seconds (`StateChangeTimestamp`, read with `--timestamp=unix`), so a change in
 * the second of a write can read as up to a second before it.
 */
const SECOND = 1000;

/** A failed start, as systemd shows it: `failed`, or waiting to restart after a run that didn't end in success. */
export const failedStart = (s: UnitState): boolean =>
  s.active === 'failed' || (s.active === 'activating' && s.sub.startsWith('auto-restart') && s.result !== 'success');

export type GateOptions = {
  /** When the gate was armed (epoch ms), as kept across restarts; null: not armed. */
  armedAt?: number | null;
  goodWithinMs?: number;
  now?: () => number;
};

/**
 * Watches the server's starts, from the unit's states (each change, `service`) and RCON's answers (`rconUp`).
 *
 * - `start`: the unit became active (or its change time moved while active: a restart between two readings), with
 *   that change time. The first reading counts, so an agent that starts while the server runs sees its run too.
 * - `good`: RCON answered for the first time in that run, within `GOOD_WITHIN_MS` of its change time; `gated` says
 *   whether it was the start the gate watched, which disarms it.
 * - `late`: RCON answered for the first time in that run, past `GOOD_WITHIN_MS` (a run the agent came to late, or a
 *   slow load): never judged good. When it was the start the gate watched, it disarms it all the same (`gated`): the
 *   server runs, so a crash of that run later is not a failed start.
 * - `failed`: armed, the unit failed or auto-restarts after a run that didn't end in success, its change time after the
 *   arming, and not the end of a run that began before the arming and that RCON answered in (that run crashing is not
 *   the watched start: the gate stays armed for the restart). It disarms.
 *
 * `arm` at each write; the caller keeps `armedAt` across restarts.
 */
export class StartGate extends EventEmitter<{ start: [number]; good: [number, boolean]; late: [number, boolean]; failed: [UnitState] }> {
  #armedAt: number | null;
  #goodWithinMs: number;
  #now: () => number;
  /** The run seen active: its change time and whether RCON answered in it; null while the unit isn't running. */
  #run: { since: number; answered: boolean } | null = null;

  constructor(o: GateOptions = {}) {
    super();
    this.#armedAt = o.armedAt ?? null;
    this.#goodWithinMs = o.goodWithinMs ?? GOOD_WITHIN_MS;
    this.#now = o.now ?? Date.now;
  }

  /** When it was armed (epoch ms), null when not armed. */
  get armedAt(): number | null {
    return this.#armedAt;
  }

  /** Watches the next start from now on (a write the next start reads). */
  arm(): void {
    this.#armedAt = this.#now();
  }

  /** Each unit state in turn. */
  service(s: UnitState): void {
    if (s.active === 'active') {
      if (this.#run?.since === s.since) return;
      this.#run = { since: s.since, answered: false };
      this.emit('start', s.since);
      return;
    }
    const run = this.#run;
    const failed = failedStart(s);
    if (failed || s.active === 'inactive') this.#run = null;
    const armedAt = this.#armedAt;
    if (!failed || armedAt === null) return;
    if (s.since + SECOND <= armedAt) return; // a state from before the write
    if (run?.answered && run.since + SECOND <= armedAt) return; // the run the write was made in ended: not the watched start
    this.#armedAt = null;
    this.emit('failed', s);
  }

  /** RCON answered. */
  rconUp(): void {
    const run = this.#run;
    if (!run || run.answered) return;
    run.answered = true;
    const gated = this.#armedAt !== null && run.since + SECOND > this.#armedAt;
    if (gated) this.#armedAt = null;
    this.emit(this.#now() - run.since > this.#goodWithinMs ? 'late' : 'good', run.since, gated);
  }
}

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AgentMsg } from '../../hub/src/types.ts';
import { LIMITS } from './wire.ts';

/** A unit's state as `serviceState` carries it. */
export type UnitState = Omit<Extract<AgentMsg, { type: 'serviceState' }>, 'type'>;

/** Runs systemctl with these arguments and resolves with its stdout. */
export type Systemctl = (args: string[]) => Promise<string>;

/** systemctl from `bin` (a name found on PATH, or a path), through execFile: no shell, and argv only the agent's own. */
export const systemctl =
  (bin = 'systemctl'): Systemctl =>
  (args) =>
    new Promise((resolve, reject) =>
      execFile(bin, args, { timeout: 10_000, maxBuffer: 64 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
    );

/** The properties read, with `--timestamp=unix` so the change time is `@<seconds>` (systemd 251 and later). */
export const showArgs = (unit: string) => ['show', '--timestamp=unix', '--property=ActiveState,SubState,Result,StateChangeTimestamp', '--', unit];

/** `systemctl show`'s `Key=Value` lines as a `UnitState`; `since` is 0 when the unit never changed state. */
export function parseShow(unit: string, out: string): UnitState {
  const props = new Map<string, string>();
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1).slice(0, LIMITS.text));
  }
  const at = /^@(\d+)$/.exec(props.get('StateChangeTimestamp') ?? '');
  return {
    unit,
    active: props.get('ActiveState') ?? '',
    sub: props.get('SubState') ?? '',
    since: at ? Number(at[1]) * 1000 : 0,
    result: props.get('Result') ?? '',
  };
}

const same = (a: UnitState, b: UnitState) => a.active === b.active && a.sub === b.sub && a.since === b.since && a.result === b.result;

/**
 * Watches the server's unit: `systemctl show` every 5 s, `change` on the first reading and on each change after.
 * A failed read keeps the last state and is logged once until a read works again.
 */
export class ServiceWatch extends EventEmitter<{ change: [UnitState] }> {
  #unit: string;
  #run: Systemctl;
  #intervalMs: number;
  #state: UnitState | null = null;
  #failing = false;
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;

  constructor(unit: string, run: Systemctl = systemctl(), intervalMs = 5000) {
    super();
    this.#unit = unit;
    this.#run = run;
    this.#intervalMs = intervalMs;
  }

  /** The latest state read; null before the first. */
  get state(): UnitState | null {
    return this.#state;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#loop();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  async #loop(): Promise<void> {
    try {
      const state = parseShow(this.#unit, await this.#run(showArgs(this.#unit)));
      if (this.#failing) console.log(`[service] reading ${this.#unit} works again`);
      this.#failing = false;
      if (!this.#stopped && (!this.#state || !same(this.#state, state))) {
        this.#state = state;
        this.emit('change', state);
      }
    } catch (err) {
      if (!this.#failing) console.error(`[service] can't read ${this.#unit}: ${(err as Error).message}`);
      this.#failing = true;
    }
    if (!this.#stopped) this.#timer = setTimeout(() => void this.#loop(), this.#intervalMs);
  }
}

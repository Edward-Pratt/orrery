import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AgentMsg, ServiceVerb } from '../../hub/src/types.ts';
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

/**
 * A verb on the agent's own unit: `--no-block`, so systemctl returns once the job is queued and a long shutdown save
 * never holds the hub's request (its reply has 30 s).
 */
export const actArgs = (verb: ServiceVerb, unit: string) => [verb, '--no-block', '--', unit];

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
 * The server's unit: `systemctl show` every 5 s, `change` on the first reading and on each change after (a failed read
 * keeps the last state and is logged once until a read works again); `read` for a fresh reading; `act` for start,
 * stop and restart, which emits `stopping` once systemctl took a stop or a restart: a stop the agent started itself.
 */
export class ServiceWatch extends EventEmitter<{ change: [UnitState]; stopping: [] }> {
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

  /** The unit's state now, not the latest poll's: for decisions such as a restore, which needs it stopped. */
  async read(): Promise<UnitState> {
    return parseShow(this.#unit, await this.#run(showArgs(this.#unit)));
  }

  /**
   * `systemctl <verb> --no-block -- <unit>` on the agent's own unit, the only one it ever acts on. A stop or restart
   * that systemctl took emits `stopping`, so the game connection says so before Factorio goes; a refusal (polkit)
   * rejects, and nothing is emitted.
   */
  async act(verb: ServiceVerb): Promise<void> {
    try {
      await this.#run(actArgs(verb, this.#unit));
    } catch (err) {
      throw new Error(`systemctl ${verb} ${this.#unit} failed: ${(err as Error).message.trim()}`);
    }
    console.log(`[service] ${verb} ${this.#unit}`);
    if (verb !== 'start') this.emit('stopping');
  }

  async #loop(): Promise<void> {
    try {
      const state = await this.read();
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

/** How a run of the unit ended, as the hub must hear it: `stopped` (`stopping`, then the close) or `crashed` (the close alone). */
export type RunEnd = { how: 'stopped' | 'crashed'; since: number };

/**
 * The stopping rule for changes the agent didn't start (a crash, an in-game or console `/quit`, a stop by hand): a run
 * is the unit `active` since one change time; it ends at a final state, `inactive`, `failed`, or `activating` with an
 * auto-restart, and that state's `Result` says how (`success`: stopped; anything else: crashed). `deactivating` alone
 * decides nothing: a Quadlet unit passes through `deactivating (stop-post)` on a crash too. A run whose change time
 * moved while active (a restart between two readings) ended with the `Result` read then; a crash can't hide that way,
 * since its auto-restart waits 10 s (`RestartSec`) in `activating`, longer than a poll.
 */
export class RunWatch {
  #open: number | null = null;

  /** The change time of the run being watched; null while the unit isn't running. */
  get run(): number | null {
    return this.#open;
  }

  /** Each unit state in turn: how the run being watched ended, once that is known; else null. */
  next(s: UnitState): RunEnd | null {
    const open = this.#open;
    if (s.active === 'active') {
      this.#open = s.since;
      return open !== null && open !== s.since ? { how: s.result === 'success' ? 'stopped' : 'crashed', since: open } : null;
    }
    if (open === null) return null;
    const final = s.active === 'inactive' || s.active === 'failed' || (s.active === 'activating' && s.sub.startsWith('auto-restart'));
    if (!final) return null;
    this.#open = null;
    return { how: s.result === 'success' ? 'stopped' : 'crashed', since: open };
  }
}

import { EventEmitter } from 'node:events';
import { constants, open, type FileHandle } from 'node:fs/promises';
import { Rcon } from './rcon.ts';
import { LIMITS } from './wire.ts';

/**
 * `/orrery-status`'s answer (factorio/CLAUDE.md): `game.tick`, `game.tick_paused`, the online players' names, the
 * game's version and `script.active_mods`, the orrery mod's own version picked out of them.
 */
export type Status = {
  tick: number;
  tickPaused: boolean;
  players: string[];
  version: string;
  mods: Record<string, string>;
  modVersion: string;
};

/** One answer as the hub's heartbeat needs it. */
export type Reading = {
  /** Updates per second since the previous answer: null for the first of a connection, or when the tick went back. */
  ups: number | null;
  players: string[];
  /** Auto-paused with nobody on, `tick_paused`, or a stalled tick with players on: the rate means nothing then. */
  paused: boolean;
  /** The orrery mod's version, for the game connection's hello. */
  modVersion: string;
};

const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
/** Far over any real server-settings.json (a few KiB); a bigger file is not read. */
const SETTINGS_MAX = 1024 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The online players: names of 1 to 64 characters, at most 200 (the hub refuses a heartbeat with more). */
function names(v: unknown): string[] | null {
  if (isObject(v) && Object.keys(v).length === 0) return []; // table_to_json writes an empty table as {}
  if (!Array.isArray(v)) return null;
  return v.filter((n): n is string => typeof n === 'string' && n.length > 0 && n.length <= LIMITS.player).slice(0, LIMITS.players);
}

/**
 * `/orrery-status`'s reply, read defensively: RCON output is untrusted (any mod, or anyone with the password, can
 * shape it), so anything off is no status at all (null), never a half-filled one. Names and versions that don't fit
 * the wire are dropped.
 */
export function parseStatus(reply: string): Status | null {
  let raw: unknown;
  try {
    raw = JSON.parse(reply);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.ok !== true) return null;
  const { tick, version } = raw;
  if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < 0) return null;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  const players = names(raw.players);
  if (!players || !isObject(raw.mods)) return null;
  const mods = Object.fromEntries(
    Object.entries(raw.mods)
      .filter((e): e is [string, string] => e[0].length <= LIMITS.text && typeof e[1] === 'string' && VERSION.test(e[1]))
      .slice(0, LIMITS.mods),
  );
  const modVersion = Object.hasOwn(mods, 'orrery') ? mods.orrery : undefined;
  if (modVersion === undefined) return null;
  return { tick, tickPaused: raw.tick_paused === true, players, version, mods, modVersion };
}

/**
 * Whether `auto_pause` is on in `server-settings.json`, as a plain boolean; false if it can't be read. The container
 * writes that file, so it is opened without following a symlink or blocking on a FIFO, read only if it is a small
 * regular file, and it only ever decides alerting.
 */
export async function readAutoPause(file: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await handle.stat();
    if (!st.isFile() || st.size > SETTINGS_MAX) return false;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buf, 0, st.size, 0);
    const settings: unknown = JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
    return isObject(settings) && settings.auto_pause === true;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/** The previous answer's tick and when it came (ms, any clock that only goes forward). */
export type Previous = { tick: number; at: number };

/**
 * One answer as a `Reading`. UPS is Δtick / Δwall time since `prev`; each RCON command runs one tick, so an
 * auto-paused server shows about 0.2. Paused: `tick_paused`; or nobody on with `auto_pause`; or players on and the
 * tick moved at most 1 since the previous answer (an admin's pause that doesn't set `tick_paused`).
 */
export function reading(status: Status, at: number, autoPause: boolean, prev: Previous | null): Reading {
  const delta = prev && status.tick >= prev.tick && at > prev.at ? status.tick - prev.tick : null;
  const ups = delta === null ? null : Math.round((delta / ((at - prev!.at) / 1000)) * 100) / 100;
  const online = status.players.length > 0;
  const paused = status.tickPaused || (!online && autoPause) || (online && delta !== null && delta <= 1);
  return { ups, players: status.players, paused, modVersion: status.modVersion };
}

export type PollerOptions = {
  port: number;
  password: string;
  /** The server's `server-settings.json`, for `auto_pause`. */
  settings: string;
  host?: string;
  intervalMs?: number;
  /** For connecting and for each command; under the interval. */
  timeoutMs?: number;
  now?: () => number;
};

/**
 * Polls `/orrery-status` over RCON every 5 s, on one RCON connection kept open (a new one after it ends). Emits
 * `status` after each successful round trip, and only then: the heartbeat follows RCON, never a timer. Emits `down`
 * once when RCON stops answering (or answers without a status). Logs once per change between the two.
 */
export class StatusPoller extends EventEmitter<{ status: [Reading]; down: [string] }> {
  #o: Required<PollerOptions>;
  #rcon: Rcon | null = null;
  #prev: Previous | null = null;
  #players: string[] = [];
  #up: boolean | null = null;
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;

  constructor(options: PollerOptions) {
    super();
    this.#o = { host: '127.0.0.1', intervalMs: 5000, timeoutMs: 4000, now: () => performance.now(), ...options };
  }

  /** The players online at the latest answer; none while RCON is down. */
  get players(): readonly string[] {
    return this.#players;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#loop();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#rcon?.close();
    this.#rcon = null;
  }

  async #loop(): Promise<void> {
    const started = this.#o.now();
    await this.#poll();
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#loop(), Math.max(0, this.#o.intervalMs - (this.#o.now() - started)));
  }

  async #poll(): Promise<void> {
    const o = this.#o;
    try {
      if (!this.#rcon) {
        const rcon = await Rcon.connect(o.host, o.port, o.password, o.timeoutMs);
        if (this.#stopped) return rcon.close();
        rcon.on('close', () => {
          if (this.#rcon === rcon) this.#rcon = null;
        });
        this.#rcon = rcon;
        this.#prev = null;
      }
      const reply = await this.#rcon.exec('/orrery-status', o.timeoutMs);
      const at = o.now();
      const status = parseStatus(reply);
      if (!status) throw new Error('/orrery-status gave no status (is the orrery mod loaded?)');
      const r = reading(status, at, await readAutoPause(o.settings), this.#prev);
      if (this.#stopped) return;
      this.#prev = { tick: status.tick, at };
      this.#players = r.players;
      if (this.#up !== true) console.log('[rcon] /orrery-status answers');
      this.#up = true;
      this.emit('status', r);
    } catch (err) {
      if (this.#stopped) return;
      this.#prev = null;
      this.#players = [];
      if (this.#up !== false) {
        const why = (err as Error).message;
        console.log(`[rcon] not answering: ${why}`);
        this.#up = false;
        this.emit('down', why);
      }
    }
  }
}

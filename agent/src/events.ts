// The Factorio mod's game events, both ways (factorio/CLAUDE.md): its UDP datagrams in, checked and turned into the
// game connection's messages, and the hub's say, notice and linkResult out, as the mod's RCON commands.
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { constants, open, type FileHandle } from 'node:fs/promises';
import type { ModMsg } from '../../hub/src/types.ts';
import type { UnitState } from './service.ts';
import { LIMITS, type ToGame } from './wire.ts';

/** The game connection's messages that come from the mod's datagrams. */
export type GameEvent = Extract<ModMsg, { type: 'chat' | 'join' | 'leave' | 'death' | 'milestone' | 'link' | 'unlink' }>;

/** The most bytes of JSON in one datagram: the mod shortens its text to fit, so a bigger one is not the mod's. */
export const MAX_DATAGRAM = 4096;
/** Far over where Factorio logs its sockets (startup, before any map is loaded); the rest of the log is not read. */
const HEAD_MAX = 1024 * 1024;
const CODE = /^[A-Za-z0-9]{1,16}$/;
type Kind = Extract<GameEvent, { type: 'milestone' }>['kind'];
const KINDS: readonly string[] = ['research', 'rocket', 'platform', 'landing'] satisfies Kind[];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A player (or force) name as the hub takes it: 1 to 64 characters; else null. */
const name = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= LIMITS.player ? v : null);
/** Text cut to the hub's limit for chat and milestones, never leaving half a surrogate pair; null if not a string. */
function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.length <= LIMITS.message) return v;
  const cut = v.slice(0, LIMITS.message);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The hub's death `message`, which it posts as is, so a whole sentence with the player's name: killed by a player
 * (`killer`), by an entity (`cause`, its internal name made readable: `medium-biter` is "a medium biter"), or died.
 */
export function deathMessage(player: string, cause: string | null, killer: string | null): string {
  if (killer) return `${player} was killed by ${killer}`;
  if (!cause) return `${player} died`;
  const what = cause.replace(/[-_]/g, ' ');
  return `${player} was killed by ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}`;
}

/** A datagram as read: an event and its `seq`, or the mod's `hello` (`event` null: only a `seq`). */
export type Datagram = { seq: number; event: GameEvent | null };

/**
 * One datagram of the mod's (factorio/CLAUDE.md, "Mod to agent: UDP"), read as untrusted: JSON with a `t` and a `seq`
 * (a safe integer, 0 or more), the fields of its kind checked against the hub's limits and copied, no others. A
 * required name that doesn't fit drops the event; an optional one (a milestone's `player` or `force`, a death's
 * `cause` or `killer`) is left out; `message` and `text` are cut to fit. A string says why it was dropped.
 */
export function parseDatagram(data: Buffer): Datagram | string {
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString('utf8'));
  } catch {
    return 'not JSON';
  }
  if (!isObject(raw) || typeof raw.t !== 'string') return 'no t';
  const { seq } = raw;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return 'no seq';
  if (raw.t === 'hello') return { seq, event: null };
  const event = toEvent(raw.t, raw);
  return typeof event === 'string' ? event : { seq, event };
}

function toEvent(t: string, raw: Record<string, unknown>): GameEvent | string {
  const player = name(raw.player);
  switch (t) {
    case 'chat': {
      const message = text(raw.message);
      return player && message !== null ? { type: 'chat', player, message } : 'a chat without a player or message';
    }
    case 'join':
    case 'leave': // its reason is not on the wire: the hub's leave has only the player
    case 'unlink':
      return player ? { type: t, player } : `a ${t} without a player`;
    case 'death':
      return player ? { type: 'death', player, message: deathMessage(player, name(raw.cause), name(raw.killer)) } : 'a death without a player';
    case 'milestone': {
      const { kind } = raw;
      const subject = text(raw.text);
      if (typeof kind !== 'string' || !KINDS.includes(kind) || subject === null) return 'a milestone without a kind or text';
      const m: Extract<GameEvent, { type: 'milestone' }> = { type: 'milestone', kind: kind as Kind, text: subject };
      const force = name(raw.force);
      if (player) m.player = player;
      if (force) m.force = force;
      return m;
    }
    case 'link':
      // Factorio has no player UUIDs: the hub links a factorio server's player by name (docs/protocol.md).
      return player && typeof raw.code === 'string' && CODE.test(raw.code) ? { type: 'link', player, uuid: '', code: raw.code } : 'a link without a player or code';
    default:
      return 'an unknown kind of event';
  }
}

/** An engine line of the log (seconds since start, level, `File.cpp:N:`), so a chat line or a mod's `log()` can't pass for one. */
const ENGINE = String.raw`^ *\d+\.\d+ \w+ [\w.]+:\d+: `;
const FAILED = new RegExp(ENGINE + 'Opening Lua UDP Socket failed');

/**
 * What a log says about Factorio's Lua UDP socket: `on` once it has the line Factorio writes when it binds the socket
 * on 127.0.0.1:`port` (`Opening socket at (IP ADDR:({127.0.0.1:34198}))`), `off` once it has `Opening Lua UDP Socket
 * failed` (the port was taken), whichever comes first; null for neither. Only whole lines count.
 */
export function socketState(log: string, port: number): 'on' | 'off' | null {
  const opened = new RegExp(ENGINE + String.raw`Opening socket at \(IP ADDR:\(\{127\.0\.0\.1:${port}\}\)\)$`);
  const lines = log.split('\n');
  lines.pop(); // what follows the last newline is a line still being written (or nothing)
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (opened.test(line)) return 'on';
    if (FAILED.test(line)) return 'off';
  }
  return null;
}

/**
 * The head of Factorio's log if it was written at or after `freshAfter` (epoch ms), else null (or if it can't be
 * read). The container writes it, so no symlink is followed, nothing blocks, and only a regular file is read, up to
 * `HEAD_MAX` bytes.
 */
async function readHead(file: string, freshAfter: number): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await handle.stat();
    if (!st.isFile() || st.mtimeMs < freshAfter) return null;
    const buf = Buffer.alloc(Math.min(st.size, HEAD_MAX));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Game events the agent forwards to the hub, all kinds together: 5 a second sustained, 30 at once. The hub drops a
 * connection's lines over 20 a second (100 at once) and closes one that stays over that for 10 s, so a player
 * spamming chat can never take the game connection, and its heartbeats, down with it.
 */
export const EVENT_RATE = 5;
export const EVENT_BURST = 30;
/** The events dropped over the budget are counted in one log line a minute at most. */
export const DROP_LOG_MS = 60_000;

/**
 * The game events' budget, `EVENT_RATE` a second and `EVENT_BURST` at once, on a monotonic clock (ms): a cell-rate
 * check, so a full burst comes back after a quiet 6 s and nothing builds up past it. `take` says whether one more
 * event goes now. What it refuses is counted: the first refusal starts a minute, at whose end (or at `flush`) one line
 * logs the count.
 */
export class EventBudget {
  #now: () => number;
  /** When the next event would be on time; it may run up to `EVENT_BURST - 1` intervals ahead of the clock. */
  #due = -Infinity;
  #dropped = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  take(): boolean {
    const now = this.#now();
    const interval = 1000 / EVENT_RATE;
    const due = Math.max(this.#due, now);
    if (due - now <= (EVENT_BURST - 1) * interval) {
      this.#due = due + interval;
      return true;
    }
    if (this.#dropped++ === 0) this.#timer = setTimeout(() => this.flush(), DROP_LOG_MS);
    return false;
  }

  /** Logs the count dropped since the minute started, if any, and ends that minute. */
  flush(): void {
    clearTimeout(this.#timer);
    const n = this.#dropped;
    if (n === 0) return;
    this.#dropped = 0;
    console.log(`[events] dropped ${n} game event${n === 1 ? '' : 's'} in the last minute: over ${EVENT_RATE} a second (${EVENT_BURST} at once)`);
  }
}

/**
 * Whether UDP events are taken: `closed` while the unit isn't active; after each start `checking` until the log
 * decides, then `on`, or `off` until the next start.
 */
export type Gate = 'closed' | 'checking' | 'on' | 'off';

export type EventsOptions = {
  /** The agent's UDP port on 127.0.0.1 (`agentUdpPort`, 34199; the mod sends there). */
  port: number;
  /** Factorio's Lua UDP port (`factorioUdpPort`, 34198): the only source port taken. */
  factorioPort: number;
  /** `factorio-current.log` in the server's data folder. */
  log: string;
  /** The players online at the latest `/orrery-status`: a link or unlink names one of them, or is dropped. */
  players: () => readonly string[];
  /** Runs an RCON command (for `/orrery-hello`); rejects when RCON can't run it. */
  run: (command: string) => Promise<string>;
  /** How long after a start the log may take to show either line. */
  deadlineMs?: number;
  pollMs?: number;
  /** How long after `/orrery-hello`'s answer its datagram may take before that is logged. */
  helloMs?: number;
  /** Between attempts to listen when the port is taken. */
  retryMs?: number;
  /** The event budget's monotonic clock (ms; `performance.now`). */
  now?: () => number;
};

/**
 * The mod's game events: a UDP listener on 127.0.0.1:`port` taking datagrams only from 127.0.0.1:`factorioPort`, and
 * only while the unit is active and, after each start, once `factorio-current.log` shows Factorio bound that port
 * itself (so no other local process took it first). A log not written since the agent saw the unit stopped (or, for
 * a restart between two readings, since the second after it became active) is the previous run's, which Factorio
 * has not replaced yet, so it is read again until it is. `Opening Lua UDP Socket failed`, or neither line within
 * 60 s, turns events off until the next start, logged once. A datagram over 4 KiB, or that isn't the mod's shape,
 * is dropped, and so is a `link` or `unlink` for a player not online; each kind of drop is logged once per start.
 * Gaps in `seq` are logged; its baseline is the `hello` datagram that `/orrery-hello` makes the mod send, once per
 * start after the gate opens and RCON answers. Emits each event as the game connection's message, within
 * `EventBudget` (5 a second, 30 at once; the rest dropped, counted in the log once a minute).
 */
export class GameEvents extends EventEmitter<{ event: [GameEvent] }> {
  #o: Required<EventsOptions>;
  #socket: Socket | null = null;
  #bound: number | null = null;
  #retry: NodeJS.Timeout | undefined;
  #listenFailed = false;
  #stopped = true;
  #unit: UnitState | null = null;
  /** When the agent last saw the unit with no Factorio running (inactive, failed or activating), since the last start. */
  #endedAt: number | null = null;
  #gate: Gate = 'closed';
  /** Counts starts and stops, so a log read or a hello from an earlier run is ignored. */
  #run = 0;
  #timer: NodeJS.Timeout | undefined;
  #helloTimer: NodeJS.Timeout | undefined;
  #hello: 'none' | 'sent' | 'answered' | 'came' = 'none';
  #last: number | null = null;
  #dropped = new Set<string>();
  #budget: EventBudget;

  constructor(options: EventsOptions) {
    super();
    this.#o = { deadlineMs: 60_000, pollMs: 1000, helloMs: 5000, retryMs: 10_000, now: () => performance.now(), ...options };
    this.#budget = new EventBudget(this.#o.now);
  }

  get gate(): Gate {
    return this.#gate;
  }

  /** The UDP port listened on; null until it is bound. */
  get bound(): number | null {
    return this.#bound;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#listen();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
    this.#close();
    this.#socket?.close();
    this.#socket = null;
    this.#bound = null;
    this.#budget.flush();
  }

  /** The unit's state, on each change: a start (it became active, or its change time moved while active) opens a check of the log. */
  service(state: UnitState): void {
    const prev = this.#unit;
    this.#unit = state;
    if (state.active !== 'active') {
      if (state.active === 'inactive' || state.active === 'failed' || state.active === 'activating') this.#endedAt = Date.now();
      if (this.#gate !== 'closed') this.#close();
      return;
    }
    if (prev?.active === 'active' && prev.since === state.since) return; // the same run
    const freshAfter = this.#endedAt ?? state.since + 1000; // `since` is whole seconds
    this.#endedAt = null;
    this.#begin(freshAfter);
  }

  /** RCON answered `/orrery-status`: the first time after the gate opens, `/orrery-hello` asks the mod for its `seq`. */
  rconUp(): void {
    if (this.#gate !== 'on' || this.#hello !== 'none') return;
    this.#hello = 'sent';
    const run = this.#run;
    this.#o.run('/orrery-hello').then(
      (reply) => {
        if (run !== this.#run || this.#hello !== 'sent') return;
        this.#hello = 'answered';
        if (!answeredOk(reply)) return console.error(`[events] /orrery-hello answered ${JSON.stringify(reply.slice(0, 200))}`);
        this.#helloTimer = setTimeout(() => {
          console.error(`[events] no hello datagram came on UDP 127.0.0.1:${this.#o.port}: the mod sends to 34199 from ${this.#o.factorioPort}; are the ports right?`);
        }, this.#o.helloMs);
      },
      (err: Error) => {
        if (run !== this.#run) return;
        if (this.#hello === 'sent') this.#hello = 'none'; // RCON didn't run it: again at the next answer
        console.error(`[events] can't send /orrery-hello: ${err.message}`);
      },
    );
  }

  #listen(): void {
    if (this.#stopped) return;
    const socket = createSocket('udp4');
    this.#socket = socket;
    let bound = false;
    socket.on('message', (data, from) => this.#packet(data, from));
    socket.on('error', (err) => {
      if (bound) return console.error(`[events] UDP: ${err.message}`);
      try {
        socket.close();
      } catch {
        // never bound: nothing to close
      }
      if (this.#socket === socket) this.#socket = null;
      if (!this.#listenFailed) console.error(`[events] can't listen on UDP 127.0.0.1:${this.#o.port} (${err.message}): retrying`);
      this.#listenFailed = true;
      if (!this.#stopped) this.#retry = setTimeout(() => this.#listen(), this.#o.retryMs);
    });
    socket.bind({ address: '127.0.0.1', port: this.#o.port }, () => {
      bound = true;
      this.#bound = socket.address().port;
      this.#listenFailed = false;
      console.log(`[events] listening on UDP 127.0.0.1:${this.#bound}`);
    });
  }

  /** Closes the gate: no events until the next start. */
  #close(): void {
    this.#run++;
    this.#gate = 'closed';
    clearTimeout(this.#timer);
    clearTimeout(this.#helloTimer);
    this.#dropped.clear();
  }

  #begin(freshAfter: number): void {
    this.#close();
    this.#gate = 'checking';
    this.#hello = 'none';
    this.#last = null; // the map may have rewound (a crash or a restore): the next hello is the baseline
    const run = this.#run;
    const until = Date.now() + this.#o.deadlineMs;
    const look = async (): Promise<void> => {
      const head = await readHead(this.#o.log, freshAfter);
      if (run !== this.#run) return;
      const state = head === null ? null : socketState(head, this.#o.factorioPort);
      if (state === 'on') {
        this.#gate = 'on';
        return console.log(`[events] on: Factorio opened its Lua UDP socket on 127.0.0.1:${this.#o.factorioPort}`);
      }
      if (state === 'off' || Date.now() >= until) {
        this.#gate = 'off';
        const why =
          state === 'off'
            ? `Factorio could not open its Lua UDP socket (is 127.0.0.1:${this.#o.factorioPort} taken?)`
            : `no "Opening socket" line for 127.0.0.1:${this.#o.factorioPort} in ${this.#o.log} within ${this.#o.deadlineMs / 1000} s`;
        return console.error(`[events] game events are off until Factorio starts again: ${why}`);
      }
      this.#timer = setTimeout(() => void look(), this.#o.pollMs);
    };
    void look();
  }

  #drop(kind: string, why: string): void {
    if (this.#dropped.has(kind)) return;
    this.#dropped.add(kind);
    console.log(`[events] dropped a datagram: ${why} (logged once until Factorio starts again)`);
  }

  #packet(data: Buffer, from: RemoteInfo): void {
    const port = this.#o.factorioPort;
    if (from.family !== 'IPv4' || from.address !== '127.0.0.1' || from.port !== port) {
      return this.#drop('source', `from ${from.address}:${from.port}, not Factorio's 127.0.0.1:${port}`);
    }
    if (this.#gate !== 'on') {
      const why = { closed: 'the server is not running', checking: "Factorio's Lua UDP socket is not confirmed yet", off: 'game events are off' }[this.#gate];
      return this.#drop('gate', why);
    }
    if (data.length > MAX_DATAGRAM) return this.#drop('size', `${data.length} bytes, over ${MAX_DATAGRAM}`);
    const d = parseDatagram(data);
    if (typeof d === 'string') return this.#drop(d, d);
    this.#seq(d.seq, d.event === null);
    const event = d.event;
    if (!event) return;
    if ((event.type === 'link' || event.type === 'unlink') && !this.#o.players().includes(event.player)) {
      return this.#drop('offline', `a ${event.type} for a player not online`);
    }
    if (!this.#budget.take()) return; // over the budget: counted, and its seq taken above, so no gap is logged
    this.emit('event', event);
  }

  #seq(seq: number, hello: boolean): void {
    const last = this.#last;
    this.#last = seq;
    if (hello) {
      // The mod's hello is the last event's seq, not one of its own: the next event is seq + 1.
      clearTimeout(this.#helloTimer);
      if (this.#hello !== 'came') console.log(`[events] the mod's hello came: seq ${seq}`);
      this.#hello = 'came';
      return;
    }
    if (last === null || seq === last + 1) return;
    if (seq > last + 1) {
      const lost = seq - last - 1;
      console.log(`[events] ${lost} game event${lost === 1 ? '' : 's'} lost: seq ${lost === 1 ? last + 1 : `${last + 1} to ${seq - 1}`} never came`);
    }
    else console.log(`[events] seq went back from ${last} to ${seq}`);
  }
}

/** Whether a mod command's reply is `{"ok": true, …}` (JSON from `table_to_json`, its keys in any order). */
function answeredOk(reply: string): boolean {
  try {
    const r: unknown = JSON.parse(reply);
    return isObject(r) && r.ok === true;
  } catch {
    return false;
  }
}

/**
 * JSON for an RCON command's argument: `JSON.stringify` (control characters escaped, so never a newline), with the
 * characters it leaves as they are but that a console line shouldn't carry escaped too (DEL, the C1 controls, the
 * line and paragraph separators). Plain JSON either way, which `helpers.json_to_table` reads.
 */
export function commandJson(value: object): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The mod's RCON command for a message from the hub (factorio/CLAUDE.md, "Agent to mod"): `say` is `/orrery-say
 * {author, message, source}`, `notice` `/orrery-notice {message}`, `linkResult` `/orrery-reply {player, ok, message}`.
 * One line with a JSON argument: never Lua, never `/c` or `/sc` (the mod makes the text safe to print).
 */
export function toCommand(msg: ToGame): string {
  switch (msg.type) {
    case 'say':
      return `/orrery-say ${commandJson({ author: msg.author, message: msg.message, source: msg.source })}`;
    case 'notice':
      return `/orrery-notice ${commandJson({ message: msg.message })}`;
    case 'linkResult':
      return `/orrery-reply ${commandJson({ player: msg.player, ok: msg.ok, message: msg.message })}`;
  }
}

/** Carries out a message from the hub in game over RCON; a failure or an answer other than `{"ok":true}` is logged. */
export async function toGame(run: (command: string) => Promise<string>, msg: ToGame): Promise<void> {
  try {
    const reply = await run(toCommand(msg));
    if (!answeredOk(reply)) console.error(`[game] ${msg.type} was not shown: ${JSON.stringify(reply.slice(0, 200))}`);
  } catch (err) {
    console.error(`[game] ${msg.type} was not shown: ${(err as Error).message}`);
  }
}

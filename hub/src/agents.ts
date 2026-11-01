import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import type { AgentConfig, AgentsIntegration } from './config.ts';
import type { Hosts } from './host.ts';
import { LIMITS, parseAgentLine, parseModLine, parseReplyData, type AgentHello, type AgentMsg, type AgentReplyData, type AgentRequest, type Hello, type HubAgentMsg, type ModMsg } from './protocol.ts';
import { protocolRefusal, tokenMatches, type ServerHub } from './servers.ts';

/** Shorter timings, for tests. */
export type AgentsOptions = {
  /** How long a connection may wait before its first line (5 s). */
  helloTimeoutMs?: number;
  /** How long an Agent connection may go without a line before its Agent is lost (20 s; it pings every 10 s). */
  silenceMs?: number;
  /** How long a request waits for its reply (30 s). */
  requestTimeoutMs?: number;
  /** How often the listener asks for its address again while that isn't on this machine yet (10 s). */
  bindRetryMs?: number;
  /**
   * How soon after its last welcome an Agent connection, or a game connection for the same server, may be welcomed
   * again (`HANDSHAKE_MS`, 5 s); one sooner is refused and the live one stays.
   */
  handshakeMs?: number;
  /**
   * Every connection's line budget (`LINES`: 20 lines a second, in bursts of up to 100): lines over it are dropped, and
   * a connection still over it `overMs` (10 s) on is closed. The per-type budgets (`TYPES`) and the host sample cadence
   * (`SAMPLE_MS`) are not options.
   */
  rate?: Rate;
};

type Rate = { perSecond: number; burst: number; overMs: number };

/** What an Agent pushes on its own, put on the `Agents` emitter as it came (a copy of only its schema's fields). */
type Pushed = Exclude<AgentMsg, { type: 'ping' | 'bye' | 'hostSample' | 'events' | 'reply' }>;

/**
 * `Agents`' events, each with the Agent's id: `agentUp` (its Agent connection was welcomed, every time), `agentLost`
 * (it went silent, or closed without `bye`) and `agentBack` (it connected again after that), and what it pushes.
 */
export type AgentEvents = { agentUp: [agentId: string]; agentLost: [agentId: string]; agentBack: [agentId: string] } & {
  [T in Pushed['type']]: [agentId: string, msg: Extract<Pushed, { type: T }>];
};

/** A request without its id, which `request` adds. */
export type AgentCall = AgentRequest extends infer R ? (R extends AgentRequest ? Omit<R, 'id'> : never) : never;
/** What a request's promise resolves to: its reply's checked `data`, for the requests that answer with data. */
export type AgentAnswer<T extends AgentRequest['type']> = T extends keyof AgentReplyData ? AgentReplyData[T] : void;
const WITH_DATA = new Set<string>(['journal', 'logs', 'log', 'settingsSet'] satisfies (keyof AgentReplyData)[]);

/** An Agent as the registry knows it: `version` is what its latest `agentHello` announced, kept after it leaves. */
export type AgentStatus = { id: string; name: string; server: string; connected: boolean; version: string | null };

/**
 * The first Agent release with game updates and its own deploys (release 2, `docs/ROADMAP.md`): `agent-v1.0.0` has
 * neither, and updates only by the friend re-running `setup-agent-host.sh` at a newer `agent-v` tag.
 */
export const AGENT_FLOOR = 'agent-v1.1.0';

/**
 * Whether an Agent's release (its hello's `agentVersion`, `agent-vX.Y.Z` or a bare version) is older than
 * `AGENT_FLOOR`. `agent-v0.0.0` is the repo's own version (the dev loop, which has both) and is not; nor is anything
 * that isn't a version.
 */
export function beforeAgentFloor(version: string | null): boolean {
  return beforeAgentRelease(version, AGENT_FLOOR);
}

/** Whether an Agent's release is older than `floor` (an `agent-vX.Y.Z` tag), by `beforeAgentFloor`'s rules. */
export function beforeAgentRelease(version: string | null, floor: string): boolean {
  const m = version === null ? null : /^(?:agent-v)?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return false;
  const v = m.slice(1).map(Number);
  if (v.every((n) => n === 0)) return false;
  const f = floor.slice('agent-v'.length).split('.').map(Number);
  return v[0]! - f[0]! < 0 || (v[0] === f[0] && (v[1]! - f[1]! < 0 || (v[1] === f[1] && v[2]! < f[2]!)));
}

type Waiting = { request: AgentRequest['type']; resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
type Budgets = ReturnType<typeof connBudgets>;
type Conn = { socket: Socket; bye: boolean; silence: NodeJS.Timeout; pending: Map<string, Waiting>; budgets: Budgets };
/** What a first line leads to: the line budget the connection's next lines take from, and what handles them. */
type Next = { lines: Budget['lines']; onLine: (line: string) => void };

/*
 * The Agent port's budgets (docs/protocol.md, "Rate rules"). The Agent stays under them, except that it forwards game
 * events at up to 5 a second, so the hub drops a busy server's game events over 2 a second; they are the hub's safety
 * net against a token holder, so what a connection can make the hub store, post or stream stays small.
 *
 * - `LINES`: every line of a connection (an Agent's or a game one, each its own), before and after the handshake. A
 *   line over it is dropped; a connection still dropping lines 10 s on is closed.
 * - `TYPES`: a message type's own token bucket within its connection, shared by the types listed together (the game
 *   events), one each otherwise. A message over it is dropped and its connection stays. A type not listed has only
 *   `LINES`, and none of those makes the hub post or store per line: `started` counts once per connection, `stopping`
 *   only marks its close a stop, `cmdResult` and `reply` only answer what waits for them, and `updateDone` and
 *   `deployResult` are each taken once: the one its update (by id) or deploy (by tag) waits for, then no more.
 * - `NEW_PLAYERS`: names a game connection's heartbeat adds to its server's player list (not on it already), each a
 *   playtime session row: one over it is left out of that heartbeat, to come in a later one. Its burst is a full list,
 *   so a reconnect's first heartbeat (the list is empty while offline) passes whole.
 * - `SAME`: a push deep-equal to the last one of its type passed on from its connection is dropped before its budget
 *   (the hub already holds it).
 * - `SAMPLE_MS`: at most one host sample per 10 s per Agent (whatever its connections), stored with the hub's clock as
 *   its `ts`: an Agent's clock is never trusted for what is stored.
 *
 * `LINES`, `TYPES` and `NEW_PLAYERS` belong to the connection, not its socket: the Agent connection's are kept by its
 * Agent's id and the game connection's by its server's, so one that replaces another goes on with what that one left
 * (reconnecting never starts a fresh burst); a first line, before anyone is known, takes from its peer address's.
 * `HANDSHAKE_MS`: a connection is welcomed at most once per 5 s (each kind for each Agent), so reconnecting can't churn
 * the server's connected and crashed events either. `SAME` stays its socket's: the first push after a reconnect is
 * always taken.
 *
 * Drops are logged at most once a minute (per connection, per budget), with how many since the last log.
 */
const LINES = { perSecond: 20, burst: 100, overMs: 10_000 };
const TYPES: { name: string; types: string[]; perSecond: number; burst: number }[] = [
  { name: 'game events', types: ['chat', 'join', 'leave', 'death', 'milestone'], perSecond: 2, burst: 30 },
  { name: 'link', types: ['link', 'unlink'], perSecond: 1, burst: 5 },
  { name: 'updateStep', types: ['updateStep'], perSecond: 5, burst: 20 },
  { name: 'serviceState', types: ['serviceState'], perSecond: 1, burst: 10 },
  { name: 'saves', types: ['saves'], perSecond: 1, burst: 10 },
  { name: 'installed', types: ['installed'], perSecond: 1, burst: 10 },
  { name: 'settings', types: ['settings'], perSecond: 1, burst: 10 },
  // Its Agent sends one per RCON round trip (5 s): 1 a second bounds its `paused` changes and TPS events.
  { name: 'heartbeat', types: ['heartbeat'], perSecond: 1, burst: 5 },
  // One per Save now, or per 6 h of play: each one is a notice posted to Discord.
  { name: 'backup', types: ['backup'], perSecond: 1 / 10, burst: 3 },
  // Taken only by a change (a repeat, such as the one it sends on each connect, posts nothing and takes none): each
  // change is a notice posted to Discord, and an Agent's come at most once per Factorio start.
  { name: 'events on or off', types: ['events'], perSecond: 1 / 10, burst: 3 },
];
const NEW_PLAYERS = { name: 'new players', perSecond: 1 / 10, burst: LIMITS.players };
const BUDGET_OF = new Map(TYPES.flatMap((b) => b.types.map((type) => [type, b] as const)));
const SAME = new Set(['serviceState', 'saves', 'installed', 'settings']);
const SAMPLE_MS = 10_000;
export const HANDSHAKE_MS = 5_000;
/** What a Mod sends but an Agent's game connection never does (docs/protocol.md): dropped from it. */
const NOT_FROM_AGENTS = new Set<string>(['cmdLate', 'quest', 'achievement'] satisfies ModMsg['type'][]);
/** Connections at once from one peer address, handshaken or not: an Agent connection, a game connection, two spare. */
const PEER_SOCKETS = 4;
/** How long a refused connection may take to close after its `reject`, whatever the peer does. */
const END_MS = 2_000;
const LOG_MS = 60_000;
const ignore = () => {};

/** A request the Agent answered with `ok: false`: it got it and said no (not a timeout or a dropped connection). */
export class AgentRefused extends Error {}

/** How long ago `stamp` was by the hub's clock, `now`: as long ago as can be if the clock has stepped back past it. */
const ago = (now: number, stamp: number) => (now < stamp ? Infinity : now - stamp);

/** The timers of `everyMinute`'s pending logs, which `Agents.close` clears; after `close`, none is set. */
export type DropLogs = { timers: Set<NodeJS.Timeout>; closed: boolean };

/**
 * Counts drops and logs them at most once a minute, `say(count)` with the drops since the last line: the first at
 * once, later ones summed and logged when the minute is up (at the next drop then, or by a timer in `logs`).
 */
export function everyMinute(say: (count: number) => string, logs: DropLogs): () => void {
  let count = 0;
  let at = -Infinity;
  let timer: NodeJS.Timeout | undefined;
  const log = () => {
    if (timer) logs.timers.delete(timer);
    clearTimeout(timer);
    timer = undefined;
    console.error(say(count));
    at = Date.now();
    count = 0;
  };
  return () => {
    count++;
    const wait = LOG_MS - ago(Date.now(), at);
    if (wait <= 0) return log();
    if (timer || logs.closed) return;
    timer = setTimeout(log, wait).unref();
    logs.timers.add(timer);
  };
}

/** A token bucket: whether one more fits now, `perSecond` refilled up to `burst` (a clock stepping back adds none). */
function bucket(perSecond: number, burst: number): (now: number) => boolean {
  let tokens = burst;
  let last = Date.now();
  return (now) => {
    tokens = Math.min(burst, tokens + (Math.max(0, now - last) * perSecond) / 1000);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/**
 * A connection's budgets, which outlive its sockets (`Agents` keeps one per Agent connection, game connection and peer
 * address): `lines(socket)` whether a line may be handled now (`LINES`: lines over it are dropped, logged at most once
 * a minute, and a connection still dropping lines `overMs` after its first drop, with no drop-free second between, has
 * `socket` closed); `fits(type)` whether a message of `type` is within its type's budget (`TYPES`), and `newPlayer()`
 * whether one more name may join its server's player list (`NEW_PLAYERS`), each else counted by `dropped`;
 * `dropped(name)` counts a message (or a name) dropped over budget `name`, logged at most once a minute. `label`
 * names it in the logs.
 */
type Budget = { lines: (socket: Socket) => boolean; fits: (type: string) => boolean; newPlayer: () => boolean; dropped: (name: string) => void };

function budget(label: string, rate: Rate, drops: DropLogs): Budget {
  const take = bucket(rate.perSecond, rate.burst);
  const logLines = everyMinute((n) => `[agents] ${label}: over ${rate.perSecond} lines/s, dropping lines (${n} dropped)`, drops);
  let overSince = 0;
  let lastDrop = 0;
  const lines = (socket: Socket) => {
    const now = Date.now();
    if (take(now)) {
      if (overSince && now - lastDrop >= 1000) overSince = 0;
      return true;
    }
    logLines();
    lastDrop = now;
    overSince ||= now;
    if (now - overSince >= rate.overMs) {
      console.error(`[agents] ${label}: over the line rate for ${rate.overMs / 1000} s, closing`);
      socket.destroy();
    }
    return false;
  };
  const buckets = new Map<string, (now: number) => boolean>();
  const logs = new Map<string, () => void>();
  const dropped = (name: string) => {
    let log = logs.get(name);
    if (!log) logs.set(name, (log = everyMinute((n) => `[agents] ${label}: over the ${name} budget, dropped ${n}`, drops)));
    log();
  };
  const takes = (of: { name: string; perSecond: number; burst: number }) => {
    let takeOne = buckets.get(of.name);
    if (!takeOne) buckets.set(of.name, (takeOne = bucket(of.perSecond, of.burst)));
    if (takeOne(Date.now())) return true;
    dropped(of.name);
    return false;
  };
  const fits = (type: string) => {
    const of = BUDGET_OF.get(type);
    return !of || takes(of);
  };
  return { lines, fits, newPlayer: () => takes(NEW_PLAYERS), dropped };
}

/**
 * A connection's per-type budgets on one socket: `allows(msg)` whether a parsed message may be handled now, false for
 * a push deep-equal to the last one of its type this socket passed on (`SAME`, silently: so the first after a
 * reconnect is always taken) or one over its type's budget (`budget.fits`, counted); `dropped` is `budget`'s.
 */
function connBudgets(budget: Budget): { allows: (msg: { type: string }) => boolean; dropped: (name: string) => void } {
  const last = new Map<string, unknown>();
  const allows = (msg: { type: string }) => {
    const same = SAME.has(msg.type);
    if (same && isDeepStrictEqual(last.get(msg.type), msg)) return false;
    if (!budget.fits(msg.type)) return false;
    if (same) last.set(msg.type, msg);
    return true;
  };
  return { allows, dropped: budget.dropped };
}

/**
 * Splits a socket's bytes into lines as they arrive, at most `max` bytes each (the newline not counted, a `\r` before
 * it dropped): a longer line destroys the socket before more of it is kept.
 */
function readLines(socket: Socket, max: number, onLine: (line: string) => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length && !socket.destroyed) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      size += end - start;
      if (size > max) {
        console.error(`[agents] ${socket.remoteAddress}: a line over ${max} bytes, closing`);
        return void socket.destroy();
      }
      parts.push(chunk.subarray(start, end));
      if (nl === -1) return;
      const line = Buffer.concat(parts).toString('utf8'); // whole first: a character may span two chunks
      parts = [];
      size = 0;
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      start = nl + 1;
    }
  });
}

/**
 * The Agent port (`integrations.agents.listen`) and the Agents on it. Hub core: frontends use its registry
 * (`get`, `list`), requests (`request`) and events, never its sockets.
 *
 * A connection is accepted only from a configured Agent's address, and while that address has fewer than 4 open,
 * checked before any byte is read (else destroyed, without a word). Its lines are read with `LIMITS.lineBytes` as the
 * cap and the line budget, before and after the handshake, and each message within its type's budget (`TYPES`), both
 * kept per connection across reconnects. The first line, within 5 s, is an `agentHello` (an Agent connection) or a
 * game `hello` for that Agent's own server while its Agent connection is up, which goes to `ServerHub.attach` (its
 * `cmdLate`, `quest` and `achievement`, which an Agent never sends, dropped, and each heartbeat's names new to its
 * server's player list within `NEW_PLAYERS`, the rest left out); one under 5 s after the last welcome of its kind for
 * that Agent is refused, the live one kept; a refused one gets its `reject`, then is closed within 2 s whatever the
 * peer does. A second Agent connection replaces the first. An Agent with no line for 20 s, or whose
 * connection closes without `bye`, is lost: its server is `lost`, and one `agentLost` host notice goes out, then
 * `agentBack` when it connects again; after `bye` the server is `lost` with nothing posted. Its `events` post an
 * `eventsOff` or `eventsOn` host notice only on a change. Its host samples go to its Host's monitor (`Hosts`, by the
 * Agent's id), at most one per 10 s, stamped with the hub's clock.
 */
export class Agents extends EventEmitter<AgentEvents> {
  #hub: Pick<ServerHub, 'attach' | 'agentUp' | 'agentDown' | 'publishTarget' | 'get'>;
  #hosts: Pick<Hosts, 'get'>;
  #cfg: AgentsIntegration;
  #byId = new Map<string, AgentConfig>();
  #addresses: Set<string>;
  #conns = new Map<string, Conn>();
  #versions = new Map<string, string>();
  #lost = new Set<string>(); // lost (not after `bye`) and not back yet
  #eventsOff = new Set<string>(); // the Agents whose game events are off, as the latest `events` each sent said
  #sockets = new Set<Socket>();
  #perPeer = new Map<string, number>(); // open connections by peer address, handshaken or not
  #sampled = new Map<string, number>(); // when each Agent's latest stored host sample came (the hub's clock)
  #budgets = new Map<string, Budget>(); // by `agent <id>`, `game <server id>` and peer address: they outlive sockets
  #welcomed = new Map<string, number>(); // when each `agent <id>` and `game <server id>` was last welcomed
  #drops: DropLogs = { timers: new Set(), closed: false }; // the drop logs' pending lines
  #tooMany = everyMinute((n) => `[agents] over ${PEER_SOCKETS} connections at once from one address: ${n} refused`, this.#drops);
  #server: Server | null = null;
  #retry: NodeJS.Timeout | undefined;
  #closing = false;
  #helloTimeoutMs: number;
  #silenceMs: number;
  #requestTimeoutMs: number;
  #bindRetryMs: number;
  #handshakeMs: number;
  #rate: Rate;

  constructor(
    hub: Pick<ServerHub, 'attach' | 'agentUp' | 'agentDown' | 'publishTarget' | 'get'>,
    hosts: Pick<Hosts, 'get'>,
    cfg: AgentsIntegration,
    opts: AgentsOptions = {},
  ) {
    super();
    this.#hub = hub;
    this.#hosts = hosts;
    this.#cfg = cfg;
    for (const a of cfg.agents) this.#byId.set(a.id, a);
    this.#addresses = new Set(cfg.agents.map((a) => a.address));
    this.#helloTimeoutMs = opts.helloTimeoutMs ?? 5_000;
    this.#silenceMs = opts.silenceMs ?? 20_000;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.#bindRetryMs = opts.bindRetryMs ?? 10_000;
    this.#handshakeMs = opts.handshakeMs ?? HANDSHAKE_MS;
    this.#rate = opts.rate ?? LINES;
  }

  /**
   * Opens the Agent port. Resolves with the bound port once it is listening; while its address isn't on this machine
   * yet (the tailnet still coming up: EADDRNOTAVAIL) it asks again every 10 s, logging that once, so nothing should
   * wait for it. Rejects on any other error.
   */
  start(): Promise<number> {
    const { host, port } = this.#cfg.listen;
    let logged = false;
    return new Promise((resolve, reject) => {
      const bind = () => {
        const server = createServer({ pauseOnConnect: true }, (socket) => this.#accept(socket));
        server.on('error', (err: NodeJS.ErrnoException) => {
          if (this.#server === server) return void console.error('[agents] Agent port error:', err);
          if (err.code !== 'EADDRNOTAVAIL') return reject(err);
          if (!logged) {
            logged = true;
            console.error(`[agents] ${host} is not on this machine yet: trying again every ${this.#bindRetryMs / 1000} s`);
          }
          if (!this.#closing) this.#retry = setTimeout(bind, this.#bindRetryMs);
        });
        server.listen(port, host, () => {
          if (this.#closing) return void server.close();
          this.#server = server;
          resolve((server.address() as AddressInfo).port);
        });
      };
      bind();
    });
  }

  close(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#retry);
    this.#drops.closed = true;
    for (const timer of this.#drops.timers) clearTimeout(timer);
    this.#drops.timers.clear();
    for (const socket of this.#sockets) socket.destroy();
    return new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  get(id: string): AgentStatus | undefined {
    const a = this.#byId.get(id);
    return a && { id, name: a.name, server: a.server, connected: this.#conns.has(id), version: this.#versions.get(id) ?? null };
  }

  /** Every configured Agent, in config order. */
  list(): AgentStatus[] {
    return [...this.#byId.keys()].map((id) => this.get(id)!);
  }

  /**
   * Sends a request to a connected Agent, with a fresh id (or `id`: an `update`'s, which its steps carry), and
   * resolves with its reply: the checked `data` for the requests that answer with data. Rejects when the Agent isn't
   * connected, refuses (`AgentRefused`, with its `error`), doesn't answer in time (`timeoutMs`, else 30 s:
   * `requestTimeoutMs`), leaves first, or answers with data that isn't the request's.
   */
  request<C extends AgentCall>(
    agentId: string,
    call: C,
    { id = randomUUID(), timeoutMs }: { id?: string; timeoutMs?: number } = {},
  ): Promise<AgentAnswer<C['type']>> {
    const conn = this.#conns.get(agentId);
    if (!conn) return Promise.reject(new Error(`agent ${agentId} is not connected`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`agent ${agentId} did not answer in time`));
      }, timeoutMs ?? this.#requestTimeoutMs);
      conn.pending.set(id, { request: call.type, resolve: resolve as (data: unknown) => void, reject, timer });
      this.#send(conn.socket, { ...call, id } as AgentRequest);
    });
  }

  #accept(socket: Socket): void {
    // Paused since accept: nothing is read before the peer's address is known to be an Agent's.
    const peer = socket.remoteAddress?.replace(/^::ffff:/, '');
    if (peer === undefined || !this.#addresses.has(peer)) return void socket.destroy();
    const open = this.#perPeer.get(peer) ?? 0;
    if (open >= PEER_SOCKETS) {
      this.#tooMany();
      return void socket.destroy();
    }
    this.#perPeer.set(peer, open + 1);
    this.#sockets.add(socket);
    socket.on('error', () => {}); // 'close' always follows and does the cleanup
    const helloTimer = setTimeout(() => socket.destroy(), this.#helloTimeoutMs);
    socket.on('close', () => {
      this.#sockets.delete(socket);
      clearTimeout(helloTimer);
      const left = this.#perPeer.get(peer)! - 1;
      if (left) this.#perPeer.set(peer, left);
      else this.#perPeer.delete(peer);
    });
    let lines = this.#budget(peer).lines; // first lines: nobody is known yet, so its peer address's
    let onLine = (line: string) => {
      clearTimeout(helloTimer);
      const msg = parseAgentLine(line);
      const next = msg?.type === 'agentHello' ? this.#agentHello(socket, peer, msg) : msg?.type === 'hello' ? this.#gameHello(socket, peer, msg) : null;
      if (next) ({ lines, onLine } = next);
      else socket.destroy();
    };
    readLines(socket, LIMITS.lineBytes, (line) => {
      if (socket.destroyed || socket.writableEnded || !lines(socket)) return;
      try {
        onLine(line);
      } catch (err) {
        // One bad line must never take the hub down: it ends only its own connection.
        console.error(`[agents] ${peer}: a line failed, closing:`, err);
        socket.destroy();
      }
    });
    socket.resume();
  }

  /** A connection's budgets by its key (`agent <id>`, `game <server id>` or a peer address), made on first use. */
  #budget(key: string): Budget {
    let b = this.#budgets.get(key);
    if (!b) this.#budgets.set(key, (b = budget(key, this.#rate, this.#drops)));
    return b;
  }

  /** Whether connection `key` was welcomed under `handshakeMs` ago; if not, it is being welcomed now. */
  #tooSoon(key: string): boolean {
    const now = Date.now();
    if (ago(now, this.#welcomed.get(key) ?? -Infinity) < this.#handshakeMs) return true;
    this.#welcomed.set(key, now);
    return false;
  }

  #agentHello(socket: Socket, peer: string, hello: AgentHello): Next {
    const cfg = this.#byId.get(hello.agentId);
    const reason =
      protocolRefusal(hello.protocol) ??
      (cfg && cfg.address === peer && tokenMatches(cfg.token, hello.token) ? null : 'unknown agentId or bad token');
    if (!cfg || reason) return this.#reject(socket, reason ?? 'unknown agentId or bad token');
    const key = `agent ${cfg.id}`;
    if (this.#tooSoon(key)) return this.#reject(socket, 'reconnecting too fast');
    const budget = this.#budget(key);
    const conn: Conn = { socket, bye: false, silence: setTimeout(() => socket.destroy(), this.#silenceMs), pending: new Map(), budgets: connBudgets(budget) };
    const old = this.#conns.get(cfg.id);
    this.#conns.set(cfg.id, conn);
    old?.socket.destroy();
    this.#versions.set(cfg.id, hello.agentVersion);
    this.#send(socket, { type: 'welcome' });
    this.#hub.agentUp(cfg.server);
    this.emit('agentUp', cfg.id);
    if (this.#lost.delete(cfg.id)) {
      this.#hub.publishTarget({ target: 'host', id: cfg.id, type: 'notice', severity: 'good', kind: 'agentBack', name: cfg.name });
      this.emit('agentBack', cfg.id);
    }
    socket.on('close', () => this.#closed(cfg, conn));
    return { lines: budget.lines, onLine: (line) => this.#agentLine(cfg, conn, line) };
  }

  #gameHello(socket: Socket, peer: string, hello: Hello): Next {
    const cfg = this.#cfg.agents.find((a) => a.server === hello.serverId);
    const reason =
      protocolRefusal(hello.protocol) ??
      (cfg && cfg.address === peer && tokenMatches(cfg.token, hello.token)
        ? this.#conns.has(cfg.id)
          ? null
          : 'its agent is not connected'
        : 'unknown serverId or bad token');
    if (reason) return this.#reject(socket, reason);
    const key = `game ${hello.serverId}`;
    if (this.#tooSoon(key)) return this.#reject(socket, 'reconnecting too fast');
    const budget = this.#budget(key);
    const budgets = connBudgets(budget);
    const handle = this.#hub.attach(socket, hello.serverId, hello.modVersion);
    return {
      lines: budget.lines,
      onLine: (line) => {
        const msg = parseModLine(line);
        // Junk after the handshake, and what an Agent never sends, is ignored; a message over its type's budget is dropped.
        if (!msg || msg.type === 'hello' || NOT_FROM_AGENTS.has(msg.type) || !budgets.allows(msg)) return;
        handle(msg.type === 'heartbeat' ? this.#newPlayers(hello.serverId, budget, msg) : msg);
      },
    };
  }

  /**
   * A heartbeat with only as many names new to its server's player list (not on it now: none are while it is offline)
   * as `NEW_PLAYERS` has room for, the others left out until a later heartbeat: so fresh names can't make playtime
   * sessions faster than that, whether they replace each other or come back after a reconnect.
   */
  #newPlayers(serverId: string, budget: Budget, beat: Extract<ModMsg, { type: 'heartbeat' }>): ModMsg {
    const on = new Set(this.#hub.get(serverId)?.players);
    const players = beat.players.filter((name) => on.has(name) || budget.newPlayer());
    return players.length === beat.players.length ? beat : { ...beat, players };
  }

  /** Refuses a first line: its `reject`, then the connection is ended and destroyed within 2 s, whatever the peer does. */
  #reject(socket: Socket, reason: string): Next {
    this.#send(socket, { type: 'reject', reason });
    socket.end(() => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), END_MS);
    socket.once('close', () => clearTimeout(timer));
    return { lines: () => false, onLine: ignore }; // its lines are not read on: it is ending
  }

  #agentLine(cfg: AgentConfig, conn: Conn, line: string): void {
    conn.silence.refresh();
    const msg = parseAgentLine(line);
    // Junk after the handshake is ignored; over its budget, dropped (`events` takes from its own only on a change).
    if (!msg || (msg.type !== 'events' && !conn.budgets.allows(msg))) return;
    switch (msg.type) {
      case 'agentHello':
      case 'hello': // first lines only
      case 'ping':
        return;
      case 'bye':
        conn.bye = true;
        return void conn.socket.destroy(); // a planned exit: its server is lost, nothing posted
      case 'hostSample': {
        // Per Agent, not per connection, so reconnecting never lets more in; stored with the hub's clock, never the Agent's.
        const now = Date.now();
        if (ago(now, this.#sampled.get(cfg.id) ?? -Infinity) < SAMPLE_MS) return conn.budgets.dropped('hostSample');
        this.#sampled.set(cfg.id, now);
        return this.#hosts.get(cfg.id)?.record({ ...msg.sample, ts: now });
      }
      case 'events':
        return this.#events(cfg, conn, msg);
      case 'reply':
        return this.#reply(conn, msg);
      default: // what it pushes: serviceState, saves, installed, updateStep, updateDone, deployResult, settings
        (this.emit as (event: Pushed['type'], id: string, msg: Pushed) => boolean)(msg.type, cfg.id, msg);
    }
  }

  /**
   * Its server's game events went off or came back on: one host notice per change the hub hears, within the `events`
   * budget (one over it is dropped, so the hub hears of it at the next change or connect). A repeat (the Agent sends
   * its state on each connect) posts nothing and takes no budget; the hub keeps what it heard while the Agent is away.
   */
  #events(cfg: AgentConfig, conn: Conn, msg: Extract<AgentMsg, { type: 'events' }>): void {
    const off = this.#eventsOff.has(cfg.id);
    if (msg.on !== off || !conn.budgets.allows(msg)) return; // no change, or over its budget
    const at = { target: 'host', id: cfg.id, type: 'notice', name: cfg.name } as const;
    if (msg.on) {
      this.#eventsOff.delete(cfg.id);
      return this.#hub.publishTarget({ ...at, severity: 'good', kind: 'eventsOn' });
    }
    this.#eventsOff.add(cfg.id);
    this.#hub.publishTarget({ ...at, severity: 'warning', kind: 'eventsOff', reason: msg.reason ?? 'no reason given' });
  }

  #reply(conn: Conn, msg: Extract<AgentMsg, { type: 'reply' }>): void {
    const waiting = conn.pending.get(msg.id);
    if (!waiting) return; // late or unknown
    conn.pending.delete(msg.id);
    clearTimeout(waiting.timer);
    if (!msg.ok) return waiting.reject(new AgentRefused(msg.error ?? `${waiting.request} refused`));
    if (!WITH_DATA.has(waiting.request)) return waiting.resolve(undefined);
    const data = parseReplyData(waiting.request as keyof AgentReplyData, msg.data);
    if (data === null) return waiting.reject(new Error(`the agent's ${waiting.request} reply is malformed`));
    waiting.resolve(data);
  }

  #closed(cfg: AgentConfig, conn: Conn): void {
    clearTimeout(conn.silence);
    for (const waiting of conn.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(`agent ${cfg.id} disconnected`));
    }
    conn.pending.clear();
    if (this.#conns.get(cfg.id) !== conn) return; // replaced by a newer connection
    this.#conns.delete(cfg.id);
    if (this.#closing) return;
    this.#hub.agentDown(cfg.server);
    if (conn.bye) return;
    this.#lost.add(cfg.id);
    this.#hub.publishTarget({ target: 'host', id: cfg.id, type: 'notice', severity: 'warning', kind: 'agentLost', name: cfg.name });
    this.emit('agentLost', cfg.id);
  }

  #send(socket: Socket, msg: HubAgentMsg): void {
    socket.write(JSON.stringify(msg) + '\n');
  }
}

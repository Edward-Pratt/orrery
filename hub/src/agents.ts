import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { AgentConfig, AgentsIntegration } from './config.ts';
import type { Hosts } from './host.ts';
import { LIMITS, parseAgentLine, parseReplyData, type AgentHello, type AgentMsg, type AgentReplyData, type AgentRequest, type Hello, type HubAgentMsg } from './protocol.ts';
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
  /** Lines a connection may send per second, in bursts of up to `burst`; one over the limit for `overMs` is closed. */
  rate?: { perSecond: number; burst: number; overMs: number };
};

/** What an Agent pushes on its own, put on the `Agents` emitter as it came (a copy of only its schema's fields). */
type Pushed = Exclude<AgentMsg, { type: 'ping' | 'bye' | 'hostSample' | 'reply' }>;

/**
 * `Agents`' events, each with the Agent's id: `agentLost` (it went silent, or closed without `bye`) and `agentBack`
 * (it connected again after that), and what it pushes.
 */
export type AgentEvents = { agentLost: [agentId: string]; agentBack: [agentId: string] } & {
  [T in Pushed['type']]: [agentId: string, msg: Extract<Pushed, { type: T }>];
};

/** A request without its id, which `request` adds. */
export type AgentCall = AgentRequest extends infer R ? (R extends AgentRequest ? Omit<R, 'id'> : never) : never;
/** What a request's promise resolves to: its reply's checked `data`, for the requests that answer with data. */
export type AgentAnswer<T extends AgentRequest['type']> = T extends keyof AgentReplyData ? AgentReplyData[T] : void;
const WITH_DATA = new Set<string>(['journal', 'logs', 'log'] satisfies (keyof AgentReplyData)[]);

/** An Agent as the registry knows it: `version` is what its latest `agentHello` announced, kept after it leaves. */
export type AgentStatus = { id: string; name: string; server: string; connected: boolean; version: string | null };

type Waiting = { request: AgentRequest['type']; resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
type Conn = { socket: Socket; bye: boolean; silence: NodeJS.Timeout; pending: Map<string, Waiting> };

const RATE = { perSecond: 50, burst: 200, overMs: 10_000 };
const ignore = () => {};

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
 * A connection's line budget, a token bucket: whether a line may be handled now. Lines over it are dropped (logged
 * once); a connection still dropping lines `overMs` after its first drop (with no drop-free second between) is closed.
 */
function limiter(socket: Socket, rate: AgentsOptions['rate'] & {}): () => boolean {
  let tokens = rate.burst;
  let last = Date.now();
  let overSince = 0;
  let lastDrop = 0;
  let logged = false;
  return () => {
    const now = Date.now();
    tokens = Math.min(rate.burst, tokens + ((now - last) * rate.perSecond) / 1000);
    last = now;
    if (tokens >= 1) {
      tokens -= 1;
      if (overSince && now - lastDrop >= 1000) overSince = 0;
      return true;
    }
    if (!logged) {
      logged = true;
      console.error(`[agents] ${socket.remoteAddress}: over ${rate.perSecond} lines/s, dropping lines`);
    }
    lastDrop = now;
    overSince ||= now;
    if (now - overSince >= rate.overMs) {
      console.error(`[agents] ${socket.remoteAddress}: over the line rate for ${rate.overMs / 1000} s, closing`);
      socket.destroy();
    }
    return false;
  };
}

/**
 * The Agent port (`integrations.agents.listen`) and the Agents on it. Hub core: frontends use its registry
 * (`get`, `list`), requests (`request`) and events, never its sockets.
 *
 * A connection is accepted only from a configured Agent's address, checked before any byte is read (else destroyed,
 * without a word). Its lines are read with `LIMITS.lineBytes` as the cap and a rate limit, before and after the
 * handshake. The first line, within 5 s, is an `agentHello` (an Agent connection) or a game `hello` for that Agent's
 * own server while its Agent connection is up, which goes to `ServerHub.attach`. A second Agent connection replaces
 * the first. An Agent with no line for 20 s, or whose connection closes without `bye`, is lost: its server is `lost`,
 * and one `agentLost` host notice goes out, then `agentBack` when it connects again; after `bye` the server is `lost`
 * with nothing posted. Its host samples go to its Host's monitor (`Hosts`, by the Agent's id).
 */
export class Agents extends EventEmitter<AgentEvents> {
  #hub: Pick<ServerHub, 'attach' | 'agentUp' | 'agentDown' | 'publishTarget'>;
  #hosts: Pick<Hosts, 'get'>;
  #cfg: AgentsIntegration;
  #byId = new Map<string, AgentConfig>();
  #addresses: Set<string>;
  #conns = new Map<string, Conn>();
  #versions = new Map<string, string>();
  #lost = new Set<string>(); // lost (not after `bye`) and not back yet
  #sockets = new Set<Socket>();
  #server: Server | null = null;
  #retry: NodeJS.Timeout | undefined;
  #closing = false;
  #helloTimeoutMs: number;
  #silenceMs: number;
  #requestTimeoutMs: number;
  #bindRetryMs: number;
  #rate: AgentsOptions['rate'] & {};

  constructor(
    hub: Pick<ServerHub, 'attach' | 'agentUp' | 'agentDown' | 'publishTarget'>,
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
    this.#rate = opts.rate ?? RATE;
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
   * Sends a request to a connected Agent, with a fresh id, and resolves with its reply: the checked `data` for the
   * requests that answer with data. Rejects when the Agent isn't connected, refuses (with its `error`), doesn't answer
   * in 30 s, leaves first, or answers with data that isn't the request's.
   */
  request<C extends AgentCall>(agentId: string, call: C): Promise<AgentAnswer<C['type']>> {
    const conn = this.#conns.get(agentId);
    if (!conn) return Promise.reject(new Error(`agent ${agentId} is not connected`));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`agent ${agentId} did not answer in time`));
      }, this.#requestTimeoutMs);
      conn.pending.set(id, { request: call.type, resolve: resolve as (data: unknown) => void, reject, timer });
      this.#send(conn.socket, { ...call, id } as AgentRequest);
    });
  }

  #accept(socket: Socket): void {
    // Paused since accept: nothing is read before the peer's address is known to be an Agent's.
    const peer = socket.remoteAddress?.replace(/^::ffff:/, '');
    if (peer === undefined || !this.#addresses.has(peer)) return void socket.destroy();
    this.#sockets.add(socket);
    socket.on('error', () => {}); // 'close' always follows and does the cleanup
    const helloTimer = setTimeout(() => socket.destroy(), this.#helloTimeoutMs);
    socket.on('close', () => {
      this.#sockets.delete(socket);
      clearTimeout(helloTimer);
    });
    let onLine = (line: string) => {
      clearTimeout(helloTimer);
      const msg = parseAgentLine(line);
      if (msg?.type === 'agentHello') onLine = this.#agentHello(socket, peer, msg);
      else if (msg?.type === 'hello') onLine = this.#gameHello(socket, peer, msg);
      else socket.destroy();
    };
    const allowed = limiter(socket, this.#rate);
    readLines(socket, LIMITS.lineBytes, (line) => {
      if (!socket.destroyed && !socket.writableEnded && allowed()) onLine(line);
    });
    socket.resume();
  }

  #agentHello(socket: Socket, peer: string, hello: AgentHello): (line: string) => void {
    const cfg = this.#byId.get(hello.agentId);
    const reason =
      protocolRefusal(hello.protocol) ??
      (cfg && cfg.address === peer && tokenMatches(cfg.token, hello.token) ? null : 'unknown agentId or bad token');
    if (!cfg || reason) return this.#reject(socket, reason ?? 'unknown agentId or bad token');
    const conn: Conn = { socket, bye: false, silence: setTimeout(() => socket.destroy(), this.#silenceMs), pending: new Map() };
    const old = this.#conns.get(cfg.id);
    this.#conns.set(cfg.id, conn);
    old?.socket.destroy();
    this.#versions.set(cfg.id, hello.agentVersion);
    this.#send(socket, { type: 'welcome' });
    this.#hub.agentUp(cfg.server);
    if (this.#lost.delete(cfg.id)) {
      this.#hub.publishTarget({ target: 'host', id: cfg.id, type: 'notice', severity: 'good', kind: 'agentBack', name: cfg.name });
      this.emit('agentBack', cfg.id);
    }
    socket.on('close', () => this.#closed(cfg, conn));
    return (line) => this.#agentLine(cfg, conn, line);
  }

  #gameHello(socket: Socket, peer: string, hello: Hello): (line: string) => void {
    const cfg = this.#cfg.agents.find((a) => a.server === hello.serverId);
    const reason =
      protocolRefusal(hello.protocol) ??
      (cfg && cfg.address === peer && tokenMatches(cfg.token, hello.token)
        ? this.#conns.has(cfg.id)
          ? null
          : 'its agent is not connected'
        : 'unknown serverId or bad token');
    if (reason) return this.#reject(socket, reason);
    return this.#hub.attach(socket, hello.serverId, hello.modVersion);
  }

  #reject(socket: Socket, reason: string): typeof ignore {
    this.#send(socket, { type: 'reject', reason });
    socket.end();
    return ignore;
  }

  #agentLine(cfg: AgentConfig, conn: Conn, line: string): void {
    conn.silence.refresh();
    const msg = parseAgentLine(line);
    if (!msg) return; // junk after the handshake is ignored
    switch (msg.type) {
      case 'agentHello':
      case 'hello': // first lines only
      case 'ping':
        return;
      case 'bye':
        conn.bye = true;
        return void conn.socket.destroy(); // a planned exit: its server is lost, nothing posted
      case 'hostSample':
        return this.#hosts.get(cfg.id)?.record(msg.sample);
      case 'reply':
        return this.#reply(conn, msg);
      default: // what it pushes: serviceState, saves, installed, updateStep, updateDone, deployResult
        (this.emit as (event: Pushed['type'], id: string, msg: Pushed) => boolean)(msg.type, cfg.id, msg);
    }
  }

  #reply(conn: Conn, msg: Extract<AgentMsg, { type: 'reply' }>): void {
    const waiting = conn.pending.get(msg.id);
    if (!waiting) return; // late or unknown
    conn.pending.delete(msg.id);
    clearTimeout(waiting.timer);
    if (!msg.ok) return waiting.reject(new Error(msg.error ?? `${waiting.request} refused`));
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

import { rename, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import type { AgentMsg, AgentRequest, HostSample } from '../../hub/src/types.ts';
import type { Config } from './config.ts';
import type { UnitState } from './service.ts';
import type { Reading } from './status.ts';
import { LIMITS, LineReader, PROTOCOL_VERSION, encode, readAgentLine, readGameLine, type OutMsg, type Request } from './wire.ts';

/** What answers a request: resolves with its reply's `data` (undefined: none); a throw is the reply's `error`. */
export type Handlers = { [T in AgentRequest['type']]?: (req: Request<T>) => Promise<unknown> };

export type HubOptions = {
  config: Pick<Config, 'id' | 'hub' | 'server' | 'token' | 'root'>;
  /** This release, `agent-vX.Y.Z`: the hello's `agentVersion` and the `connected` file's `version`. */
  version: string;
  /** The requests this agent carries out; any other is answered `ok: false`. */
  handlers?: Handlers;
  pingMs?: number;
  /** For the TCP connect and the hub's answer to a hello. */
  handshakeMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
};

/** The wait before reconnecting after `failures` closes since the last welcome: base × 2^failures up to `max`, jittered into its upper half. */
export function backoff(failures: number, base: number, max: number, random: () => number): number {
  const full = Math.min(max, base * 2 ** failures);
  return full / 2 + (full / 2) * random();
}

/** One TCP connection to the hub's Agent port: its hello sent on connect, lines read under the cap, lines sent under it. */
class Link {
  readonly socket: Socket;
  readonly closed: Promise<void>;
  welcomed = false;
  #why = 'the hub closed the connection';
  #handshake: NodeJS.Timeout;

  constructor(host: string, port: number, hello: OutMsg, onLine: (line: string) => void, onClose: (why: string) => void, handshakeMs: number) {
    const socket = connect({ host, port });
    this.socket = socket;
    const reader = new LineReader(LIMITS.lineBytes);
    this.#handshake = setTimeout(() => this.drop('no welcome in time'), handshakeMs);
    this.closed = new Promise((resolve) => socket.once('close', () => resolve()));
    socket.setNoDelay(true);
    socket.on('connect', () => this.send(hello));
    socket.on('data', (chunk) => {
      let lines: string[];
      try {
        lines = reader.push(chunk as Buffer); // no encoding is set, so chunks are Buffers
      } catch (err) {
        return this.drop(`the hub sent ${(err as Error).message}`);
      }
      for (const line of lines) {
        if (socket.destroyed) return;
        onLine(line);
      }
    });
    socket.on('error', (err) => {
      this.#why = err.message;
    });
    socket.on('close', () => {
      clearTimeout(this.#handshake);
      onClose(this.#why);
    });
  }

  welcome(): void {
    this.welcomed = true;
    clearTimeout(this.#handshake);
  }

  /** Sends one line, if it fits the cap (`encode` trims what it can); a message that can't fit is logged, not sent. */
  send(msg: OutMsg, then?: () => void): void {
    if (!this.socket.writable) return then?.();
    const line = encode(msg);
    if (line === null) {
      console.error(`[hub] a ${msg.type} over ${LIMITS.lineBytes} bytes was not sent`);
      return then?.();
    }
    this.socket.write(line, () => then?.());
  }

  /** Closes after what was sent is flushed. */
  end(why: string): void {
    this.#why = why;
    this.socket.end();
  }

  drop(why: string): void {
    this.#why = why;
    this.socket.destroy();
  }
}

/**
 * The agent's two connections to the hub (docs/protocol.md, "Agent connection"). The Agent connection opens with
 * `agentHello`, sends nothing before `welcome`, then pings every 10 s, pushes the unit's state (on connect and on
 * change) and host samples, and answers each request by its id. It reconnects after any close, with capped
 * exponential backoff and jitter, logging once per change of state, so with no hub reachable the agent just keeps
 * trying. After each welcome it writes `<root>/connected` (`{ version, time }`, atomically) for its deploy's gate.
 *
 * The game connection opens only while the Agent connection is up and RCON answers: a `hello` with the agent's token
 * and the orrery mod's version, then a heartbeat per `/orrery-status` answer. It closes with the Agent connection or
 * once RCON is gone, not while RCON only stalls. `stop` sends `bye`, then closes both.
 */
export class HubClient {
  #config: HubOptions['config'];
  #version: string;
  #handlers: Handlers;
  #pingMs: number;
  #handshakeMs: number;
  #backoffMs: number;
  #maxBackoffMs: number;
  #random: () => number;
  #agent: Link | null = null;
  #game: Link | null = null;
  #failures = 0;
  #retry: NodeJS.Timeout | undefined;
  #ping: NodeJS.Timeout | undefined;
  /** The latest RCON answer, null while RCON doesn't answer. */
  #reading: Reading | null = null;
  #service: UnitState | null = null;
  #stopping = false;
  #logged = '';
  #gameLogged = '';

  constructor(o: HubOptions) {
    this.#config = o.config;
    this.#version = o.version;
    this.#handlers = o.handlers ?? {};
    this.#pingMs = o.pingMs ?? 10_000;
    this.#handshakeMs = o.handshakeMs ?? 10_000;
    this.#backoffMs = o.backoffMs ?? 1000;
    this.#maxBackoffMs = o.maxBackoffMs ?? 60_000;
    this.#random = o.random ?? Math.random;
  }

  /** Whether the Agent connection is up: welcomed and not closed. */
  get connected(): boolean {
    return this.#agent?.welcomed === true;
  }

  start(): void {
    if (!this.#agent && !this.#stopping) this.#connect();
  }

  /** RCON answered: opens the game connection if it isn't open, else sends the heartbeat (once there is a rate). */
  status(r: Reading): void {
    this.#reading = r;
    if (!this.connected || this.#stopping) return;
    const game = this.#game;
    if (!game) this.#openGame(r.modVersion);
    else if (game.welcomed && r.ups !== null) game.send({ type: 'heartbeat', tps: r.ups, players: r.players, paused: r.paused });
  }

  /**
   * RCON stalled (no answer in time, or no status): no new game connection, but an open one stays, heartbeats stop,
   * and the hub's hung detection decides (a frozen server shows as hung, not as a crash).
   */
  stalled(): void {
    this.#reading = null;
  }

  /** RCON is gone (refused, or closed by the server): the game connection closes. */
  down(): void {
    this.#reading = null;
    this.#game?.end('RCON is gone');
  }

  /** The unit's new state, sent now if connected, and on every connect. */
  service(state: UnitState): void {
    this.#service = state;
    if (this.connected) this.#agent!.send({ type: 'serviceState', ...state });
  }

  /** A host sample, sent only while connected (never queued). */
  sample(sample: HostSample): void {
    if (this.connected) this.#agent!.send({ type: 'hostSample', sample });
  }

  /** A planned exit: `bye` on the Agent connection, then both connections closed; resolves once they are (2 s at most). */
  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#retry);
    clearInterval(this.#ping);
    const agent = this.#agent;
    const game = this.#game;
    const links = [agent, game].filter((l): l is Link => l !== null);
    if (agent?.welcomed) {
      // The game connection closes only once bye is out, so the hub reads its close as part of a planned exit.
      agent.send({ type: 'bye' }, () => {
        game?.end('stopping');
        agent.end('stopping');
      });
    } else for (const l of links) l.drop('stopping');
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(links.map((l) => l.closed)), new Promise((r) => (timer = setTimeout(r, 2000)))]);
    clearTimeout(timer);
    for (const l of links) l.drop('stopping');
  }

  #log(state: string): void {
    if (state !== this.#logged) console.log(`[hub] ${state}`);
    this.#logged = state;
  }

  #connect(): void {
    const { host, port } = this.#config.hub;
    const hello: OutMsg = {
      type: 'agentHello',
      protocol: PROTOCOL_VERSION,
      agentId: this.#config.id,
      token: this.#config.token,
      agentVersion: this.#version,
    };
    const link: Link = new Link(host, port, hello, (line) => this.#agentLine(link, line), (why) => this.#agentClosed(link, why), this.#handshakeMs);
    this.#agent = link;
  }

  #agentLine(link: Link, line: string): void {
    const r = readAgentLine(line);
    if (!link.welcomed) {
      if (r.msg?.type === 'welcome') return this.#welcomed(link);
      return link.drop(r.msg?.type === 'reject' ? `rejected: ${r.msg.reason}` : 'the hub answered the hello with something else');
    }
    if (r.msg === null) {
      if (r.id !== null) return link.send({ type: 'reply', id: r.id, ok: false, error: r.why });
      return console.error(`[hub] dropped a line from the hub: ${r.why}`);
    }
    if (r.msg.type !== 'welcome' && r.msg.type !== 'reject') void this.#request(link, r.msg);
  }

  async #request(link: Link, req: AgentRequest): Promise<void> {
    const handler = this.#handlers[req.type] as ((req: AgentRequest) => Promise<unknown>) | undefined;
    let reply: AgentMsg;
    if (!handler) reply = { type: 'reply', id: req.id, ok: false, error: `${req.type} is not supported by ${this.#version}` };
    else {
      try {
        const data = await handler(req);
        reply = data === undefined ? { type: 'reply', id: req.id, ok: true } : { type: 'reply', id: req.id, ok: true, data };
      } catch (err) {
        reply = { type: 'reply', id: req.id, ok: false, error: String(err instanceof Error ? err.message : err).slice(0, LIMITS.detail) };
      }
    }
    if (this.#agent === link) link.send(reply);
  }

  #welcomed(link: Link): void {
    link.welcome();
    this.#failures = 0;
    this.#log(`connected to the hub at ${this.#config.hub.host}:${this.#config.hub.port} as ${this.#version}`);
    void this.#writeConnected();
    this.#ping = setInterval(() => link.send({ type: 'ping' }), this.#pingMs);
    if (this.#service) link.send({ type: 'serviceState', ...this.#service });
    if (this.#reading) this.#openGame(this.#reading.modVersion);
  }

  #agentClosed(link: Link, why: string): void {
    if (this.#agent !== link) return;
    this.#agent = null;
    clearInterval(this.#ping);
    this.#game?.end('the Agent connection closed');
    if (this.#stopping) return;
    this.#log(`no connection to the hub at ${this.#config.hub.host}:${this.#config.hub.port} (${why}): retrying`);
    this.#retry = setTimeout(() => this.#connect(), backoff(this.#failures++, this.#backoffMs, this.#maxBackoffMs, this.#random));
  }

  /** `<root>/connected`, written whole or not at all: the deploy's gate reads it. */
  async #writeConnected(): Promise<void> {
    const file = join(this.#config.root, 'connected');
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ version: this.#version, time: Date.now() }) + '\n');
      await rename(tmp, file);
    } catch (err) {
      console.error(`[hub] can't write ${file}: ${(err as Error).message}`);
    }
  }

  #openGame(modVersion: string): void {
    if (this.#game || !this.connected || this.#stopping) return;
    const { host, port } = this.#config.hub;
    const hello: OutMsg = { type: 'hello', protocol: PROTOCOL_VERSION, serverId: this.#config.server.id, token: this.#config.token, modVersion };
    const link: Link = new Link(host, port, hello, (line) => this.#gameLine(link, line), (why) => this.#gameClosed(link, why), this.#handshakeMs);
    this.#game = link;
  }

  #gameLine(link: Link, line: string): void {
    const r = readGameLine(line);
    if (!link.welcomed) {
      if (r.msg?.type !== 'welcome') {
        return link.drop(r.msg?.type === 'reject' ? `rejected: ${r.msg.reason}` : 'the hub answered the hello with something else');
      }
      link.welcome();
      if (this.#gameLogged !== 'up') console.log(`[game] connected for server ${this.#config.server.id}`);
      this.#gameLogged = 'up';
      return;
    }
    if (r.msg === null) console.log(`[game] ignored a line from the hub: ${r.why}`);
  }

  #gameClosed(link: Link, why: string): void {
    if (this.#game !== link) return;
    this.#game = null;
    if (why !== this.#gameLogged) console.log(`[game] closed: ${why}`);
    this.#gameLogged = why;
  }
}

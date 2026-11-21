// `Agents` (with `integrations.agents`): the Agent port, a second listener on `listen` (`start` resolves once it is
// bound; while its address isn't on this machine yet, EADDRNOTAVAIL, it tries again every 10 s, logged once, and
// startup never waits for it). A connection is accepted only from a configured Agent's address with fewer than 4
// open, nothing read first (`listener.ts`); its lines are read within the Agent port's budgets (`budgets.ts`: the one
// table of them), before and after the handshake; a line whose handling throws ends only its own connection. Its first
// line, within 5 s: an `agentHello` (an id in config whose `address` is the peer's, its token by `timingSafeEqual`,
// the protocol in range; a second connection replaces the first) or a game `hello` (that Agent's token, for its own
// `server`, while its Agent connection is up), whose lines it then parses with `parseModLine` and hands, within their
// budgets, to the handler `ServerHub.attach` returns (`cmdLate`, `quest` and `achievement`, which an Agent never
// sends, dropped: `NOT_FROM_AGENTS`); either refused (`reconnecting too fast`) under 5 s after the last one of its
// kind for that Agent was welcomed (`HANDSHAKE_MS`, exported: the agent's tests check its copy), the live one kept;
// else `reject`, then the connection is ended and destroyed within 2 s whatever the peer does. The registry (`get`,
// `list`: connected, and the version and Node (`node`, null without one) its latest `agentHello` named). An Agent
// with no line for 20 s, or whose connection closes without `bye`, is lost: `ServerHub.agentDown` (its server
// `lost`), one `agentLost` host notice, then `agentBack` when it connects again; after `bye` only `agentDown`. What
// an Agent connection's lines do (its `events`, host samples, replies and pushes) is `dispatch.ts`'s.
// `request(id, call, { id, timeoutMs })`: typed RPCs with a fresh id (or `id`: an `update`'s, which its steps and end
// carry) and a 30 s timeout unless the call gives its own, an ok reply's data through `parseReplyData`; rejected when
// not connected, refused (`AgentRefused`, its `error`: an `ok: false` reply), late, malformed or cut off. Events
// (typed): `agentUp` (every welcomed Agent connection), `agentLost`, `agentBack` and what an Agent pushes
// (`serviceState`, `saves`, `installed`, `updateStep`, `updateDone`, `deployResult`, `settings`, each the parser's
// schema-only copy). Its throttles by the hub's clock (handshakes, host samples, drop logs) treat a time before their
// last stamp, a clock stepped back, as long after it. It re-exports `public.ts` (`AgentsOptions`, the event and
// request types, `AgentStatus`, `AGENT_FLOOR`, `beforeAgentFloor`, `beforeAgentRelease`, `AgentRefused`) and
// `budgets.ts`'s `everyMinute` and `DropLogs`. Hub core.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { AgentConfig, AgentsIntegration } from '../config.ts';
import type { Hosts } from './host.ts';
import { parseModLine, type AgentHello, type Hello, type ModMsg } from '../protocol.ts';
import { protocolRefusal, tokenMatches, type ServerHub } from '../servers/servers.ts';
import { ago, budget, connBudgets, everyMinute, LINES, type Budget, type DropLogs, type Rate } from './budgets.ts';
import { agentLine, ask, dropPending, newPlayers, type Conn, type Dispatch } from './dispatch.ts';
import { accept, PEER_SOCKETS, reject, send, type Next, type Port } from './listener.ts';
import type { AgentAnswer, AgentCall, AgentEvents, AgentStatus, AgentsOptions, Pushed } from './public.ts';

export { everyMinute, type DropLogs } from './budgets.ts';
export {
  AGENT_FLOOR,
  AgentRefused,
  beforeAgentFloor,
  beforeAgentRelease,
  type AgentAnswer,
  type AgentCall,
  type AgentEvents,
  type AgentStatus,
  type AgentsOptions,
} from './public.ts';

export const HANDSHAKE_MS = 5_000;
/** What a Mod sends but an Agent's game connection never does (docs/protocol.md): dropped from it. */
const NOT_FROM_AGENTS = new Set<string>(['cmdLate', 'quest', 'achievement'] satisfies ModMsg['type'][]);

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
  #cfg: AgentsIntegration;
  #byId = new Map<string, AgentConfig>();
  #addresses: Set<string>;
  #conns = new Map<string, Conn>();
  #versions = new Map<string, string>();
  #nodes = new Map<string, string>(); // each Agent's Node, as its latest hello named it
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
  #port: Port; // what `accept` needs of this
  #dispatch: Dispatch; // what `agentLine` needs of this

  constructor(
    hub: Pick<ServerHub, 'attach' | 'agentUp' | 'agentDown' | 'publishTarget' | 'get'>,
    hosts: Pick<Hosts, 'get'>,
    cfg: AgentsIntegration,
    opts: AgentsOptions = {},
  ) {
    super();
    this.#hub = hub;
    this.#cfg = cfg;
    for (const a of cfg.agents) this.#byId.set(a.id, a);
    this.#addresses = new Set(cfg.agents.map((a) => a.address));
    this.#helloTimeoutMs = opts.helloTimeoutMs ?? 5_000;
    this.#silenceMs = opts.silenceMs ?? 20_000;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.#bindRetryMs = opts.bindRetryMs ?? 10_000;
    this.#handshakeMs = opts.handshakeMs ?? HANDSHAKE_MS;
    this.#rate = opts.rate ?? LINES;
    this.#port = {
      addresses: this.#addresses, perPeer: this.#perPeer, sockets: this.#sockets, tooMany: this.#tooMany,
      helloTimeoutMs: this.#helloTimeoutMs,
      budget: (key) => this.#budget(key),
      agentHello: (socket, peer, hello) => this.#agentHello(socket, peer, hello),
      gameHello: (socket, peer, hello) => this.#gameHello(socket, peer, hello),
    };
    const emit = (type: Pushed['type'], id: string, msg: Pushed) =>
      (this.emit as (event: Pushed['type'], id: string, msg: Pushed) => boolean)(type, id, msg);
    this.#dispatch = { hub, hosts, sampled: this.#sampled, eventsOff: this.#eventsOff, emit };
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
        const server = createServer({ pauseOnConnect: true }, (socket) => accept(socket, this.#port));
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
    return a && { id, name: a.name, server: a.server, connected: this.#conns.has(id), version: this.#versions.get(id) ?? null, node: this.#nodes.get(id) ?? null };
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
    return ask(conn, agentId, call, id, timeoutMs ?? this.#requestTimeoutMs);
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
    if (!cfg || reason) return reject(socket, reason ?? 'unknown agentId or bad token');
    const key = `agent ${cfg.id}`;
    if (this.#tooSoon(key)) return reject(socket, 'reconnecting too fast');
    const budget = this.#budget(key);
    const conn: Conn = { socket, bye: false, silence: setTimeout(() => socket.destroy(), this.#silenceMs), pending: new Map(), budgets: connBudgets(budget) };
    const old = this.#conns.get(cfg.id);
    this.#conns.set(cfg.id, conn);
    old?.socket.destroy();
    this.#versions.set(cfg.id, hello.agentVersion);
    if (hello.node === undefined) this.#nodes.delete(cfg.id);
    else this.#nodes.set(cfg.id, hello.node);
    send(socket, { type: 'welcome' });
    this.#hub.agentUp(cfg.server);
    this.emit('agentUp', cfg.id);
    if (this.#lost.delete(cfg.id)) {
      this.#hub.publishTarget({ target: 'host', id: cfg.id, type: 'notice', severity: 'good', kind: 'agentBack', name: cfg.name });
      this.emit('agentBack', cfg.id);
    }
    socket.on('close', () => this.#closed(cfg, conn));
    return { lines: budget.lines, onLine: (line) => agentLine(cfg, conn, line, this.#dispatch) };
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
    if (reason) return reject(socket, reason);
    const key = `game ${hello.serverId}`;
    if (this.#tooSoon(key)) return reject(socket, 'reconnecting too fast');
    const budget = this.#budget(key);
    const budgets = connBudgets(budget);
    const handle = this.#hub.attach(socket, hello.serverId, hello.modVersion);
    return {
      lines: budget.lines,
      onLine: (line) => {
        const msg = parseModLine(line);
        // Junk after the handshake, and what an Agent never sends, is ignored; a message over its type's budget is dropped.
        if (!msg || msg.type === 'hello' || NOT_FROM_AGENTS.has(msg.type) || !budgets.allows(msg)) return;
        handle(msg.type === 'heartbeat' ? newPlayers(this.#hub, hello.serverId, budget, msg) : msg);
      },
    };
  }

  #closed(cfg: AgentConfig, conn: Conn): void {
    clearTimeout(conn.silence);
    dropPending(conn, cfg.id);
    if (this.#conns.get(cfg.id) !== conn) return; // replaced by a newer connection
    this.#conns.delete(cfg.id);
    if (this.#closing) return;
    this.#hub.agentDown(cfg.server);
    if (conn.bye) return;
    this.#lost.add(cfg.id);
    this.#hub.publishTarget({ target: 'host', id: cfg.id, type: 'notice', severity: 'warning', kind: 'agentLost', name: cfg.name });
    this.emit('agentLost', cfg.id);
  }

}

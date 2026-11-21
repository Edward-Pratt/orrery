// `ServerHub`: the Mod port (`listen`) and the Agents' game connections (`attach(socket, serverId, modVersion)` from
// `Agents`, which keeps reading the socket and feeds the returned function its messages, parsed and within their
// budgets; the socket joins those `close` destroys), per-server state, liveness (crash/stop/hung; `start()`, which
// `startHub` always calls, runs hung detection and the 60 s grace period, after which a server that can't connect
// stays unknown: a factorio server whose Agent isn't connected, a minecraft one while the Mod port isn't open
// (`listen`, only with `integrations.minecraft`)), the Agent rules (`agentUp`/`agentDown`: an Agent leaving drops its
// server's game connection and makes it `lost`), `downs(id)` (how many times a server's game connection went away
// since the hub started, counted whether or not its down event fits the lifecycle budget), `say`, `broadcast(id, text,
// by)` (a hub line in game, such as a countdown's: a Mod's server runs `say <text>` through `runCommand`, audited as
// `by`; a factorio server's Agent gets a `notice`, cleaned like `say`, and builds the game's command itself),
// `backup(id, by)` (a Backup now: a Mod's server runs `backup start` through `runCommand`, resolving with its output; a
// factorio server's Agent gets `save`, audited as `backup`, resolving with none; the game's `backup` event follows
// either way), `runCommand`, `audit` (entries go to the `HubOptions.audit` sink: the database), `event` emitter (game,
// lifecycle and hub-core `notice` events, plus `say` for chat sent in game, with its `source` (`discord` or
// `dashboard`), `console` for command output, late output included, `tps` and `paused` from heartbeats), `publish`
// (hub-core modules put typed notices — kind, severity, details — on it), `modVersion` (what a server's Mod reported
// in its latest hello, kept after it disconnects), and `publishTarget` for notices about the host, a service, a check
// or a deploy (`target` events, apart from server `event`s so server handlers never see them). The API frontends use.
// The class owns the state, the listener and every socket; its flows share that state (`ServerCtx`, `server-ctx.ts`):
// a connection's handshake, open and close (`connections.ts`), its messages and hung detection (`dispatch.ts`), the
// lifecycle events and a factorio server's budget for them (`lifecycle-budget.ts`), `runCommand` (`commands.ts`), and
// the text and hello checks (`server-text.ts`). This file re-exports the names callers import from it.

import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { LIMITS, type ModMsg } from '../protocol.ts';
import type { Announcement, AuditEntry, ChatSource, HubEvent, Notice, ServerState, TargetEvent } from '../types.ts';
import { runCommand } from './commands.ts';
import { offline, open, readHandshake } from './connections.ts';
import { checkHung } from './dispatch.ts';
import { emitLifecycle, type LifecycleBudget } from './lifecycle-budget.ts';
import { send, type Conn, type HubOptions, type Late, type ServerConfig, type ServerCtx } from './server-ctx.ts';
import { mcText } from './server-text.ts';

export { CommandRefused } from './commands.ts';
export type { HubOptions, ServerConfig } from './server-ctx.ts';
export { mcText, protocolRefusal, stripCodes, tokenMatches, truncate } from './server-text.ts';
export type {
  Announcement,
  AuditEntry,
  ChatSource,
  FeedEvent,
  GameMsg,
  HubEvent,
  CheckStatus,
  HostSample,
  HubOutput,
  Lifecycle,
  LiveEvent,
  Notice,
  Paused,
  ServerState,
  ServiceStatus,
  ServiceVerb,
  Severity,
  Target,
  TargetEvent,
  TargetNotice,
  Tps,
} from '../types.ts';

/**
 * Owns the game connections (a Mod's on the Mod port; an Agent's for its factorio server, handed over by `Agents`
 * through `attach`) and every configured server's state.
 * Frontends (Discord now, a web dashboard later) use only this public API.
 * Server events are `event`s; events about the host, services and checks are `target`s, so server handlers never see them.
 */
export class ServerHub extends EventEmitter<{ event: [HubEvent]; target: [TargetEvent] }> {
  #c: ServerCtx; // what the flows share with this (`server-ctx.ts`)
  #configs = new Map<string, ServerConfig>();
  #states = new Map<string, ServerState>();
  #conns = new Map<string, Conn>();
  #modVersions = new Map<string, string>(); // kept after a disconnect: what the server last ran
  #downs = new Map<string, number>(); // times each server's game connection went away (`downs`)
  #sockets = new Set<Socket>(); // every accepted or attached socket, including ones still before the handshake
  #agentsUp = new Set<string>(); // factorio servers whose Agent connection is up
  #settling = new Map<string, NodeJS.Timeout>(); // factorio servers whose game connection closed, waiting on the Agent
  #lifecycle = new Map<string, LifecycleBudget>(); // factorio servers' lifecycle budgets, kept across connections
  #server: Server | null = null;
  #timer: NodeJS.Timeout | undefined;
  #grace: NodeJS.Timeout | undefined;
  #late = new Map<string, Late>(); // command id -> handler for output that arrives after the result
  #graceMs: number;
  #audit: (entry: AuditEntry) => void;

  constructor(servers: ServerConfig[], opts: HubOptions = {}) {
    super();
    for (const s of servers) {
      if (s.token !== undefined && s.token.length < 16) throw new Error(`server "${s.id}": token must be at least 16 characters`);
      this.#configs.set(s.id, s);
      this.#states.set(s.id, { id: s.id, name: s.name, game: s.game, online: false, hung: false, paused: false, tps: null, players: [], dims: [] });
    }
    this.#graceMs = opts.graceMs ?? 60_000; // longer than the mod's 30 s max reconnect backoff
    this.#audit = opts.audit ?? (() => {});
    this.#c = {
      configs: this.#configs,
      states: this.#states,
      conns: this.#conns,
      modVersions: this.#modVersions,
      downs: this.#downs,
      agentsUp: this.#agentsUp,
      settling: this.#settling,
      lifecycle: this.#lifecycle,
      late: this.#late,
      listening: false,
      closing: false,
      hungMs: opts.hungMs ?? 30_000,
      cmdTimeoutMs: opts.cmdTimeoutMs ?? 10_000,
      lateMs: opts.lateMs ?? 15 * 60_000, // Discord allows interaction follow-ups for 15 minutes
      helloTimeoutMs: opts.helloTimeoutMs ?? 5_000,
      settleMs: opts.settleMs ?? 5_000,
      emit: (e) => this.emit('event', e),
      audit: (actor, action, target, details) => this.audit(actor, action, target, details),
    };
  }

  /**
   * Starts hung detection and the grace period, whichever connections come (the Mod port's, the Agent port's): the
   * hub always calls it.
   */
  start(): void {
    this.#timer = setInterval(() => checkHung(this.#c), Math.min(5_000, this.#c.hungMs / 2));
    // Servers still not connected after the grace period are down (else uptime stays 'unknown' forever); one that
    // can't connect stays unknown: a factorio server whose Agent isn't connected, a minecraft one with no Mod port.
    this.#grace = setTimeout(() => {
      for (const s of this.#states.values()) {
        const canConnect = s.game === 'factorio' ? this.#agentsUp.has(s.id) : this.#c.listening;
        if (!this.#conns.has(s.id) && canConnect) emitLifecycle(this.#c, s.id, 'offline');
      }
    }, this.#graceMs);
  }

  /** Opens the Mod port. Resolves with the bound port (pass 0 for a random one). */
  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.#accept(socket));
      server.once('error', reject);
      server.listen(port, host, () => {
        this.#server = server;
        this.#c.listening = true;
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    this.#c.closing = true;
    clearInterval(this.#timer);
    clearTimeout(this.#grace);
    for (const timer of this.#settling.values()) clearTimeout(timer);
    for (const b of this.#lifecycle.values()) clearTimeout(b.timer);
    for (const late of this.#late.values()) clearTimeout(late.timer);
    for (const socket of this.#sockets) socket.destroy();
    return new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  list(): ServerState[] {
    return [...this.#states.values()].map((s) => ({ ...s, players: [...s.players], dims: [...s.dims] }));
  }

  get(id: string): ServerState | undefined {
    const s = this.#states.get(id);
    return s && { ...s, players: [...s.players], dims: [...s.dims] };
  }

  /**
   * How many times the server's game connection has gone away since the hub started (it closed, or went with its
   * Agent): it counts even when a factorio server's `stopped`, `crashed` or `lost` is dropped over its lifecycle
   * budget, so a restart countdown can tell the server went down since it began without that event.
   */
  downs(id: string): number {
    return this.#downs.get(id) ?? 0;
  }

  /** The version the server's Mod reported in its latest hello; undefined if it never connected. */
  modVersion(id: string): string | undefined {
    return this.#modVersions.get(id);
  }

  /**
   * Broadcasts a chat line in-game, marked with where it came from (`author`: a Discord name, or a dashboard user's
   * username or the name they linked). False if the server is offline or the text is empty after cleaning.
   */
  say(id: string, author: string, message: string, source: ChatSource): boolean {
    const conn = this.#conns.get(id);
    const text = mcText(message, 256);
    if (!conn || !text) return false;
    const msg = { type: 'say', author: mcText(author, 32) || '?', message: text, source } as const;
    send(conn.socket, msg);
    this.emit('event', { ...msg, serverId: id });
    return true;
  }

  /**
   * A line from the hub itself to everyone in game, such as a countdown's. A Mod's server runs `say <text>`, a console
   * command audited as `by` and put on the stream like any; a factorio server's Agent gets a `notice` and builds the
   * game's command itself. Rejects if the server is offline or the text is empty after cleaning.
   */
  broadcast(id: string, text: string, by: string): Promise<void> {
    if (this.#states.get(id)?.game !== 'factorio') return this.runCommand(id, `say ${text}`, by).then(() => {});
    const conn = this.#conns.get(id);
    const message = mcText(text, LIMITS.message);
    if (!conn) return Promise.reject(new Error(`${this.#states.get(id)!.name} is offline`));
    if (!message) return Promise.reject(new Error('empty notice'));
    send(conn.socket, { type: 'notice', message });
    return Promise.resolve();
  }

  /**
   * Starts a Backup now. A Mod's server runs `backup start` through `runCommand` (audited as a command, resolved with
   * its output); a factorio server's Agent gets `save` (audited as `backup`, resolved with no output) and makes a named
   * save itself. Either way the game's `backup` event follows when it is done. Rejects if the server is offline.
   */
  backup(id: string, by: string): Promise<string[]> {
    if (this.#states.get(id)?.game !== 'factorio') return this.runCommand(id, 'backup start', by);
    const conn = this.#conns.get(id);
    if (!conn) return Promise.reject(new Error(`${this.#states.get(id)!.name} is offline`));
    this.audit(by, 'backup', id, 'save');
    send(conn.socket, { type: 'save' });
    return Promise.resolve([]);
  }

  /** Puts a hub-core notice about a server on the event stream. */
  publish(serverId: string, notice: Notice): void {
    this.emit('event', { ...notice, type: 'notice', serverId });
  }

  /** Puts a hub-core event about the host, a service or a check (a notice, a host sample) on the event stream. */
  publishTarget(e: TargetEvent): void {
    this.emit('target', e);
  }

  /** Puts a hub-core announcement (a quest batch, a new link, the daily summary) about a server on the event stream. */
  announce(serverId: string, announcement: Announcement): void {
    this.emit('event', { ...announcement, serverId });
  }

  /** Tells a player in game how their `/discord link` or `unlink` went. False if the server is offline. */
  sendLinkResult(id: string, player: string, ok: boolean, message: string): boolean {
    const conn = this.#conns.get(id);
    if (!conn) return false;
    send(conn.socket, { type: 'linkResult', player, ok, message });
    return true;
  }

  /** Records an action on server `target` in the audit log. */
  audit(actor: string, action: string, target: string, details = ''): void {
    this.#audit({ actor, action, target, details });
  }

  /**
   * Runs a console command, control characters taken out; a Mod's without a leading `/`, a factorio server's as typed
   * (`/players`: Factorio's console takes plain text as chat) and at most `LIMITS.text` (256) characters, as its Agent
   * takes no longer one (else `CommandRefused`). `by` names who asked, for the audit log. `onLate` gets output that
   * arrives after the result (e.g. spark's profiler link), for 15 minutes. The output, late or not, also goes on the
   * event stream.
   */
  runCommand(id: string, command: string, by: string, onLate?: (output: string[]) => void): Promise<string[]> {
    return runCommand(this.#c, id, command, by, onLate);
  }

  /**
   * A factorio server's game connection, its hello already checked by `Agents` (the Agent's token, for its own server,
   * while its Agent connection is up). From here it is like a Mod's: the welcome goes out, and the returned function
   * takes each of its messages, which `Agents` reads with its line cap and budgets and parses with `parseModLine`.
   */
  attach(socket: Socket, serverId: string, modVersion: string): (msg: ModMsg) => void {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    return open(this.#c, socket, serverId, modVersion);
  }

  /** A factorio server's Agent connection is up: its game connection may come, and it is offline until it does. */
  agentUp(serverId: string): void {
    this.#agentsUp.add(serverId);
  }

  /**
   * A factorio server's Agent left, by `bye` or lost: its game connection (if any) is dropped and the server is `lost`
   * (unknown, nothing posted), even if that connection had just closed without `stopping`.
   */
  agentDown(serverId: string): void {
    this.#agentsUp.delete(serverId);
    const settling = this.#settling.get(serverId);
    clearTimeout(settling);
    this.#settling.delete(serverId);
    const conn = this.#conns.get(serverId);
    if (conn) {
      this.#conns.delete(serverId); // its close is then not a crash
      offline(this.#c, serverId);
      conn.socket.destroy();
    }
    if (!this.#c.closing) emitLifecycle(this.#c, serverId, 'lost');
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    readHandshake(this.#c, socket, () => this.#sockets.delete(socket));
  }
}

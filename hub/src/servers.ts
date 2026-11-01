import { randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { LIMITS, MIN_PROTOCOL, PROTOCOL_VERSION, parseModLine, type Hello, type HubMsg, type ModMsg } from './protocol.ts';
import type { Announcement, AuditEntry, ChatSource, Game, HubEvent, Lifecycle, Notice, ServerState, TargetEvent } from './types.ts';
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
} from './types.ts';

/** No token: the server can't connect (the Minecraft integration is off, or it isn't a minecraft server). */
export type ServerConfig = { id: string; name: string; game: Game; token?: string };

export type HubOptions = {
  hungMs?: number;
  cmdTimeoutMs?: number;
  helloTimeoutMs?: number;
  graceMs?: number;
  lateMs?: number;
  /**
   * How long a factorio server's game connection that closed without `stopping`, while its Agent connection is up,
   * waits for that one to close too (then its Agent is lost, not the server crashed).
   */
  settleMs?: number;
  /** Where audit entries go (the hub's database). */
  audit?: (entry: AuditEntry) => void;
};

type Late = { command: string; by: string; onLate?: (output: string[]) => void; timer: NodeJS.Timeout };

type Pending = { resolve: (output: string[]) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
type Conn = {
  socket: Socket;
  stopping: boolean;
  lastBeat: number;
  hung: boolean;
  pending: Map<string, Pending>;
  /** The last TPS put on the event stream. */
  sentTps: number | null;
  /** Its `started` is on the stream: one per connection (a Mod's server starts once per connection anyway). */
  started: boolean;
};

/** Removes Minecraft § formatting codes. */
export function stripCodes(s: string): string {
  return s.replace(/§.?/gs, '');
}

/** Cuts s to at most max UTF-16 units without leaving half an emoji (a lone high surrogate) at the end. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Makes untrusted text safe for a single line of Minecraft chat. */
export function mcText(s: string, max: number): string {
  return truncate(
    stripCodes(s)
      .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
      .trim(),
    max,
  );
}

/** Compares a configured token with one a connection sent, in constant time. */
export function tokenMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A console command its server's game connection would not take, refused before it is audited or sent: a factorio
 * server's over `LIMITS.text` (256) characters, which its Agent refuses (docs/protocol.md, `cmd`).
 */
export class CommandRefused extends Error {}

/** Why a hello's protocol version is refused (the same range for a Mod's hello and an Agent's), or null. */
export function protocolRefusal(p: number): string | null {
  if (Number.isInteger(p) && p >= MIN_PROTOCOL && p <= PROTOCOL_VERSION) return null;
  const speaks = MIN_PROTOCOL === PROTOCOL_VERSION ? `${PROTOCOL_VERSION}` : `${MIN_PROTOCOL}–${PROTOCOL_VERSION}`;
  return `protocol ${p} not supported (hub speaks ${speaks})`;
}

/**
 * Owns the game connections (a Mod's on the Mod port; an Agent's for its factorio server, handed over by `Agents`
 * through `attach`) and every configured server's state.
 * Frontends (Discord now, a web dashboard later) use only this public API.
 * Server events are `event`s; events about the host, services and checks are `target`s, so server handlers never see them.
 */
export class ServerHub extends EventEmitter<{ event: [HubEvent]; target: [TargetEvent] }> {
  #configs = new Map<string, ServerConfig>();
  #states = new Map<string, ServerState>();
  #conns = new Map<string, Conn>();
  #modVersions = new Map<string, string>(); // kept after a disconnect: what the server last ran
  #sockets = new Set<Socket>(); // every accepted or attached socket, including ones still before the handshake
  #agentsUp = new Set<string>(); // factorio servers whose Agent connection is up
  #settling = new Map<string, NodeJS.Timeout>(); // factorio servers whose game connection closed, waiting on the Agent
  #server: Server | null = null;
  #timer: NodeJS.Timeout | undefined;
  #grace: NodeJS.Timeout | undefined;
  #closing = false;
  #hungMs: number;
  #cmdTimeoutMs: number;
  #lateMs: number;
  #late = new Map<string, Late>(); // command id -> handler for output that arrives after the result
  #helloTimeoutMs: number;
  #graceMs: number;
  #settleMs: number;
  #audit: (entry: AuditEntry) => void;

  constructor(servers: ServerConfig[], opts: HubOptions = {}) {
    super();
    for (const s of servers) {
      if (s.token !== undefined && s.token.length < 16) throw new Error(`server "${s.id}": token must be at least 16 characters`);
      this.#configs.set(s.id, s);
      this.#states.set(s.id, { id: s.id, name: s.name, game: s.game, online: false, hung: false, paused: false, tps: null, players: [], dims: [] });
    }
    this.#hungMs = opts.hungMs ?? 30_000;
    this.#cmdTimeoutMs = opts.cmdTimeoutMs ?? 10_000;
    this.#lateMs = opts.lateMs ?? 15 * 60_000; // Discord allows interaction follow-ups for 15 minutes
    this.#helloTimeoutMs = opts.helloTimeoutMs ?? 5_000;
    this.#graceMs = opts.graceMs ?? 60_000; // longer than the mod's 30 s max reconnect backoff
    this.#settleMs = opts.settleMs ?? 5_000;
    this.#audit = opts.audit ?? (() => {});
  }

  /**
   * Starts hung detection and the grace period, whichever connections come (the Mod port's, the Agent port's): the
   * hub always calls it.
   */
  start(): void {
    this.#timer = setInterval(() => this.#checkHung(), Math.min(5_000, this.#hungMs / 2));
    // Servers still not connected after the grace period are down (else uptime stays 'unknown' forever); a factorio
    // server whose Agent isn't connected stays unknown.
    this.#grace = setTimeout(() => {
      for (const s of this.#states.values()) {
        if (!this.#conns.has(s.id) && (s.game !== 'factorio' || this.#agentsUp.has(s.id))) this.#emit(s.id, 'offline');
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
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#timer);
    clearTimeout(this.#grace);
    for (const timer of this.#settling.values()) clearTimeout(timer);
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

  /** The version the server's Mod reported in its latest hello; undefined if it never connected. */
  modVersion(id: string): string | undefined {
    return this.#modVersions.get(id);
  }

  /**
   * Broadcasts a chat line in-game, marked with where it came from. `avatar` (the admin's, for a dashboard line) goes
   * only on the event, not to the mod. False if the server is offline or the text is empty after cleaning.
   */
  say(id: string, author: string, message: string, source: ChatSource, avatar?: string): boolean {
    const conn = this.#conns.get(id);
    const text = mcText(message, 256);
    if (!conn || !text) return false;
    const msg = { type: 'say', author: mcText(author, 32) || '?', message: text, source } as const;
    this.#send(conn.socket, msg);
    this.emit('event', { ...msg, ...(avatar && { avatar }), serverId: id });
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
    this.#send(conn.socket, { type: 'notice', message });
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
    this.#send(conn.socket, { type: 'save' });
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
    this.#send(conn.socket, { type: 'linkResult', player, ok, message });
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
    const conn = this.#conns.get(id);
    if (!conn) return Promise.reject(new Error(`${this.#states.get(id)?.name ?? id} is offline`));
    const typed = command.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    const factorio = this.#states.get(id)!.game === 'factorio';
    const cmd = factorio ? typed : typed.replace(/^\//, '');
    if (!cmd) return Promise.reject(new Error('empty command'));
    if (factorio && cmd.length > LIMITS.text) {
      return Promise.reject(new CommandRefused(`A Factorio console command is at most ${LIMITS.text} characters`));
    }
    this.audit(by, 'command', id, cmd);
    const cmdId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(cmdId);
        reject(new Error('command timed out — it may still run when the server responds'));
      }, this.#cmdTimeoutMs);
      conn.pending.set(cmdId, {
        resolve: (output) => {
          this.#late.set(cmdId, { command: cmd, by, onLate, timer: setTimeout(() => this.#late.delete(cmdId), this.#lateMs) });
          this.emit('event', { serverId: id, type: 'console', command: cmd, by, output });
          resolve(output);
        },
        reject,
        timer,
      });
      this.#send(conn.socket, { type: 'cmd', id: cmdId, command: cmd });
    });
  }

  /**
   * A factorio server's game connection, its hello already checked by `Agents` (the Agent's token, for its own server,
   * while its Agent connection is up). From here it is like a Mod's: the welcome goes out, and the returned function
   * takes each of its messages, which `Agents` reads with its line cap and budgets and parses with `parseModLine`.
   */
  attach(socket: Socket, serverId: string, modVersion: string): (msg: ModMsg) => void {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    return this.#open(socket, serverId, modVersion);
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
      this.#offline(serverId);
      conn.socket.destroy();
    }
    if (!this.#closing) this.#emit(serverId, 'lost');
  }

  #accept(socket: Socket): void {
    let onMsg: ((msg: ModMsg) => void) | null = null;
    this.#sockets.add(socket);
    socket.on('error', () => {}); // 'close' always follows and does the cleanup
    const helloTimer = setTimeout(() => socket.destroy(), this.#helloTimeoutMs);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('error', () => {});
    lines.on('line', (line) => {
      if (socket.destroyed || socket.writableEnded) return;
      const msg = parseModLine(line);
      if (onMsg) {
        if (msg && msg.type !== 'hello') onMsg(msg); // junk after handshake is ignored
        return;
      }
      clearTimeout(helloTimer);
      if (msg?.type !== 'hello') return void socket.destroy();
      const reason = this.#checkHello(msg);
      if (reason) {
        this.#send(socket, { type: 'reject', reason });
        return void socket.end();
      }
      onMsg = this.#open(socket, msg.serverId, msg.modVersion);
    });
    socket.on('close', () => {
      this.#sockets.delete(socket);
      clearTimeout(helloTimer);
    });
  }

  /** Makes an accepted game connection its server's: welcomed, online, and its messages handled from then on. */
  #open(socket: Socket, id: string, modVersion: string): (msg: ModMsg) => void {
    this.#settle(id); // a crash waiting on the Agent is decided before the new connection counts
    const conn: Conn = { socket, stopping: false, lastBeat: 0, hung: false, pending: new Map(), sentTps: null, started: false };
    const old = this.#conns.get(id);
    this.#conns.set(id, conn);
    old?.socket.destroy();
    Object.assign(this.#states.get(id)!, { online: true, hung: false });
    this.#modVersions.set(id, modVersion); // before `connected`, which a Mod deploy waits on
    this.#send(socket, { type: 'welcome' });
    this.#emit(id, 'connected');
    socket.on('close', () => this.#closed(id, conn));
    return (msg) => {
      if (!socket.destroyed && !socket.writableEnded) this.#handle(id, conn, msg);
    };
  }

  #closed(id: string, conn: Conn): void {
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('server disconnected'));
    }
    conn.pending.clear();
    if (this.#conns.get(id) !== conn) return; // replaced by a newer connection, or dropped with its Agent: no alert
    this.#conns.delete(id);
    this.#offline(id);
    if (this.#closing) return;
    if (conn.stopping) return this.#emit(id, 'stopped');
    if (!this.#agentsUp.has(id)) return this.#emit(id, 'crashed');
    // An Agent's game connection, with the Agent connection still up: if that one closes too, the Agent is lost.
    this.#settling.set(
      id,
      setTimeout(() => this.#settle(id), this.#settleMs),
    );
  }

  /** Decides a game connection waiting on its Agent (see `#closed`): a crash. */
  #settle(id: string): void {
    const timer = this.#settling.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.#settling.delete(id);
    this.#emit(id, 'crashed');
  }

  #offline(id: string): void {
    Object.assign(this.#states.get(id)!, { online: false, hung: false, paused: false, tps: null, players: [], dims: [] });
  }

  #checkHello(hello: Hello): string | null {
    const refused = protocolRefusal(hello.protocol);
    if (refused) return refused;
    const cfg = this.#configs.get(hello.serverId);
    if (!cfg?.token || !tokenMatches(cfg.token, hello.token)) return 'unknown serverId or bad token';
    return null;
  }

  #handle(id: string, conn: Conn, msg: ModMsg): void {
    const state = this.#states.get(id)!;
    switch (msg.type) {
      case 'heartbeat':
        conn.lastBeat = Date.now(); // paused or not: a frozen game stops them, so hung detection stays on
        if ((msg.paused === true) !== state.paused) {
          // Only an Agent's heartbeat has `paused`; the card shows it, so a change goes on the stream.
          state.paused = msg.paused === true;
          this.emit('event', { serverId: id, type: 'paused', paused: state.paused });
        }
        if (!state.paused) {
          // While paused the rate means nothing: it is left out of the state and the stream (and so of lag and history).
          if (conn.sentTps === null || Math.abs(msg.tps - conn.sentTps) >= 0.1) {
            conn.sentTps = msg.tps;
            this.emit('event', { serverId: id, type: 'tps', tps: msg.tps });
          }
          state.tps = msg.tps;
        }
        state.players = msg.players;
        state.dims = msg.dims ?? [];
        if (conn.hung) {
          conn.hung = state.hung = false;
          this.#emit(id, 'recovered');
        }
        return;
      case 'started':
        if (conn.started) return; // a repeat would be another lifecycle row and another post for one start
        conn.started = true;
        return this.#emit(id, 'started');
      case 'stopping':
        conn.stopping = true;
        return;
      case 'cmdResult': {
        const p = conn.pending.get(msg.id);
        if (!p) return; // late or unknown id
        conn.pending.delete(msg.id);
        clearTimeout(p.timer);
        return p.resolve(msg.output);
      }
      case 'cmdLate': {
        const late = this.#late.get(msg.id);
        if (!late) return; // expired or unknown
        this.emit('event', { serverId: id, type: 'console', command: late.command, by: late.by, output: msg.output, late: true });
        try {
          late.onLate?.(msg.output);
        } catch (err) {
          console.error('[hub] late output handler failed:', err);
        }
        return;
      }
      default:
        // `msg` is parseModLine's copy of only the schema's fields; serverId last: a mod can't speak for another server.
        this.emit('event', { ...msg, serverId: id });
    }
  }

  #checkHung(): void {
    const now = Date.now();
    for (const [id, conn] of this.#conns) {
      // A factorio server whose Agent is lost has its own one host notice instead (its connection is dropped anyway).
      if (this.#states.get(id)!.game === 'factorio' && !this.#agentsUp.has(id)) continue;
      // Armed by the first heartbeat (world load sends none) and disarmed by `stopping` (shutdown save).
      if (conn.hung || conn.stopping || conn.lastBeat === 0 || now - conn.lastBeat < this.#hungMs) continue;
      conn.hung = true;
      this.#states.get(id)!.hung = true;
      this.#emit(id, 'hung');
    }
  }

  #send(socket: Socket, msg: HubMsg): void {
    socket.write(JSON.stringify(msg) + '\n');
  }

  #emit(serverId: string, type: Lifecycle): void {
    this.emit('event', { serverId, type });
  }
}

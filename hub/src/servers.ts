import { randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { MIN_PROTOCOL, PROTOCOL_VERSION, parseModLine, type Hello, type HubMsg, type ModMsg } from './protocol.ts';
import type { Announcement, AuditEntry, HubEvent, Lifecycle, Notice, ServerState } from './types.ts';
export type { Announcement, AuditEntry, GameMsg, HubEvent, HubOutput, Lifecycle, Notice, ServerState, Severity, Tps } from './types.ts';

/** No token: the server can't connect (the Minecraft integration is off). */
export type ServerConfig = { id: string; name: string; token?: string };

export type HubOptions = {
  hungMs?: number;
  cmdTimeoutMs?: number;
  helloTimeoutMs?: number;
  graceMs?: number;
  lateMs?: number;
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

function tokenMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Owns the mod connections and every configured server's state.
 * Frontends (Discord now, a web dashboard later) use only this public API.
 */
export class ServerHub extends EventEmitter<{ event: [HubEvent] }> {
  #configs = new Map<string, ServerConfig>();
  #states = new Map<string, ServerState>();
  #conns = new Map<string, Conn>();
  #sockets = new Set<Socket>(); // every accepted socket, including ones still before the handshake
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
  #audit: (entry: AuditEntry) => void;

  constructor(servers: ServerConfig[], opts: HubOptions = {}) {
    super();
    for (const s of servers) {
      if (s.token !== undefined && s.token.length < 16) throw new Error(`server "${s.id}": token must be at least 16 characters`);
      this.#configs.set(s.id, s);
      this.#states.set(s.id, { id: s.id, name: s.name, online: false, hung: false, tps: null, players: [], dims: [] });
    }
    this.#hungMs = opts.hungMs ?? 30_000;
    this.#cmdTimeoutMs = opts.cmdTimeoutMs ?? 10_000;
    this.#lateMs = opts.lateMs ?? 15 * 60_000; // Discord allows interaction follow-ups for 15 minutes
    this.#helloTimeoutMs = opts.helloTimeoutMs ?? 5_000;
    this.#graceMs = opts.graceMs ?? 60_000; // longer than the mod's 30 s max reconnect backoff
    this.#audit = opts.audit ?? (() => {});
  }

  /** Starts listening. Resolves with the bound port (pass 0 for a random one). */
  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.#accept(socket));
      server.once('error', reject);
      server.listen(port, host, () => {
        this.#server = server;
        this.#timer = setInterval(() => this.#checkHung(), Math.min(5_000, this.#hungMs / 2));
        // Servers still not connected after the grace period are down (else uptime stays 'unknown' forever).
        this.#grace = setTimeout(() => {
          for (const id of this.#states.keys()) if (!this.#conns.has(id)) this.#emit(id, 'offline');
        }, this.#graceMs);
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#timer);
    clearTimeout(this.#grace);
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

  /** Broadcasts a chat line in-game. False if the server is offline or the text is empty after cleaning. */
  say(id: string, author: string, message: string): boolean {
    const conn = this.#conns.get(id);
    const text = mcText(message, 256);
    if (!conn || !text) return false;
    const msg = { type: 'say', author: mcText(author, 32) || '?', message: text } as const;
    this.#send(conn.socket, msg);
    this.emit('event', { ...msg, serverId: id });
    return true;
  }

  /** Puts a hub-core notice about a server on the event stream. */
  publish(serverId: string, notice: Notice): void {
    this.emit('event', { ...notice, type: 'notice', serverId });
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
   * Runs a console command. `by` names who asked, for the audit log. `onLate` gets output that arrives after
   * the result (e.g. spark's profiler link), for 15 minutes. The output, late or not, also goes on the event stream.
   */
  runCommand(id: string, command: string, by: string, onLate?: (output: string[]) => void): Promise<string[]> {
    const conn = this.#conns.get(id);
    if (!conn) return Promise.reject(new Error(`${this.#states.get(id)?.name ?? id} is offline`));
    const cmd = command.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().replace(/^\//, '');
    if (!cmd) return Promise.reject(new Error('empty command'));
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

  #accept(socket: Socket): void {
    let id = '';
    let conn: Conn | null = null;
    this.#sockets.add(socket);
    socket.on('error', () => {}); // 'close' always follows and does the cleanup
    const helloTimer = setTimeout(() => socket.destroy(), this.#helloTimeoutMs);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('error', () => {});
    lines.on('line', (line) => {
      if (socket.destroyed || socket.writableEnded) return;
      const msg = parseModLine(line);
      if (conn) {
        if (msg && msg.type !== 'hello') this.#handle(id, conn, msg); // junk after handshake is ignored
        return;
      }
      clearTimeout(helloTimer);
      if (msg?.type !== 'hello') return void socket.destroy();
      const reason = this.#checkHello(msg);
      if (reason) {
        this.#send(socket, { type: 'reject', reason });
        return void socket.end();
      }
      id = msg.serverId;
      conn = { socket, stopping: false, lastBeat: 0, hung: false, pending: new Map(), sentTps: null };
      const old = this.#conns.get(id);
      this.#conns.set(id, conn);
      old?.socket.destroy();
      Object.assign(this.#states.get(id)!, { online: true, hung: false });
      this.#send(socket, { type: 'welcome' });
      this.#emit(id, 'connected');
    });
    socket.on('close', () => {
      this.#sockets.delete(socket);
      clearTimeout(helloTimer);
      if (!conn) return;
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('server disconnected'));
      }
      conn.pending.clear();
      if (this.#conns.get(id) !== conn) return; // replaced by a newer connection: no alert
      this.#conns.delete(id);
      Object.assign(this.#states.get(id)!, { online: false, hung: false, tps: null, players: [], dims: [] });
      if (!this.#closing) this.#emit(id, conn.stopping ? 'stopped' : 'crashed');
    });
  }

  #checkHello(hello: Hello): string | null {
    const p = hello.protocol;
    if (!Number.isInteger(p) || p < MIN_PROTOCOL || p > PROTOCOL_VERSION) {
      const speaks = MIN_PROTOCOL === PROTOCOL_VERSION ? `${PROTOCOL_VERSION}` : `${MIN_PROTOCOL}–${PROTOCOL_VERSION}`;
      return `protocol ${p} not supported (hub speaks ${speaks})`;
    }
    const cfg = this.#configs.get(hello.serverId);
    if (!cfg?.token || !tokenMatches(cfg.token, hello.token)) return 'unknown serverId or bad token';
    return null;
  }

  #handle(id: string, conn: Conn, msg: ModMsg): void {
    const state = this.#states.get(id)!;
    switch (msg.type) {
      case 'heartbeat':
        conn.lastBeat = Date.now();
        if (conn.sentTps === null || Math.abs(msg.tps - conn.sentTps) >= 0.1) {
          conn.sentTps = msg.tps;
          this.emit('event', { serverId: id, type: 'tps', tps: msg.tps });
        }
        state.tps = msg.tps;
        state.players = msg.players;
        state.dims = msg.dims ?? [];
        if (conn.hung) {
          conn.hung = state.hung = false;
          this.#emit(id, 'recovered');
        }
        return;
      case 'started':
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
        this.emit('event', { ...msg, serverId: id }); // serverId last: a mod can't speak for another server
    }
  }

  #checkHung(): void {
    const now = Date.now();
    for (const [id, conn] of this.#conns) {
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

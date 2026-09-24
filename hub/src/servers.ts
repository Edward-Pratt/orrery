import { randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { PROTOCOL_VERSION, parseModLine, type Hello, type HubMsg, type ModMsg } from './protocol.ts';

export type ServerConfig = { id: string; name: string; token: string };

export type ServerState = {
  id: string;
  name: string;
  online: boolean;
  hung: boolean;
  tps: number | null;
  players: string[];
};

export type Lifecycle = 'connected' | 'started' | 'stopped' | 'crashed' | 'hung' | 'recovered' | 'offline';
export type GameMsg = Extract<ModMsg, { type: 'chat' | 'join' | 'leave' | 'death' | 'achievement' }>;
export type HubEvent = { serverId: string } & (GameMsg | { type: Lifecycle });

export type HubOptions = { hungMs?: number; cmdTimeoutMs?: number; helloTimeoutMs?: number; graceMs?: number };

type Pending = { resolve: (output: string[]) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
type Conn = { socket: Socket; stopping: boolean; lastBeat: number; hung: boolean; pending: Map<string, Pending> };

/** Removes Minecraft § formatting codes. */
export function stripCodes(s: string): string {
  return s.replace(/§.?/gs, '');
}

/** Makes untrusted text safe for a single line of Minecraft chat. */
export function mcText(s: string, max: number): string {
  return stripCodes(s)
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
    .trim()
    .slice(0, max);
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
  #server: Server | null = null;
  #timer: NodeJS.Timeout | undefined;
  #grace: NodeJS.Timeout | undefined;
  #closing = false;
  #hungMs: number;
  #cmdTimeoutMs: number;
  #helloTimeoutMs: number;
  #graceMs: number;

  constructor(servers: ServerConfig[], opts: HubOptions = {}) {
    super();
    for (const s of servers) {
      if (s.token.length < 16) throw new Error(`server "${s.id}": token must be at least 16 characters`);
      this.#configs.set(s.id, s);
      this.#states.set(s.id, { id: s.id, name: s.name, online: false, hung: false, tps: null, players: [] });
    }
    this.#hungMs = opts.hungMs ?? 30_000;
    this.#cmdTimeoutMs = opts.cmdTimeoutMs ?? 10_000;
    this.#helloTimeoutMs = opts.helloTimeoutMs ?? 5_000;
    this.#graceMs = opts.graceMs ?? 60_000; // longer than the mod's 30 s max reconnect backoff
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
    for (const conn of this.#conns.values()) conn.socket.destroy();
    return new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  list(): ServerState[] {
    return [...this.#states.values()].map((s) => ({ ...s, players: [...s.players] }));
  }

  get(id: string): ServerState | undefined {
    const s = this.#states.get(id);
    return s && { ...s, players: [...s.players] };
  }

  /** Broadcasts a chat line in-game. False if the server is offline or the text is empty after cleaning. */
  say(id: string, author: string, message: string): boolean {
    const conn = this.#conns.get(id);
    const text = mcText(message, 256);
    if (!conn || !text) return false;
    this.#send(conn.socket, { type: 'say', author: mcText(author, 32) || '?', message: text });
    return true;
  }

  /** Runs a console command. `by` names who asked, for the audit log. */
  runCommand(id: string, command: string, by: string): Promise<string[]> {
    const conn = this.#conns.get(id);
    if (!conn) return Promise.reject(new Error(`${this.#states.get(id)?.name ?? id} is offline`));
    const cmd = command.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().replace(/^\//, '');
    if (!cmd) return Promise.reject(new Error('empty command'));
    console.log(`[cmd] ${by} on ${id}: ${cmd}`);
    const cmdId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(cmdId);
        reject(new Error('command timed out — it may still run when the server responds'));
      }, this.#cmdTimeoutMs);
      conn.pending.set(cmdId, { resolve, reject, timer });
      this.#send(conn.socket, { type: 'cmd', id: cmdId, command: cmd });
    });
  }

  #accept(socket: Socket): void {
    let id = '';
    let conn: Conn | null = null;
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
      conn = { socket, stopping: false, lastBeat: 0, hung: false, pending: new Map() };
      const old = this.#conns.get(id);
      this.#conns.set(id, conn);
      old?.socket.destroy();
      Object.assign(this.#states.get(id)!, { online: true, hung: false });
      this.#send(socket, { type: 'welcome' });
      this.#emit(id, 'connected');
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (!conn) return;
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('server disconnected'));
      }
      conn.pending.clear();
      if (this.#conns.get(id) !== conn) return; // replaced by a newer connection: no alert
      this.#conns.delete(id);
      Object.assign(this.#states.get(id)!, { online: false, hung: false, tps: null, players: [] });
      if (!this.#closing) this.#emit(id, conn.stopping ? 'stopped' : 'crashed');
    });
  }

  #checkHello(hello: Hello): string | null {
    if (hello.protocol !== PROTOCOL_VERSION) {
      return `protocol ${hello.protocol} not supported (hub speaks ${PROTOCOL_VERSION})`;
    }
    const cfg = this.#configs.get(hello.serverId);
    if (!cfg || !tokenMatches(cfg.token, hello.token)) return 'unknown serverId or bad token';
    return null;
  }

  #handle(id: string, conn: Conn, msg: ModMsg): void {
    const state = this.#states.get(id)!;
    switch (msg.type) {
      case 'heartbeat':
        conn.lastBeat = Date.now();
        state.tps = msg.tps;
        state.players = msg.players;
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

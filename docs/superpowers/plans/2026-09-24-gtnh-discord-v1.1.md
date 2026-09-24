# GTNH Discord v1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hub-only update:
- player-skin webhook chat;
- live status in the bot's presence and channel topics;
- countdown and daily restarts;
- crash-log uploads;
- the deferred v1 hub minors.

**Architecture:** Two new hub-core modules, which the web dashboard will reuse:
- `restarts.ts`: `RestartScheduler`.
- `crashlogs.ts`: `findCrashLogs`.

The Discord frontend is split in two:
- `discord.ts`: client, events and commands.
- `format.ts`: pure text functions.

No protocol change and no mod change.

**Tech Stack:** Node 24+ (runs `.ts` directly), TypeScript 7 (typecheck only), discord.js 14, `node:sqlite`, `node:test` with mock timers.

**Spec:** `docs/superpowers/specs/2026-09-24-gtnh-discord-v1.1-design.md` (v1 spec `docs/superpowers/specs/2026-09-24-gtnh-discord-design.md` still applies)

## Global Constraints

- All work is in `hub/`. Run npm commands there. The mod and the protocol don't change.
- Hub runs with `node src/index.ts` (Node type stripping). Use erasable TypeScript only: no `enum`, `namespace` or constructor parameter properties. Relative imports end in `.ts`.
- Hub dependencies stay exactly `discord.js` (runtime), plus `typescript` and `@types/node` (dev). Everything else comes from Node built-ins.
- Hub-core modules (`servers.ts`, `restarts.ts`, `crashlogs.ts`, `db.ts`) must not import `discord.js` or `format.ts`.
- Every Discord API call is best-effort. Failures are logged and never affect the relay, the TCP server or the scheduler.
- Must pass on Node 24 (production is 24.19 on ARM64) as well as 26. The final task runs the suite on both.
- Every commit message ends with these trailer lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019KzyhKnrr3Gj8zCrcVtthm
  ```

## Review Focus

These need a real Discord server, so they're pinned by the manual checklist in Task 5 rather than unit tests:

1. **A player whose name Discord refuses as a webhook username** (contains "discord" or "clyde"). Only that player's messages fall back to bot posts. Everyone else keeps skin chat.
2. **The relay webhook deleted by an admin while the hub runs.** Chat keeps flowing as bot posts, and the hub stops retrying the dead webhook (error 10015 removes it).
3. **Bot missing Manage Channels.** Topic edits fail with one warning per text change, not a warning every minute, and nothing else breaks.
4. **Crash logs too large or refused by Discord.** The crash alert is still posted, without attachments.
5. **A daily restart while the server is offline or a manual restart is pending.** It is skipped with a log line, and the next day is still armed. This one is unit-tested in Task 3 (`a skipped daily restart…`).

---

### Task 1: Hub core hardening

**Files:**
- Modify: `hub/src/servers.ts`: add `truncate`, make `mcText` emoji-safe, track every socket for `close()`.
- Modify: `hub/src/db.ts`: `record`/`touch` never throw.
- Test: `hub/test/servers.test.ts`, `hub/test/db.test.ts`

**Interfaces:**
- Produces: `truncate(s: string, max: number): string` from `servers.ts`. Cuts to at most `max` UTF-16 units without leaving a lone high surrogate. Used by `format.ts` in Task 4.

- [ ] **Step 1: Write the failing tests**

`hub/test/servers.test.ts`, the full file (new tests at the end, and `mcText`/`truncate` added to the import):

```ts
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { mcText, ServerHub, truncate, type HubEvent, type HubOptions } from '../src/servers.ts';

const TOKEN = 'test-token-0123456';

function fakeMod(port: number) {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => {});
  const queue: unknown[] = [];
  const waiters: ((v: unknown) => void)[] = [];
  const lines = createInterface({ input: socket });
  lines.on('error', () => {});
  lines.on('line', (line) => {
    const v: unknown = JSON.parse(line);
    const w = waiters.shift();
    if (w) w(v);
    else queue.push(v);
  });
  return {
    socket,
    closed: new Promise<void>((r) => socket.on('close', () => r())),
    send: (msg: object | string) => socket.write((typeof msg === 'string' ? msg : JSON.stringify(msg)) + '\n'),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise<unknown>((r) => waiters.push(r))),
  };
}

const hello = (token = TOKEN, protocol = 1) => ({ type: 'hello', protocol, serverId: 'gtnh', token, modVersion: 'test' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(10);
  }
}

async function setup(t: TestContext, opts: HubOptions = {}) {
  const hub = new ServerHub([{ id: 'gtnh', name: 'GTNH', token: TOKEN }], opts);
  const port = await hub.listen(0);
  const events: HubEvent[] = [];
  hub.on('event', (e) => events.push(e));
  t.after(() => hub.close());
  return { hub, port, events, types: () => events.map((e) => e.type) };
}

async function online(port: number) {
  const mod = fakeMod(port);
  mod.send(hello());
  assert.deepEqual(await mod.next(), { type: 'welcome' });
  return mod;
}

test('rejects tokens shorter than 16 characters', () => {
  assert.throws(() => new ServerHub([{ id: 'x', name: 'X', token: 'short' }]), /at least 16/);
});

test('accepts a valid hello and marks the server online', async (t) => {
  const { hub, port, types } = await setup(t);
  assert.equal(hub.get('gtnh')?.online, false);
  await online(port);
  assert.deepEqual(types(), ['connected']);
  assert.equal(hub.get('gtnh')?.online, true);
  assert.equal(hub.list().length, 1);
});

test('rejects a bad token and closes', async (t) => {
  const { hub, port } = await setup(t);
  const mod = fakeMod(port);
  mod.send(hello('wrong-token-000000'));
  assert.deepEqual(await mod.next(), { type: 'reject', reason: 'unknown serverId or bad token' });
  await mod.closed;
  assert.equal(hub.get('gtnh')?.online, false);
});

test('rejects an unsupported protocol version', async (t) => {
  const { port } = await setup(t);
  const mod = fakeMod(port);
  mod.send(hello(TOKEN, 2));
  const reply = (await mod.next()) as { type: string; reason: string };
  assert.equal(reply.type, 'reject');
  assert.match(reply.reason, /protocol 2/);
  await mod.closed;
});

test('closes on a non-hello first message, or no hello in time', async (t) => {
  const { port, types } = await setup(t, { helloTimeoutMs: 100 });
  const bad = fakeMod(port);
  bad.send({ type: 'chat', player: 'a', message: 'b' });
  await bad.closed;
  await fakeMod(port).closed;
  assert.deepEqual(types(), []);
});

test('relays game messages with serverId and ignores junk after the handshake', async (t) => {
  const { port, events } = await setup(t);
  const mod = await online(port);
  mod.send('not json');
  mod.send({ type: 'constructor' });
  mod.send({ type: 'chat', player: 'Steve', message: 42 });
  mod.send({ type: 'chat', player: 'Steve', message: 'hi' });
  mod.send({ type: 'death', player: 'Steve', message: 'Steve fell from a high place' });
  await until(() => events.length === 3);
  assert.deepEqual(events.slice(1), [
    { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' },
    { serverId: 'gtnh', type: 'death', player: 'Steve', message: 'Steve fell from a high place' },
  ]);
});

test('heartbeat updates tps and players', async (t) => {
  const { hub, port } = await setup(t);
  const mod = await online(port);
  mod.send({ type: 'heartbeat', tps: 19.5, players: ['Steve', 'Alex'] });
  await until(() => hub.get('gtnh')?.tps === 19.5);
  assert.deepEqual(hub.get('gtnh')?.players, ['Steve', 'Alex']);
});

test('runCommand round-trips through the mod', async (t) => {
  const { hub, port } = await setup(t);
  const mod = await online(port);
  const result = hub.runCommand('gtnh', '/list', 'test');
  const cmd = (await mod.next()) as { type: string; id: string; command: string };
  assert.equal(cmd.type, 'cmd');
  assert.equal(cmd.command, 'list');
  mod.send({ type: 'cmdResult', id: cmd.id, output: ['There are 0/20 players online:'] });
  assert.deepEqual(await result, ['There are 0/20 players online:']);
});

test('runCommand fails fast offline, times out, ignores late results, and fails on disconnect', async (t) => {
  const { hub, port } = await setup(t, { cmdTimeoutMs: 100 });
  await assert.rejects(hub.runCommand('gtnh', 'list', 'test'), /GTNH is offline/);
  const mod = await online(port);
  await assert.rejects(hub.runCommand('gtnh', ' / ', 'test'), /empty command/);
  const timedOut = hub.runCommand('gtnh', 'list', 'test');
  const cmd = (await mod.next()) as { id: string };
  await assert.rejects(timedOut, /timed out — it may still run when the server responds/);
  mod.send({ type: 'cmdResult', id: cmd.id, output: ['late'] }); // must be ignored
  const dropped = hub.runCommand('gtnh', 'list', 'test');
  await mod.next();
  mod.socket.destroy();
  await assert.rejects(dropped, /disconnected/);
});

test('stopping then disconnect is a clean stop; a bare disconnect is a crash', async (t) => {
  const { hub, port, types } = await setup(t);
  const a = await online(port);
  a.send({ type: 'started' });
  a.send({ type: 'stopping' });
  a.socket.end();
  await until(() => types().includes('stopped'));
  assert.equal(hub.get('gtnh')?.online, false);
  const b = await online(port);
  b.socket.destroy();
  await until(() => types().includes('crashed'));
  assert.deepEqual(types(), ['connected', 'started', 'stopped', 'connected', 'crashed']);
});

test('hung detection arms on the first heartbeat, recovers, and is off after stopping', async (t) => {
  const { hub, port, types } = await setup(t, { hungMs: 100 });
  const mod = await online(port);
  await sleep(250);
  assert.deepEqual(types(), ['connected']); // no heartbeat yet: world still loading
  mod.send({ type: 'heartbeat', tps: 20, players: [] });
  await until(() => types().includes('hung'));
  assert.equal(hub.get('gtnh')?.hung, true);
  mod.send({ type: 'heartbeat', tps: 20, players: [] });
  await until(() => types().includes('recovered'));
  assert.equal(hub.get('gtnh')?.hung, false);
  mod.send({ type: 'stopping' });
  await sleep(250);
  assert.deepEqual(types(), ['connected', 'hung', 'recovered']);
});

test('a reconnect replaces the old connection without a crash alert', async (t) => {
  const { hub, port, types } = await setup(t);
  const first = await online(port);
  await online(port);
  await first.closed;
  await sleep(50);
  assert.deepEqual(types(), ['connected', 'connected']);
  assert.equal(hub.get('gtnh')?.online, true);
});

test('say cleans text and skips empty messages', async (t) => {
  const { hub, port } = await setup(t);
  assert.equal(hub.say('gtnh', 'Bob', 'hi'), false); // offline
  const mod = await online(port);
  assert.equal(hub.say('gtnh', 'Bob', '§c§l'), false);
  assert.equal(hub.say('gtnh', 'B§4ob\n', 'line1\nline2 §kx' + 'y'.repeat(300)), true);
  const say = (await mod.next()) as { type: string; author: string; message: string };
  assert.equal(say.type, 'say');
  assert.equal(say.author, 'Bob');
  assert.equal(say.message.length, 256);
  assert.ok(say.message.startsWith('line1 line2 xyyy'));
});

test('a mod cannot claim another serverId in its messages', async (t) => {
  const { port, events } = await setup(t);
  const mod = await online(port);
  mod.send({ type: 'chat', player: 'Steve', message: 'hi', serverId: 'other' });
  await until(() => events.length === 2);
  assert.equal(events[1].serverId, 'gtnh');
});

test('servers that do not connect within the grace period are reported offline', async (t) => {
  const hub = new ServerHub(
    [
      { id: 'gtnh', name: 'GTNH', token: TOKEN },
      { id: 'idle', name: 'Idle', token: TOKEN },
    ],
    { graceMs: 150 },
  );
  const events: HubEvent[] = [];
  hub.on('event', (e) => events.push(e));
  t.after(() => hub.close());
  const port = await hub.listen(0);
  await online(port);
  await sleep(300);
  assert.deepEqual(events, [
    { serverId: 'gtnh', type: 'connected' },
    { serverId: 'idle', type: 'offline' },
  ]);
});

test('truncate never leaves half an emoji', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 3), 'abc');
  assert.equal(truncate('ab😀', 3), 'ab'); // cutting at 3 would split the surrogate pair
  assert.equal(truncate('ab😀', 4), 'ab😀');
  assert.equal(mcText('a'.repeat(255) + '😀', 256), 'a'.repeat(255));
});

test('close() does not wait for connections that never sent hello', async () => {
  const hub = new ServerHub([{ id: 'gtnh', name: 'GTNH', token: TOKEN }]);
  const port = await hub.listen(0);
  const idle = fakeMod(port);
  await sleep(50);
  const start = Date.now();
  await hub.close();
  assert.ok(Date.now() - start < 1000, `close took ${Date.now() - start} ms`);
  await idle.closed;
});
```

`hub/test/db.test.ts`, the full file (new test at the end):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeUptime, Db } from '../src/db.ts';

test('computeUptime splits time between states', () => {
  const rows = [
    { ts: 0, state: 'up' as const },
    { ts: 50, state: 'down' as const },
  ];
  assert.equal(computeUptime(rows, 0, 100), 0.5);
});

test('computeUptime excludes unknown time and clips to the window', () => {
  const rows = [
    { ts: 0, state: 'up' as const },
    { ts: 50, state: 'unknown' as const },
    { ts: 75, state: 'up' as const },
  ];
  assert.equal(computeUptime(rows, 0, 100), 1);
  assert.equal(computeUptime([{ ts: 0, state: 'down' as const }], 10, 20), 0);
});

test('computeUptime is null with no known time', () => {
  assert.equal(computeUptime([], 0, 100), null);
  assert.equal(computeUptime([{ ts: 0, state: 'unknown' as const }], 0, 100), null);
});

test('uptime carries the state from before the window', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 1000);
  db.record('s', 'down', 'crashed', 2000);
  assert.equal(db.uptime('s', 0, 3000), 0.5);
  assert.equal(db.uptime('s', 1500, 3000), 1 / 3);
  assert.equal(db.uptime('other', 0, 3000), null);
  db.close();
});

test('markHubRestart makes hub downtime unknown', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 500);
  db.touch(1000);
  db.markHubRestart(['s'], 5000);
  assert.equal(db.uptime('s', 0, 6000), 1);
  db.close();
});

test('an event after the last touch still counts as hub-alive time', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 500);
  db.touch(1000);
  db.record('s', 'down', 'stopped', 1030); // e.g. machine reboot: hub dies before its next touch
  db.markHubRestart(['s'], 5000);
  assert.equal(db.uptime('s', 1030, 5000), null); // the outage is unknown, not downtime
  db.close();
});

test('record and touch never throw, even when the database is unusable', () => {
  const db = new Db(':memory:');
  db.close();
  assert.doesNotThrow(() => db.record('s', 'up', 'connected', 1000));
  assert.doesNotThrow(() => db.touch(1000));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd hub && npm test`
Expected: FAIL. `servers.test.ts` errors with `does not provide an export named 'truncate'`, and `db.test.ts` fails `record and touch never throw` with `database is not open`.

- [ ] **Step 3: Implement**

`hub/src/servers.ts`:

```ts
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
    for (const socket of this.#sockets) socket.destroy();
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
      conn = { socket, stopping: false, lastBeat: 0, hung: false, pending: new Map() };
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
```

`hub/src/db.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';

export type State = 'up' | 'down' | 'unknown';
export type Row = { ts: number; state: State };

/** Fraction of known (up + down) time in [from, to] that the server was up; null if none was known. */
export function computeUptime(rows: Row[], from: number, to: number): number | null {
  let up = 0;
  let known = 0;
  for (let i = 0; i < rows.length; i++) {
    const start = Math.max(rows[i].ts, from);
    const end = Math.min(rows[i + 1]?.ts ?? to, to);
    if (end <= start || rows[i].state === 'unknown') continue;
    known += end - start;
    if (rows[i].state === 'up') up += end - start;
  }
  return known === 0 ? null : up / known;
}

/** SQLite log of server up/down transitions. */
export class Db {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (server_id TEXT NOT NULL, ts INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_server_ts ON events (server_id, ts);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
  }

  /** Never throws: a database error (disk full, locked) is logged instead of taking the hub down. */
  record(serverId: string, state: State, reason: string, ts = Date.now()): void {
    try {
      this.#db
        .prepare('INSERT INTO events (server_id, ts, state, reason) VALUES (?, ?, ?, ?)')
        .run(serverId, ts, state, reason);
    } catch (err) {
      console.error('[db] record failed:', (err as Error).message);
    }
    this.touch(ts); // the hub was alive at least until this event
  }

  /** Stamps the hub as alive. Call every minute. Never throws, like record(). */
  touch(ts = Date.now()): void {
    try {
      this.#db
        .prepare("INSERT INTO meta (key, value) VALUES ('last_alive', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(ts);
    } catch (err) {
      console.error('[db] touch failed:', (err as Error).message);
    }
  }

  /** Call once at hub startup: the time since the last touch is unknown for every server. */
  markHubRestart(serverIds: string[], now = Date.now()): void {
    const last = this.#db.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get() as
      | { value: number }
      | undefined;
    for (const id of serverIds) {
      if (last) this.record(id, 'unknown', 'hub down', last.value);
      this.record(id, 'unknown', 'hub start', now);
    }
    this.touch(now);
  }

  uptime(serverId: string, from: number, to = Date.now()): number | null {
    const before = this.#db
      .prepare('SELECT state FROM events WHERE server_id = ? AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT 1')
      .get(serverId, from) as { state: State } | undefined;
    const rows = this.#db
      .prepare('SELECT ts, state FROM events WHERE server_id = ? AND ts > ? AND ts <= ? ORDER BY ts, rowid')
      .all(serverId, from, to) as Row[];
    return computeUptime(before ? [{ ts: from, state: before.state }, ...rows] : rows, from, to);
  }

  close(): void {
    this.#db.close();
  }
}
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 33`, `ℹ fail 0`, and `tsc` prints nothing. `[db] … failed` and `[cmd] …` log lines are expected.

- [ ] **Step 5: Commit**

```bash
git add hub/src/servers.ts hub/src/db.ts hub/test/servers.test.ts hub/test/db.test.ts
git commit -m "fix(hub): emoji-safe truncation, instant close(), db writes never throw"
```

---

### Task 2: Crash-log finder

**Files:**
- Create: `hub/src/crashlogs.ts`
- Test: `hub/test/crashlogs.test.ts`

**Interfaces:**
- Produces: `findCrashLogs(serverDir: string, sinceMs: number): Promise<string[]>`. Returns 0–2 paths (the newest `crash-reports/*.txt`, then the newest `hs_err_pid*.log`), each written at or after `sinceMs` and at most 8 MB. Never throws.

- [ ] **Step 1: Write the failing test**

`hub/test/crashlogs.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findCrashLogs } from '../src/crashlogs.ts';

async function file(path: string, mtimeSec: number, bytes = 10): Promise<void> {
  await writeFile(path, 'x'.repeat(bytes));
  await utimes(path, mtimeSec, mtimeSec);
}

test('finds the newest crash report and JVM log written since the cutoff', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crashlogs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'crash-reports'));
  await file(join(dir, 'crash-reports', 'crash-old-server.txt'), 1000);
  await file(join(dir, 'crash-reports', 'crash-new-server.txt'), 3000);
  await file(join(dir, 'crash-reports', 'notes.md'), 4000); // wrong extension
  await file(join(dir, 'hs_err_pid111.log'), 1000);
  await file(join(dir, 'hs_err_pid222.log'), 3500);
  await file(join(dir, 'hs_err_pid333.txt'), 4000); // wrong name
  assert.deepEqual(await findCrashLogs(dir, 2000 * 1000), [
    join(dir, 'crash-reports', 'crash-new-server.txt'),
    join(dir, 'hs_err_pid222.log'),
  ]);
});

test('ignores files older than the cutoff or too big to upload', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crashlogs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'crash-reports'));
  await file(join(dir, 'crash-reports', 'crash-old.txt'), 1000);
  await file(join(dir, 'hs_err_pid1.log'), 5000, 9 * 1024 * 1024);
  assert.deepEqual(await findCrashLogs(dir, 2000 * 1000), []);
});

test('a missing folder yields no files instead of an error', async () => {
  assert.deepEqual(await findCrashLogs(join(tmpdir(), 'does-not-exist-' + Date.now()), 0), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd hub && npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/crashlogs.ts`.

- [ ] **Step 3: Implement**

`hub/src/crashlogs.ts`:

```ts
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Discord's upload limit is 10 MB; stay under it. */
const MAX_BYTES = 8 * 1024 * 1024;

async function newest(dir: string, match: (name: string) => boolean, sinceMs: number): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null; // no such folder (e.g. no crash has ever happened)
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!match(name)) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (!st.isFile() || st.size > MAX_BYTES || st.mtimeMs < sinceMs) continue;
      if (!best || st.mtimeMs > best.mtime) best = { path, mtime: st.mtimeMs };
    } catch {
      // deleted between readdir and stat
    }
  }
  return best?.path ?? null;
}

/**
 * The newest Minecraft crash report and the newest JVM crash log (hs_err_pid*.log) in a server folder,
 * each only if written at or after `sinceMs` and small enough to upload. Returns 0–2 paths; never throws.
 */
export async function findCrashLogs(serverDir: string, sinceMs: number): Promise<string[]> {
  const found = await Promise.all([
    newest(join(serverDir, 'crash-reports'), (n) => n.endsWith('.txt'), sinceMs),
    newest(serverDir, (n) => /^hs_err_pid\d+\.log$/.test(n), sinceMs),
  ]);
  return found.filter((p): p is string => p !== null);
}
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 36`, `ℹ fail 0`, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add hub/src/crashlogs.ts hub/test/crashlogs.test.ts
git commit -m "feat(hub): find crash reports and JVM crash logs for upload"
```

---

### Task 3: Restart scheduler

**Files:**
- Create: `hub/src/restarts.ts`
- Test: `hub/test/restarts.test.ts`

**Interfaces:**
- Consumes: `ServerHub` type (`runCommand`, `on`, `get`) from `servers.ts`.
- Produces:
  - `new RestartScheduler(hub: Pick<ServerHub, 'runCommand' | 'on' | 'get'>, notify: (serverId, text) => void)`
  - `.schedule(serverId, minutes, by)`: throws on bad minutes, an offline server, or one already pending
  - `.cancel(serverId, by): boolean`
  - `.pending(serverId)`
  - `.daily(serverId, "HH:MM")`: throws on a bad time
  - `.stop()`
  - helpers `countdownText`, `parseDaily`, `nextDaily`

- [ ] **Step 1: Write the failing test**

`hub/test/restarts.test.ts`. It pins `process.env.TZ` so the daily and DST assertions are machine-independent:

```ts
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { nextDaily, parseDaily, RestartScheduler } from '../src/restarts.ts';
import type { HubEvent, ServerHub, ServerState } from '../src/servers.ts';

process.env.TZ = 'Europe/London'; // daily-restart assertions are in UK local time, across a DST change

const MIN = 60_000;
const flush = () => new Promise((r) => setImmediate(r)); // setImmediate isn't mocked: lets rejections settle

function setup(t: TestContext, now = Date.UTC(2026, 8, 24, 12, 0)) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const events = new EventEmitter<{ event: [HubEvent] }>();
  const commands: string[] = [];
  const notices: string[] = [];
  const state = { online: true, stopError: null as Error | null };
  const hub = {
    on: (name: 'event', fn: (e: HubEvent) => void) => events.on(name, fn),
    get: (id: string) => (state.online ? ({ id, online: true } as ServerState) : undefined),
    runCommand: async (_id: string, command: string) => {
      commands.push(command);
      if (command === 'stop' && state.stopError) throw state.stopError;
      return [];
    },
  } as unknown as Pick<ServerHub, 'runCommand' | 'on' | 'get'>;
  const restarts = new RestartScheduler(hub, (_id, text) => notices.push(text));
  t.after(() => restarts.stop());
  return { restarts, events, commands, notices, state };
}

test('a 10 minute restart warns at 10m, 5m, 1m, 30s and 10s, then stops', (t) => {
  const { restarts, commands, notices } = setup(t);
  restarts.schedule('gtnh', 10, 'alice');
  t.mock.timers.tick(0);
  assert.deepEqual(commands, ['say Server restarting in 10 minutes']);
  assert.equal(restarts.pending('gtnh')?.by, 'alice');
  t.mock.timers.tick(10 * MIN);
  assert.deepEqual(commands, [
    'say Server restarting in 10 minutes',
    'say Server restarting in 5 minutes',
    'say Server restarting in 1 minute',
    'say Server restarting in 30 seconds',
    'say Server restarting in 10 seconds',
    'stop',
  ]);
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by alice)', '🔄 Restarting now']);
  assert.equal(restarts.pending('gtnh'), undefined);
});

test('shorter countdowns only use the warnings that fit; 0 stops straight away', (t) => {
  const { restarts, commands, notices } = setup(t);
  restarts.schedule('gtnh', 2, 'alice');
  t.mock.timers.tick(2 * MIN);
  assert.deepEqual(commands, [
    'say Server restarting in 1 minute',
    'say Server restarting in 30 seconds',
    'say Server restarting in 10 seconds',
    'stop',
  ]);
  commands.length = notices.length = 0;
  restarts.schedule('gtnh', 0, 'bob');
  t.mock.timers.tick(0);
  assert.deepEqual(commands, ['stop']);
  assert.deepEqual(notices, ['🔄 Restarting now']);
});

test('rejects bad minutes, an offline server, and a second pending restart', (t) => {
  const { restarts, state } = setup(t);
  assert.throws(() => restarts.schedule('gtnh', 61, 'a'), /0 to 60/);
  assert.throws(() => restarts.schedule('gtnh', 1.5, 'a'), /whole number/);
  restarts.schedule('gtnh', 5, 'a');
  assert.throws(() => restarts.schedule('gtnh', 5, 'a'), /already scheduled/);
  state.online = false;
  assert.throws(() => restarts.schedule('other', 5, 'a'), /offline/);
});

test('cancel stops the countdown and tells players', (t) => {
  const { restarts, commands, notices } = setup(t);
  restarts.schedule('gtnh', 5, 'alice');
  assert.equal(restarts.cancel('gtnh', 'bob'), true);
  assert.equal(restarts.cancel('gtnh', 'bob'), false);
  t.mock.timers.tick(10 * MIN);
  assert.deepEqual(commands, ['say Restart cancelled']);
  assert.deepEqual(notices, ['🔄 Restart in 5 minutes (by alice)', '❎ Restart cancelled (by bob)']);
});

test('the server going down first cancels; its own stop does not', (t) => {
  const { restarts, events, commands, notices } = setup(t);
  restarts.schedule('gtnh', 5, 'alice');
  events.emit('event', { serverId: 'gtnh', type: 'crashed' });
  t.mock.timers.tick(10 * MIN);
  assert.ok(!commands.includes('stop'));
  assert.equal(notices.at(-1), '❎ Restart cancelled (server went down)');
  notices.length = 0;
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  events.emit('event', { serverId: 'gtnh', type: 'stopped' }); // caused by our own stop
  assert.deepEqual(notices, ['🔄 Restarting now']);
});

test('stop failing with a disconnect is success; a timeout is reported', async (t) => {
  const { restarts, notices, state } = setup(t);
  state.stopError = new Error('server disconnected');
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(notices, ['🔄 Restarting now']);
  state.stopError = new Error('command timed out — it may still run when the server responds');
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  await flush();
  assert.equal(notices.at(-1), '❌ Restart failed: command timed out — it may still run when the server responds');
});

test('parseDaily accepts only 24-hour HH:MM', () => {
  assert.deepEqual(parseDaily('06:00'), { h: 6, m: 0 });
  assert.deepEqual(parseDaily('23:59'), { h: 23, m: 59 });
  for (const bad of ['6:00', '24:00', '06:60', '6am', '']) assert.equal(parseDaily(bad), null, bad);
});

test('daily() rejects a bad time', (t) => {
  const { restarts } = setup(t);
  assert.throws(() => restarts.daily('gtnh', '6am'), /dailyRestart must be HH:MM/);
});

test('nextDaily follows the local clock across the October DST change', () => {
  // 24 Oct 2026 06:00 BST (05:00 UTC). Clocks go back at 02:00 on 25 Oct.
  const now = Date.UTC(2026, 9, 24, 5, 0);
  const next = nextDaily({ h: 6, m: 0 }, 10 * MIN, now);
  assert.equal(new Date(next).toISOString(), '2026-10-25T05:50:00.000Z'); // 05:50 GMT, 25 h later
});

test('daily restart counts down from 10 minutes before the time, every day', (t) => {
  // 24 Oct 2026 05:00 BST.
  const { restarts, commands, notices } = setup(t, Date.UTC(2026, 9, 24, 4, 0));
  restarts.daily('gtnh', '06:00');
  t.mock.timers.tick(49 * MIN);
  assert.deepEqual(notices, []);
  t.mock.timers.tick(1 * MIN); // 05:50 BST
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
  t.mock.timers.tick(10 * MIN); // 06:00 BST
  assert.equal(commands.at(-1), 'stop');
  notices.length = 0;
  t.mock.timers.tick(24 * 60 * MIN - 10 * MIN); // 05:50 GMT would be 25 h later, not 24 h
  assert.deepEqual(notices, []);
  t.mock.timers.tick(60 * MIN);
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
});

test('a skipped daily restart (server offline) still arms the next day', (t) => {
  // 24 Sep 2026 05:00 BST: no DST change in the next two days.
  const { restarts, notices, state } = setup(t, Date.UTC(2026, 8, 24, 4, 0));
  restarts.daily('gtnh', '06:00');
  state.online = false;
  t.mock.timers.tick(50 * MIN); // 05:50: skipped, logged
  assert.deepEqual(notices, []);
  state.online = true;
  t.mock.timers.tick(24 * 60 * MIN); // next day 05:50
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd hub && npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/restarts.ts`.

- [ ] **Step 3: Implement**

`hub/src/restarts.ts`:

```ts
import type { ServerHub } from './servers.ts';

type Hub = Pick<ServerHub, 'runCommand' | 'on' | 'get'>;
type Pending = { at: number; by: string; timers: NodeJS.Timeout[] };

/** In-game warnings, as time left before the restart. */
const WARNINGS_MS = [600_000, 300_000, 60_000, 30_000, 10_000];
/** A daily restart starts its countdown this long before the configured time. */
const DAILY_LEAD_MS = 10 * 60_000;

export function countdownText(ms: number): string {
  if (ms >= 60_000) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`;
  return `${ms / 1000} seconds`;
}

/** Parses a 24-hour "HH:MM"; null if invalid. */
export function parseDaily(time: string): { h: number; m: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? { h: Number(match[1]), m: Number(match[2]) } : null;
}

/**
 * The next moment, strictly after `now`, that is `leadMs` before local time h:m. Recomputed from the local
 * clock every time (never "+24 h"), so a DST change doesn't shift the restart by an hour.
 */
export function nextDaily(time: { h: number; m: number }, leadMs: number, now: number): number {
  const d = new Date(now);
  d.setHours(time.h, time.m, 0, 0);
  while (d.getTime() - leadMs <= now) d.setDate(d.getDate() + 1);
  return d.getTime() - leadMs;
}

/**
 * Countdown restarts: in-game warnings, then `stop` (systemd's Restart=always brings the server back).
 * Lives in the hub core so the web dashboard can use it too. Pending restarts are in memory only.
 */
export class RestartScheduler {
  #hub: Hub;
  #notify: (serverId: string, text: string) => void;
  #pending = new Map<string, Pending>();
  #daily = new Map<string, NodeJS.Timeout>();

  constructor(hub: Hub, notify: (serverId: string, text: string) => void) {
    this.#hub = hub;
    this.#notify = notify;
    hub.on('event', (e) => {
      if ((e.type === 'stopped' || e.type === 'crashed') && this.#clear(e.serverId)) {
        this.#notify(e.serverId, '❎ Restart cancelled (server went down)');
      }
    });
  }

  /** Throws if minutes isn't a whole number 0–60, the server is offline, or a restart is already pending. */
  schedule(serverId: string, minutes: number, by: string): void {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) {
      throw new Error('minutes must be a whole number from 0 to 60');
    }
    if (!this.#hub.get(serverId)?.online) throw new Error(`${serverId} is offline`);
    if (this.#pending.has(serverId)) throw new Error('a restart is already scheduled (use /restart cancel first)');
    const delay = minutes * 60_000;
    const timers = WARNINGS_MS.filter((w) => w <= delay).map((w) => setTimeout(() => this.#warn(serverId, w), delay - w));
    timers.push(setTimeout(() => this.#fire(serverId), delay));
    this.#pending.set(serverId, { at: Date.now() + delay, by, timers });
    if (delay) this.#notify(serverId, `🔄 Restart in ${countdownText(delay)} (by ${by})`);
  }

  /** False if nothing was pending. */
  cancel(serverId: string, by: string): boolean {
    if (!this.#clear(serverId)) return false;
    this.#notify(serverId, `❎ Restart cancelled (by ${by})`);
    this.#say(serverId, 'say Restart cancelled');
    return true;
  }

  pending(serverId: string): { at: number; by: string } | undefined {
    const p = this.#pending.get(serverId);
    return p && { at: p.at, by: p.by };
  }

  /** Arms a daily restart at local "HH:MM" (countdown starts 10 minutes before). Throws on a bad time. */
  daily(serverId: string, time: string): void {
    const hm = parseDaily(time);
    if (!hm) throw new Error(`server "${serverId}": dailyRestart must be HH:MM (24-hour), got "${time}"`);
    const arm = () => {
      const delay = nextDaily(hm, DAILY_LEAD_MS, Date.now()) - Date.now();
      this.#daily.set(
        serverId,
        setTimeout(() => {
          try {
            this.schedule(serverId, DAILY_LEAD_MS / 60_000, 'daily');
          } catch (err) {
            console.error(`[restart] daily restart of ${serverId} skipped: ${(err as Error).message}`);
          }
          arm();
        }, delay),
      );
    };
    arm();
  }

  /** Clears every timer (hub shutdown). */
  stop(): void {
    for (const id of [...this.#pending.keys()]) this.#clear(id);
    for (const timer of this.#daily.values()) clearTimeout(timer);
    this.#daily.clear();
  }

  #clear(serverId: string): boolean {
    const p = this.#pending.get(serverId);
    if (!p) return false;
    for (const timer of p.timers) clearTimeout(timer);
    this.#pending.delete(serverId);
    return true;
  }

  #say(serverId: string, command: string): void {
    this.#hub
      .runCommand(serverId, command, 'restart')
      .catch((err: Error) => console.error(`[restart] "${command}" on ${serverId} failed: ${err.message}`));
  }

  #warn(serverId: string, msLeft: number): void {
    this.#say(serverId, `say Server restarting in ${countdownText(msLeft)}`);
  }

  #fire(serverId: string): void {
    const p = this.#pending.get(serverId);
    if (!p) return;
    this.#clear(serverId); // first, so the `stopped` event this causes isn't reported as a cancellation
    this.#notify(serverId, '🔄 Restarting now');
    this.#hub.runCommand(serverId, 'stop', p.by).catch((err: Error) => {
      if (err.message === 'server disconnected') return; // it shut down before replying: that's success
      console.error(`[restart] stop on ${serverId} failed: ${err.message}`);
      this.#notify(serverId, `❌ Restart failed: ${err.message}`);
    });
  }
}
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 47`, `ℹ fail 0`, and `tsc` prints nothing. `[restart] … skipped` and `[restart] stop … failed` log lines are expected.

- [ ] **Step 5: Commit**

```bash
git add hub/src/restarts.ts hub/test/restarts.test.ts
git commit -m "feat(hub): countdown and daily restarts (DST-safe)"
```

---

### Task 4: Discord frontend v1.1 and wiring

**Files:**
- Create: `hub/src/format.ts`, holding the pure text functions (moved out of `discord.ts`) plus `formatPresence`, `formatTopic` and `topicDue`.
- Modify (rewrite): `hub/src/discord.ts` for:
  - webhook chat;
  - presence and topics;
  - crash uploads;
  - `/restart`;
  - hidden admin commands;
  - `shouldRelay`;
  - returning `{ client, post }`.
- Modify: `hub/src/index.ts` (scheduler wiring, `dir`/`dailyRestart`) and `hub/config.example.json`.
- Test: `git mv hub/test/discord.test.ts hub/test/format.test.ts` (the formatter tests move with their code), then a new `hub/test/discord.test.ts`.

**Interfaces:**
- Consumes: `truncate`, `stripCodes`, `HubEvent`, `ServerState`, `ServerHub` (Task 1 / v1); `findCrashLogs` (Task 2); `RestartScheduler` (Task 3).
- Produces:
  - `startDiscord(hub, db, restarts, cfg: DiscordConfig, token): Promise<{ client, post(serverId, text) }>`, where `DiscordConfig` gains `dirs: Record<serverId, string>`;
  - `COMMANDS`;
  - `shouldRelay(m)`.

- [ ] **Step 1: Move and write the failing tests**

```bash
git mv hub/test/discord.test.ts hub/test/format.test.ts
```

`hub/test/format.test.ts`, the full file (the moved tests now import from `../src/format.ts`, and the new ones are at the end):

````ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatEvent,
  formatOutput,
  formatPlayers,
  formatPresence,
  formatStatus,
  formatTopic,
  TOPIC_MIN_GAP_MS,
  topicDue,
} from '../src/format.ts';
import type { ServerState } from '../src/servers.ts';

test('formatEvent escapes markdown, links and § codes', () => {
  assert.equal(
    formatEvent({ serverId: 's', type: 'chat', player: 'x_y_z', message: '**hi** [a](http://x) §cred' }),
    '**x\\_y\\_z**: \\*\\*hi\\*\\* \\[a](http://x) red',
  );
  assert.equal(formatEvent({ serverId: 's', type: 'chat', player: 'a', message: '# big' }), '**a**: \\# big');
  assert.equal(
    formatEvent({ serverId: 's', type: 'death', player: 'Steve', message: 'Steve fell from a high place' }),
    '💀 Steve fell from a high place',
  );
  assert.equal(
    formatEvent({ serverId: 's', type: 'achievement', player: 'Steve', achievement: 'Taking Inventory' }),
    '🏆 **Steve** earned **Taking Inventory**',
  );
});

test('formatEvent announces lifecycle but not reconnects', () => {
  assert.equal(formatEvent({ serverId: 's', type: 'connected' }), null);
  assert.equal(formatEvent({ serverId: 's', type: 'offline' }), null);
  assert.equal(formatEvent({ serverId: 's', type: 'crashed' }), '💥 Server went down unexpectedly');
  assert.equal(formatEvent({ serverId: 's', type: 'started' }), '✅ Server started');
});

test('formatOutput always yields one valid code block under 2000 chars', () => {
  assert.equal(formatOutput([]), '```\n(no output)\n```');
  assert.equal(formatOutput(['§aGreen', 'b']), '```\nGreen\nb\n```');
  const sneaky = formatOutput(['```', '@everyone']);
  assert.equal(sneaky, "```\n'''\n@everyone\n```");
  const long = formatOutput(['x'.repeat(5000)]);
  assert.ok(long.length < 2000);
  assert.ok(long.endsWith('… (truncated)\n```'));
});

test('formatStatus covers online, hung and offline', () => {
  const base: ServerState = { id: 's', name: 'GTNH', online: true, hung: false, tps: 19.96, players: ['a', 'b'] };
  assert.equal(formatStatus(base, 1, 0.5), '**GTNH** — 🟢 Online\nTPS: 20.0 · Players: 2\nUptime: 24h 100.0% · 7d 50.0%');
  assert.match(formatStatus({ ...base, hung: true }, null, null), /🟠 Not responding[\s\S]*24h n\/a/);
  assert.equal(formatStatus({ ...base, online: false, tps: null, players: [] }, 0, 0), '**GTNH** — 🔴 Offline\nUptime: 24h 0.0% · 7d 0.0%');
});

test('formatPlayers lists escaped names', () => {
  assert.equal(formatPlayers([]), 'Nobody online.');
  assert.equal(formatPlayers(['Steve', 'a_b']), 'Online (2): Steve, a\\_b');
});

test('formatOutput truncates long emoji output without splitting an emoji', () => {
  const out = formatOutput(['😀'.repeat(2000)]);
  assert.ok(out.length <= 2000, `length ${out.length}`);
  assert.ok(out.endsWith('😀\n… (truncated)\n```'));
});

const online: ServerState = { id: 'gtnh', name: 'GTNH', online: true, hung: false, tps: 19.7, players: ['Steve', 'Alex'] };

test('formatPresence has one segment per server', () => {
  assert.equal(formatPresence([online]), 'GTNH: 2 online · 20 TPS');
  assert.equal(
    formatPresence([online, { ...online, id: 'sky', name: 'Sky', online: false, tps: null, players: [] }, { ...online, id: 'x', name: 'X', hung: true }]),
    'GTNH: 2 online · 20 TPS | Sky: offline | X: not responding',
  );
  assert.equal(formatPresence([{ ...online, tps: null }]), 'GTNH: 2 online');
  assert.ok(formatPresence(Array(20).fill(online)).length <= 128);
});

test('formatTopic shows state, TPS and players within 1024 chars', () => {
  assert.equal(formatTopic(online), '🟢 Online · 20 TPS · 2 players: Steve, Alex');
  assert.equal(formatTopic({ ...online, players: ['Steve'] }), '🟢 Online · 20 TPS · 1 player: Steve');
  assert.equal(formatTopic({ ...online, players: [] }), '🟢 Online · 20 TPS · 0 players');
  assert.equal(formatTopic({ ...online, hung: true }), '🟠 Not responding');
  assert.equal(formatTopic({ ...online, online: false }), '🔴 Offline');
  assert.ok(formatTopic({ ...online, players: Array(200).fill('SomeLongPlayerName') }).length <= 1024);
});

test('topicDue edits on first sight, then only on change and after the minimum gap', () => {
  assert.equal(topicDue(undefined, 'a', 0), true);
  const last = { text: 'a', at: 1000 };
  assert.equal(topicDue(last, 'a', 1000 + TOPIC_MIN_GAP_MS), false); // unchanged
  assert.equal(topicDue(last, 'b', 1000 + TOPIC_MIN_GAP_MS - 1), false); // too soon
  assert.equal(topicDue(last, 'b', 1000 + TOPIC_MIN_GAP_MS), true);
});
````

`hub/test/discord.test.ts` (new):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from 'discord.js';
import { COMMANDS, shouldRelay } from '../src/discord.ts';

const msg = (over: { bot?: boolean; webhookId?: string | null; system?: boolean }) =>
  ({ author: { bot: over.bot ?? false }, webhookId: over.webhookId ?? null, system: over.system ?? false }) as unknown as Message;

test('shouldRelay passes people only', () => {
  assert.equal(shouldRelay(msg({})), true);
  assert.equal(shouldRelay(msg({ bot: true })), false);
  assert.equal(shouldRelay(msg({ webhookId: '123' })), false); // includes our own relay webhook: no echo loop
  assert.equal(shouldRelay(msg({ system: true })), false); // "thread created", pins, joins
});

test('admin commands are hidden by default; public ones are not', () => {
  const perms = Object.fromEntries(COMMANDS.map((c) => [c.name, c.default_member_permissions]));
  assert.equal(perms.cmd, '0');
  assert.equal(perms.restart, '0');
  assert.ok(!perms.status);
  assert.ok(!perms.list);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd hub && npm test`
Expected: FAIL. `format.test.ts` fails with `ERR_MODULE_NOT_FOUND` for `src/format.ts`, and `discord.test.ts` with `does not provide an export named 'COMMANDS'` (or `shouldRelay`).

- [ ] **Step 3: Implement the formatters**

`hub/src/format.ts`:

````ts
import { escapeMarkdown } from 'discord.js';
import { stripCodes, truncate, type HubEvent, type ServerState } from './servers.ts';

/** Escapes Minecraft text for Discord: no § codes, no markdown, headings, lists or masked links. */
export function md(s: string): string {
  return escapeMarkdown(stripCodes(s), { heading: true, maskedLink: true, bulletedList: true, numberedList: true });
}

/** The Discord post for a hub event, or null for events that aren't announced. */
export function formatEvent(e: HubEvent): string | null {
  switch (e.type) {
    case 'chat':
      return `**${md(e.player)}**: ${md(e.message)}`;
    case 'join':
      return `➡️ **${md(e.player)}** joined`;
    case 'leave':
      return `⬅️ **${md(e.player)}** left`;
    case 'death':
      return `💀 ${md(e.message)}`;
    case 'achievement':
      return `🏆 **${md(e.player)}** earned **${md(e.achievement)}**`;
    case 'started':
      return '✅ Server started';
    case 'stopped':
      return '🛑 Server stopped';
    case 'crashed':
      return '💥 Server went down unexpectedly';
    case 'hung':
      return '⚠️ Server not responding';
    case 'recovered':
      return '✅ Server responding again';
    case 'connected': // may just be a reconnect after a hub restart
    case 'offline': // hub-start bookkeeping for uptime, not news
      return null;
  }
}

export function formatStatus(s: ServerState, day: number | null, week: number | null): string {
  const pct = (u: number | null) => (u === null ? 'n/a' : `${(u * 100).toFixed(1)}%`);
  const status = !s.online ? '🔴 Offline' : s.hung ? '🟠 Not responding' : '🟢 Online';
  const lines = [`**${md(s.name)}** — ${status}`];
  if (s.online) lines.push(`TPS: ${s.tps === null ? 'n/a' : s.tps.toFixed(1)} · Players: ${s.players.length}`);
  lines.push(`Uptime: 24h ${pct(day)} · 7d ${pct(week)}`);
  return lines.join('\n');
}

export function formatPlayers(players: string[]): string {
  return players.length ? `Online (${players.length}): ${players.map(md).join(', ')}` : 'Nobody online.';
}

/** Command output as a code block that always fits in one Discord message. */
export function formatOutput(lines: string[]): string {
  const max = 1900;
  let text = stripCodes(lines.join('\n')).replaceAll('```', "'''") || '(no output)';
  if (text.length > max) text = truncate(text, max) + '\n… (truncated)';
  return '```\n' + text + '\n```';
}

/** The bot's custom status: one segment per server, e.g. "GTNH: 3 online · 20 TPS". */
export function formatPresence(states: ServerState[]): string {
  const part = (s: ServerState) => {
    if (!s.online) return `${stripCodes(s.name)}: offline`;
    if (s.hung) return `${stripCodes(s.name)}: not responding`;
    return `${stripCodes(s.name)}: ${s.players.length} online${s.tps === null ? '' : ` · ${Math.round(s.tps)} TPS`}`;
  };
  return truncate(states.map(part).join(' | '), 128);
}

/** A channel topic for one server. TPS is rounded so the text (and the rate-limited edit) changes less often. */
export function formatTopic(s: ServerState): string {
  if (!s.online) return '🔴 Offline';
  if (s.hung) return '🟠 Not responding';
  const tps = s.tps === null ? '' : ` · ${Math.round(s.tps)} TPS`;
  const n = s.players.length;
  const who = n ? `: ${s.players.join(', ')}` : '';
  return truncate(`🟢 Online${tps} · ${n} player${n === 1 ? '' : 's'}${who}`, 1024);
}

export type TopicEdit = { text: string; at: number };
/** Discord allows 2 topic edits per channel per 10 minutes. */
export const TOPIC_MIN_GAP_MS = 5 * 60_000;

/** Whether a channel topic should be edited to `text` now, given the last edit. */
export function topicDue(last: TopicEdit | undefined, text: string, now: number): boolean {
  return !last || (last.text !== text && now - last.at >= TOPIC_MIN_GAP_MS);
}
````

- [ ] **Step 4: Implement the Discord frontend**

`hub/src/discord.ts`:

```ts
import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type Webhook,
} from 'discord.js';
import { findCrashLogs } from './crashlogs.ts';
import type { Db } from './db.ts';
import {
  formatEvent,
  formatOutput,
  formatPlayers,
  formatPresence,
  formatStatus,
  formatTopic,
  md,
  topicDue,
  type TopicEdit,
} from './format.ts';
import type { RestartScheduler } from './restarts.ts';
import type { HubEvent, ServerHub } from './servers.ts';

export type DiscordConfig = {
  guildId: string;
  adminRoleId: string;
  /** serverId -> channelId */
  channels: Record<string, string>;
  /** serverId -> server folder, for crash-log uploads */
  dirs: Record<string, string>;
};

export type DiscordFrontend = { client: Client; post: (serverId: string, text: string) => void };

const DAY = 24 * 60 * 60 * 1000;
const WEBHOOK_NAME = 'GTNH Relay';
const CRASH_LOG_WINDOW_MS = 10 * 60_000;
const UNKNOWN_WEBHOOK = 10015; // Discord API error code

// Admin commands are hidden (default_member_permissions "0") until the admin role is allowed under
// Server Settings → Integrations; the adminRoleId check below still applies either way.
export const COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Server status, TPS and uptime'),
  new SlashCommandBuilder().setName('list').setDescription('Players online'),
  new SlashCommandBuilder()
    .setName('cmd')
    .setDescription('Run a server console command (admin role only)')
    .setDefaultMemberPermissions(0)
    .addStringOption((o) => o.setName('command').setDescription('Command, without the leading /').setRequired(true)),
  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart the server with an in-game countdown (admin role only)')
    .setDefaultMemberPermissions(0)
    .addSubcommand((s) =>
      s
        .setName('in')
        .setDescription('Schedule a restart')
        .addIntegerOption((o) =>
          o.setName('minutes').setDescription('Countdown length (0 = now)').setMinValue(0).setMaxValue(60).setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel the scheduled restart')),
].map((c) => c.toJSON());

/** Only people's own messages go into the game: not bots, webhooks (including our relay), or system notices. */
export function shouldRelay(m: Pick<Message, 'author' | 'webhookId' | 'system'>): boolean {
  return !m.author.bot && !m.webhookId && !m.system;
}

export async function startDiscord(
  hub: ServerHub,
  db: Db,
  restarts: RestartScheduler,
  cfg: DiscordConfig,
  token: string,
): Promise<DiscordFrontend> {
  const serverByChannel = new Map(Object.entries(cfg.channels).map(([serverId, channelId]) => [channelId, serverId]));
  const webhooks = new Map<string, Webhook>(); // serverId -> relay webhook
  const topics = new Map<string, TopicEdit>(); // channelId -> last edit
  let presence = '';
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [] }, // nothing the bot posts can ping anyone
  });

  async function post(serverId: string, text: string, files: string[] = []): Promise<void> {
    const channelId = cfg.channels[serverId];
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId);
    if (channel?.isSendable()) await channel.send({ content: text, files });
  }

  const postSafe = (serverId: string, text: string): void => {
    post(serverId, text).catch((err) => console.error(`[discord] post for ${serverId} failed:`, err));
  };

  // Game chat goes through the channel's webhook, with the player's name and skin; falls back to the bot.
  async function relayChat(e: Extract<HubEvent, { type: 'chat' }>): Promise<void> {
    const hook = webhooks.get(e.serverId);
    if (hook) {
      try {
        await hook.send({
          username: e.player,
          avatarURL: `https://mc-heads.net/avatar/${encodeURIComponent(e.player)}/64`,
          content: md(e.message),
          allowedMentions: { parse: [] },
        });
        return;
      } catch (err) {
        // A name Discord refuses for webhooks ("discord" in it) only affects this message; a deleted webhook
        // (Unknown Webhook, 10015) is forgotten so later chat doesn't retry it on every message.
        if ((err as { code?: number }).code === UNKNOWN_WEBHOOK) webhooks.delete(e.serverId);
        console.warn(`[discord] webhook send failed, posting as the bot: ${(err as Error).message}`);
      }
    }
    await post(e.serverId, formatEvent(e)!);
  }

  async function postCrash(serverId: string, text: string): Promise<void> {
    const files = cfg.dirs[serverId] ? await findCrashLogs(cfg.dirs[serverId], Date.now() - CRASH_LOG_WINDOW_MS) : [];
    try {
      await post(serverId, text, files);
    } catch (err) {
      if (!files.length) throw err;
      console.warn(`[discord] crash log upload failed, posting without it: ${(err as Error).message}`);
      await post(serverId, text);
    }
  }

  hub.on('event', (e) => {
    if (e.type === 'chat') {
      relayChat(e).catch((err) => console.error('[discord] chat relay failed:', err));
      return;
    }
    const text = formatEvent(e);
    if (!text) return;
    if (e.type === 'crashed') postCrash(e.serverId, text).catch((err) => console.error('[discord] crash post failed:', err));
    else postSafe(e.serverId, text);
  });

  client.on(Events.MessageCreate, (m) => {
    const serverId = serverByChannel.get(m.channelId);
    if (!serverId || !shouldRelay(m)) return;
    const text = [m.cleanContent, ...m.attachments.map((a) => a.url)].join(' ');
    hub.say(serverId, m.member?.displayName ?? m.author.username, text);
  });

  client.on(Events.InteractionCreate, (i) => {
    if (!i.isChatInputCommand()) return;
    handleCommand(i).catch((err) => console.error('[discord] command failed:', err));
  });

  async function handleCommand(i: ChatInputCommandInteraction): Promise<void> {
    const serverId = serverByChannel.get(i.channelId);
    const state = serverId ? hub.get(serverId) : undefined;
    if (!serverId || !state) {
      await i.reply({ content: 'This channel is not linked to a server.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.commandName === 'status') {
      const now = Date.now();
      await i.reply(formatStatus(state, db.uptime(serverId, now - DAY, now), db.uptime(serverId, now - 7 * DAY, now)));
      return;
    }
    if (i.commandName === 'list') {
      await i.reply(state.online ? formatPlayers(state.players) : `${md(state.name)} is offline.`);
      return;
    }
    // Admin commands from here on.
    if (!i.inCachedGuild() || !i.member.roles.cache.has(cfg.adminRoleId)) {
      await i.reply({ content: 'You need the admin role for this.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.commandName === 'cmd') {
      await i.deferReply(); // commands can take longer than Discord's 3 s reply window
      try {
        const output = await hub.runCommand(serverId, i.options.getString('command', true), `discord:${i.user.username} (${i.user.id})`);
        await i.editReply(formatOutput(output));
      } catch (err) {
        await i.editReply(`❌ ${(err as Error).message}`);
      }
    } else if (i.commandName === 'restart') {
      // The public announcement comes from the scheduler's notify; the reply is just for the admin.
      let reply: string;
      if (i.options.getSubcommand() === 'cancel') {
        reply = restarts.cancel(serverId, i.user.username) ? 'Restart cancelled.' : 'No restart is scheduled.';
      } else {
        try {
          restarts.schedule(serverId, i.options.getInteger('minutes', true), i.user.username);
          reply = 'Restart scheduled.';
        } catch (err) {
          reply = `❌ ${(err as Error).message}`;
        }
      }
      await i.reply({ content: reply, flags: MessageFlags.Ephemeral });
    }
  }

  async function setupWebhooks(c: Client<true>): Promise<void> {
    for (const [serverId, channelId] of Object.entries(cfg.channels)) {
      try {
        const channel = await c.channels.fetch(channelId);
        if (channel?.type !== ChannelType.GuildText) continue;
        const existing = (await channel.fetchWebhooks()).find((h) => h.owner?.id === c.user.id && h.name === WEBHOOK_NAME);
        webhooks.set(serverId, existing ?? (await channel.createWebhook({ name: WEBHOOK_NAME })));
      } catch (err) {
        console.warn(`[discord] no chat webhook for ${serverId} (needs Manage Webhooks), posting as the bot: ${(err as Error).message}`);
      }
    }
  }

  function updatePresence(): void {
    const text = formatPresence(hub.list());
    if (text === presence) return;
    presence = text;
    client.user?.setPresence({ activities: [{ name: 'Custom Status', state: text, type: ActivityType.Custom }] });
  }

  async function updateTopics(): Promise<void> {
    const now = Date.now();
    for (const s of hub.list()) {
      const channelId = cfg.channels[s.id];
      const text = formatTopic(s);
      if (!channelId || !topicDue(topics.get(channelId), text, now)) continue;
      topics.set(channelId, { text, at: now }); // also on failure: don't retry until the text changes
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.type === ChannelType.GuildText) await channel.setTopic(text);
      } catch (err) {
        console.warn(`[discord] topic update for ${s.id} failed (needs Manage Channels): ${(err as Error).message}`);
      }
    }
  }

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
    c.guilds
      .fetch(cfg.guildId)
      .then((guild) => guild.commands.set(COMMANDS))
      .catch((err) => console.error('[discord] registering slash commands failed:', err));
    setupWebhooks(c).catch((err) => console.error('[discord] webhook setup failed:', err));
    updatePresence();
    setInterval(updatePresence, 30_000).unref();
    setInterval(() => void updateTopics(), 60_000).unref();
  });

  await client.login(token);
  return { client, post: postSafe };
}
```

- [ ] **Step 5: Wire it up**

`hub/src/index.ts`:

```ts
import { readFileSync } from 'node:fs';
import { Db, type State } from './db.ts';
import { startDiscord } from './discord.ts';
import { RestartScheduler } from './restarts.ts';
import { ServerHub, type Lifecycle, type ServerConfig } from './servers.ts';

type Config = {
  listenPort: number;
  dbPath: string;
  guildId: string;
  adminRoleId: string;
  servers: (ServerConfig & { channelId: string; dir?: string; dailyRestart?: string })[];
};

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is not set');
const config = JSON.parse(readFileSync(process.argv[2] ?? 'config.json', 'utf8')) as Config;

const db = new Db(config.dbPath);
db.markHubRestart(config.servers.map((s) => s.id));
setInterval(() => db.touch(), 60_000);

const hub = new ServerHub(config.servers);
const STATES = new Map<Lifecycle, State>([
  ['connected', 'up'],
  ['started', 'up'],
  ['recovered', 'up'],
  ['stopped', 'down'],
  ['crashed', 'down'],
  ['hung', 'down'],
  ['offline', 'down'],
]);
hub.on('event', (e) => {
  const state = STATES.get(e.type as Lifecycle);
  if (state) db.record(e.serverId, state, e.type);
});

// The scheduler posts through Discord, which is connected below; until then its notices go nowhere.
let post: (serverId: string, text: string) => void = () => {};
const restarts = new RestartScheduler(hub, (serverId, text) => post(serverId, text));
for (const s of config.servers) if (s.dailyRestart) restarts.daily(s.id, s.dailyRestart); // throws on a bad time

const port = await hub.listen(config.listenPort);
console.log(`[hub] listening on 127.0.0.1:${port}`);

const discord = await startDiscord(
  hub,
  db,
  restarts,
  {
    guildId: config.guildId,
    adminRoleId: config.adminRoleId,
    channels: Object.fromEntries(config.servers.map((s) => [s.id, s.channelId])),
    dirs: Object.fromEntries(config.servers.flatMap((s) => (s.dir ? [[s.id, s.dir]] : []))),
  },
  token,
);
post = discord.post;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    restarts.stop();
    void discord.client.destroy();
    void hub.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
```

`hub/config.example.json`:

```json
{
  "listenPort": 25580,
  "dbPath": "hub.db",
  "guildId": "YOUR_DISCORD_SERVER_ID",
  "adminRoleId": "ROLE_ID_ALLOWED_TO_USE_CMD",
  "servers": [
    {
      "id": "gtnh",
      "name": "GTNH",
      "token": "CHANGE_ME_TO_A_LONG_RANDOM_STRING",
      "channelId": "CHANNEL_ID_FOR_THIS_SERVER",
      "dir": "/home/opc/GTNH",
      "dailyRestart": "06:00"
    }
  ]
}
```

- [ ] **Step 6: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 53`, `ℹ fail 0`, and `tsc` prints nothing.

Then run a smoke check without Discord credentials:
```bash
cd hub && cp config.example.json config.json
DISCORD_TOKEN=bogus timeout 10 node src/index.ts          # expect "[hub] listening …", then TokenInvalid
sed 's/"06:00"/"6am"/' config.example.json > bad.json
DISCORD_TOKEN=bogus timeout 10 node src/index.ts bad.json  # expect: dailyRestart must be HH:MM, and no "listening"
rm -f config.json bad.json hub.db
```

- [ ] **Step 7: Commit**

```bash
git add hub/src/format.ts hub/src/discord.ts hub/src/index.ts hub/config.example.json hub/test/format.test.ts hub/test/discord.test.ts
git commit -m "feat(hub): webhook chat with skins, presence/topics, crash uploads, /restart, hidden admin commands"
```

---

### Task 5: Docs, Node 24 check and manual smoke test

**Files:**
- Modify: `README.md` (bot permissions, command visibility, the new features)
- Modify: `hub/CLAUDE.md` (module table and the hub-core import rule)

- [ ] **Step 1: Update the docs**

`README.md`, the full file:

````markdown
# gtnh-discord

Talk to your GT: New Horizons servers from Discord: two-way chat, console
commands, status, and start/stop/crash alerts.

```
[GTNH server] ─ gtnhdiscord mod ─┐
[GTNH server] ─ gtnhdiscord mod ─┼─ TCP 127.0.0.1:25580 ─> hub (Node) ─> Discord
                                 ┘                              └─ SQLite uptime log
```

| Directory | What | Toolchain |
|---|---|---|
| `mod/` | Server-side Forge 1.7.10 mod. Relays game events, runs commands. | JDK 25, Gradle wrapper |
| `hub/` | The bot. Owns server state and uptime, talks to Discord. | Node 24+ |
| `deploy/` | systemd units for running both on one server. | systemd |
| `docs/` | Design spec and implementation plan. | — |

## Setup

### 1. Discord application

1. <https://discord.com/developers/applications> → **New Application** → **Bot**.
   Copy the bot token.
2. On the **Bot** page enable **Message Content Intent**. Without it the bot
   receives empty messages and Discord → game chat does nothing.
3. **OAuth2 → URL Generator**: scopes `bot` and `applications.commands`;
   permissions *View Channels*, *Send Messages*, *Read Message History*,
   *Attach Files*, *Manage Webhooks* (player-skin chat) and *Manage Channels*
   (live status in the channel topic). Open the URL and add the bot to your
   Discord server. Without the last two, chat posts as the bot and topics
   stay unchanged; everything else works.
   Already added the bot? Give its role those permissions under
   Server Settings → Roles instead.
4. In Discord, enable *Settings → Advanced → Developer Mode*, then right-click
   to **Copy ID** of: your Discord server (guild), the channel for each game
   server, and the role allowed to use `/cmd`.
5. `/cmd` and `/restart` are hidden from everyone by default. Show them to the
   admin role under Server Settings → Integrations → your bot → each command.
   The admin-role check still applies either way.

### 2. Hub

```bash
cd hub
npm ci
cp config.example.json config.json
openssl rand -hex 24          # one token per game server
$EDITOR config.json           # guildId, adminRoleId, and per server: id, name, token, channelId
echo 'DISCORD_TOKEN=<bot token>' > .env
set -a; . ./.env; set +a; npm start
```

`config.json` and `.env` are git-ignored. To run it permanently, see
[Running on a server](#running-on-a-server).

### 3. Mod

```bash
cd mod
./gradlew build
```

Copy `build/libs/gtnhdiscord-<version>.jar` (not `-dev` or `-sources`) into the
server's `mods/` folder. Clients don't need it. Start the server once to create
`config/gtnhdiscord.cfg`, then set the id and token from the hub's
`config.json`:

```
general {
    S:hubHost=127.0.0.1
    I:hubPort=25580
    S:serverId=gtnh
    S:token=<token from hub config.json>
}
```

Restart the server. The hub logs the connection, and the channel gets
"✅ Server started".

## Running on a server

`deploy/` has systemd units for running the hub and the GTNH server together on
one Linux machine. Edit `User=`/`SocketUser=` and the paths in the files first.

```bash
sudo install -m 600 -o root -g root hub/.env /etc/gtnh-discord.env   # bot token, root-only
sudo cp deploy/gtnh-hub.service deploy/gtnh.service deploy/gtnh.socket /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gtnh-hub gtnh
```

These work with SELinux enforcing (the default on RHEL/Oracle Linux): the token
lives in `/etc` rather than `/home`, and the server runs without tmux, which
SELinux doesn't let services start. If `gtnh.socket` fails with "Permission
denied" (SELinux blocking systemd from its own console FIFO), install the small
policy module in `deploy/gtnh-fifo.te`, which allows exactly that and nothing else:

```bash
checkmodule -M -m -o /tmp/gtnh-fifo.mod deploy/gtnh-fifo.te
semodule_package -o /tmp/gtnh-fifo.pp -m /tmp/gtnh-fifo.mod
sudo semodule -i /tmp/gtnh-fifo.pp
```

- **Hub logs:** `journalctl -u gtnh-hub -f`
- **Server console output:** `journalctl -u gtnh -f` (add yourself to the
  `systemd-journal` group to read it without sudo)
- **Server console input:** `echo "say hello" > /run/gtnh.stdin`, or `/cmd` from Discord
- **Stopping the server:** `sudo systemctl stop gtnh` stops it for maintenance.
  An in-game `/stop`, or `/cmd stop` from Discord, restarts it. So does a crash.
- **Start order doesn't matter:** the mod reconnects to the hub within about 30 s.

**Ports.** Only Minecraft needs to be reachable from outside:

- **Bot:** the bot only makes outbound connections to Discord (HTTPS), so it
  needs no inbound port.
- **Hub:** it listens on `127.0.0.1:25580`. **Don't open 25580**: that
  connection is only protected by its token.
- **Minecraft (25565/tcp)** on Oracle Cloud must be opened in two places:
  1. **OCI console:** VCN → Security List (or NSG) → an ingress rule for
     `0.0.0.0/0`, TCP 25565.
  2. **The host firewall:**
     `sudo firewall-cmd --permanent --add-port=25565/tcp && sudo firewall-cmd --reload`

## Using it

- Chat in the linked channel appears in game as `[Discord] <name> message`.
  In-game chat posts with each player's name and skin head; joins, leaves,
  deaths and achievements post as the bot.
- The bot's status and each channel's topic show who's online and the TPS.
  Topics update at most every 5 minutes (a Discord limit).
- `/status` shows online state, TPS, player count and 24 h / 7 d uptime.
- `/list` shows online players.
- `/cmd <command>` runs a console command and shows its output. Admin role only.
  Every command is logged by the hub.
- `/restart in <minutes>` restarts with in-game warnings at 10 / 5 / 1 min,
  30 s and 10 s; `/restart cancel` calls it off. Admin role only. Add
  `"dailyRestart": "06:00"` to a server in `config.json` for a daily restart
  at that local time (the countdown starts 10 minutes before).
- Alerts: started, stopped, went down unexpectedly (crash or kill), not
  responding (no heartbeat for 30 s), responding again. With `"dir"` set to
  the server's folder in `config.json`, a crash alert comes with the crash
  report and JVM error log (`hs_err_pid*.log`) attached.

Adding another game server: add an entry to `servers` in `config.json`,
restart the hub, and install the mod with that entry's `serverId` and token.

## Development

```bash
cd hub && npm test && npm run typecheck
cd mod && ./gradlew spotlessApply build   # build runs the JUnit tests
```

The wire protocol and design are in
`docs/superpowers/specs/2026-09-24-gtnh-discord-design.md`.
````

`hub/CLAUDE.md`, the full file:

````markdown
# hub

Node 24+ (tested on 24.21 and 26.9) + TypeScript + discord.js 14. Node runs `.ts` directly (type stripping) — there is no build step.

```bash
npm test            # node --test "test/*.test.ts"
npm run typecheck   # tsc, noEmit
npm start           # node src/index.ts; reads ./config.json (or argv[2]) and env DISCORD_TOKEN
```

## TypeScript constraints (type stripping)

- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Relative imports include the `.ts` extension; type-only imports use `import type` / `type X`.

## Modules

| File | Job |
|---|---|
| `src/protocol.ts` | Wire types + `parseModLine` validation. The contract with the mod. |
| `src/servers.ts` | `ServerHub`: TCP server, per-server state, liveness (crash/stop/hung), `say`, `runCommand`, `event` emitter. The API frontends use. |
| `src/db.ts` | SQLite (`node:sqlite`) up/down/unknown log and uptime math. |
| `src/restarts.ts` | `RestartScheduler`: countdown restarts (in-game `say` warnings, then `stop`) and daily restarts. Hub core. |
| `src/crashlogs.ts` | `findCrashLogs`: newest crash report / `hs_err_pid*.log` in a server folder. Hub core. |
| `src/format.ts` | Pure Discord text: `md`, `format*`, `topicDue`. Unit-tested. |
| `src/discord.ts` | Discord frontend: webhook chat, alerts (+ crash-log uploads), presence, topics, `/status` `/list` `/cmd` `/restart`. |
| `src/index.ts` | Config loading and wiring only. |

A future web dashboard goes in `src/web/` and calls `ServerHub` and `RestartScheduler` — never the mod sockets.
Hub-core modules (`servers`, `restarts`, `crashlogs`, `db`) must not import `discord.js` or `format.ts`.

## Dependencies

Runtime: `discord.js` only. Prefer Node built-ins (`node:net`, `node:readline`, `node:sqlite`,
`node:test`, `node:crypto`) over adding packages.

## Trust boundaries (do not weaken)

- Mod input: every line goes through `parseModLine` (checks `Object.hasOwn` on the type and field types).
  Tokens ≥16 chars, compared with `timingSafeEqual`. Hub binds `127.0.0.1`.
- Discord → MC: `ServerHub.say` cleans text with `mcText` (strips `§` codes/control chars, caps 256).
- MC → Discord: `md()` escapes markdown incl. headings/masked links; the Client uses
  `allowedMentions: { parse: [] }` so nothing the bot posts can ping.
- `/cmd`: admin role check + `deferReply`; `runCommand` logs who ran it.

## Tests

`test/servers.test.ts` drives a real socket with a fake mod (`fakeMod`, `online`, `until` helpers) — use it
for any hub behaviour change. Keep timing-sensitive tests on small `HubOptions` timeouts, not sleeps of seconds.
````

- [ ] **Step 2: Run the suite on Node 24 too**

```bash
cd hub && npm test && npm run typecheck
V=v24.21.0; T=$(mktemp -d)
curl -fsSL https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz | tar -xJ -C "$T"
"$T/node-$V-linux-x64/bin/node" --test "test/*.test.ts"; rm -rf "$T"
```
Expected: `ℹ pass 53`, `ℹ fail 0` on both, and `tsc` silent. Use `linux-arm64` instead of `linux-x64` on an ARM machine.

- [ ] **Step 3: Commit and push**

```bash
git add README.md hub/CLAUDE.md
git commit -m "docs: v1.1 features, bot permissions and command visibility"
git push -u origin feat/v1.1
```

- [ ] **Step 4: Manual smoke test on the real server (with the user)**

First deploy the update:
1. `git pull`, then `npm ci` in `hub/`.
2. Add `dir` (and optionally `dailyRestart`) to `config.json`.
3. Give the bot role Manage Webhooks, Manage Channels and Attach Files.
4. Allow `/cmd` and `/restart` for the admin role under Integrations.
5. `sudo systemctl restart gtnh-hub`.

Then check:
1. **Skin chat:** in-game chat appears with the player's name and skin head, and isn't echoed back into the game.
2. **Refused name:** a player with "discord" in their name, if you can test it, falls back to a bot post. Remove Manage Webhooks and restart the hub: chat posts as the bot with one warning in `journalctl -u gtnh-hub`.
3. **Deleted webhook:** delete the "GTNH Relay" webhook in channel settings while the hub runs. Chat continues as bot posts, and the webhook warning appears once, not on every message.
4. **Presence:** the bot's status shows `GTNH: N online · 20 TPS` within 30 s.
5. **Topic:** the channel topic updates within about a minute of start, and again after someone joins, at least 5 minutes after the previous edit.
6. **Restart:** `/restart in 1` → in-game warnings at 1 min, 30 s and 10 s. Discord shows "🔄 Restart in 1 minute" and then "🔄 Restarting now". The server stops and comes back ("✅ Server started").
7. **Cancel:** `/restart in 5`, then `/restart cancel` → "❎ Restart cancelled (by …)", and players see "Restart cancelled".
8. **Crash upload:** `kill -9` the Java process → "💥 Server went down unexpectedly", with the crash report or `hs_err_pid*.log` attached if one was written.
9. **Hidden commands:** a non-admin member doesn't see `/cmd` or `/restart`.

Any failure is a bug. Fix it with superpowers:systematic-debugging.

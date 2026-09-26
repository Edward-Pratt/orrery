# GTNH Discord Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node/TypeScript Discord hub plus a server-side Forge 1.7.10 mod that bridge GTNH servers and Discord: two-way chat, `/cmd`, `/status`, `/list`, and start/stop/crash/hang alerts with uptime tracking.

**Architecture:** Each GTNH server runs the `gtnhdiscord` mod, which connects out to the hub over localhost TCP (newline-delimited JSON, protocol v1). The hub's `ServerHub` owns all server state and is the only API frontends use. The Discord frontend is `discord.ts`, and a web dashboard comes later. SQLite records up/down transitions for uptime.

**Tech Stack:**
- Hub: Node 26 (runs `.ts` directly), TypeScript 7 (typecheck only), discord.js 14, `node:sqlite`, `node:test`.
- Mod: Forge 1.7.10 via the GTNewHorizons ExampleMod template (RetroFuturaGradle, Gradle 9.3.1, JDK 25, jabel → Java 8 bytecode), Gson 2.2.4 (bundled with MC), JUnit 5.

**Spec:** `docs/superpowers/specs/2026-09-24-gtnh-discord-design.md`

## Global Constraints

- Repo layout is fixed by the spec's "Repository layout" section. `hub/` and `mod/` are independent projects: run npm commands in `hub/` and Gradle commands in `mod/`. Nothing builds at the root.
- Hub runs with `node src/index.ts` (Node type stripping). Use erasable TypeScript only: no `enum`, `namespace` or constructor parameter properties. Relative imports end in `.ts`.
- Hub dependencies are exactly `discord.js` (runtime) plus `typescript` and `@types/node` (dev). Everything else comes from Node built-ins.
- Hub listens on `127.0.0.1` only. Server tokens must be at least 16 characters and are compared in constant time.
- Protocol version is `1`. Message and field names match the spec's Protocol section exactly.
- Mod package is `io.github.edwardpratt.gtnhdiscord`, modid `gtnhdiscord`, and the mod is server-side only (`acceptableRemoteVersions = "*"`).
- Mod code must run on Java 8. Jabel allows modern *syntax* (e.g. `var`) but no Java 9+ *APIs* (`List.of`, `String.isBlank`, …). Use the Gson 2.2.4 API (`new JsonParser().parse`, `JsonArray.add(JsonElement)`). No new runtime dependencies.
- Building the mod needs a full JDK 25 (`javac` present). Always run `./gradlew spotlessApply` before `./gradlew build`: spotless is enforced, and checkstyle rejects wildcard imports.
- Every commit message ends with these trailer lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019KzyhKnrr3Gj8zCrcVtthm
  ```

## Review Focus

1. **A mod message whose `type` is an `Object.prototype` key** (`constructor`, `__proto__`) must be rejected, not accepted with no field checks. Pinned in Task 1's `rejects unknown types` test.
2. **Hub restart while game servers keep running.** Reconnecting mods must not produce "Server started" or "went down unexpectedly" posts. Pinned in Task 3 (`a reconnect replaces the old connection…`) and Task 4 (`formatEvent … not reconnects`).
3. **Discord messages that are only `§` codes, contain newlines, or run 300+ characters** must produce either nothing or one clean ≤256-character chat line. Pinned in Task 3's `say cleans text…` test.
4. **`/cmd` output containing ```` ``` ```` or longer than 2000 characters** must still produce one valid code block that Discord accepts. Pinned in Task 4's `formatOutput …` test.
5. **Game server booting while the hub is down.** `started` must still arrive once the hub is up, and chat from the outage must not be replayed. Pinned in Task 7's `whileDisconnectedKeepsOnlyLifecycleMessages` test.

---

### Task 1: Hub project and protocol contract

**Files:**
- Create: `hub/package.json`, `hub/tsconfig.json`, `hub/src/protocol.ts`
- Test: `hub/test/protocol.test.ts`

**Interfaces:**
- Produces: `PROTOCOL_VERSION = 1`; types `Hello`, `ModMsg` (union over `type`: `started | stopping | heartbeat | chat | join | leave | death | achievement | cmdResult`), `HubMsg` (`welcome | reject | say | cmd`); `parseModLine(line: string): Hello | ModMsg | null`.

- [ ] **Step 1: Create the npm project**

`hub/package.json`:

```json
{
  "name": "gtnh-discord-hub",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=26"
  },
  "scripts": {
    "start": "node src/index.ts",
    "test": "node --test \"test/*.test.ts\"",
    "typecheck": "tsc"
  },
  "dependencies": {
    "discord.js": "^14.27.0"
  },
  "devDependencies": {
    "@types/node": "^26.6.2",
    "typescript": "^7.0.2"
  }
}
```

`hub/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

Run: `cd hub && npm install`
Expected: creates `node_modules/` (ignored by the root `.gitignore`) and `package-lock.json` (committed), with no errors.

- [ ] **Step 2: Write the failing test**

`hub/test/protocol.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModLine } from '../src/protocol.ts';

test('parses valid messages', () => {
  assert.deepEqual(parseModLine('{"type":"chat","player":"Steve","message":"hi"}'), {
    type: 'chat',
    player: 'Steve',
    message: 'hi',
  });
  assert.deepEqual(parseModLine('{"type":"started"}'), { type: 'started' });
  assert.deepEqual(parseModLine('{"type":"heartbeat","tps":19.9,"players":["a","b"]}'), {
    type: 'heartbeat',
    tps: 19.9,
    players: ['a', 'b'],
  });
});

test('rejects malformed JSON and non-objects', () => {
  for (const line of ['', 'not json', 'null', '42', '"chat"', '[]']) assert.equal(parseModLine(line), null, line);
});

test('rejects unknown types, including Object.prototype keys', () => {
  for (const type of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(parseModLine(JSON.stringify({ type })), null, type);
  }
});

test('rejects wrong field types', () => {
  assert.equal(parseModLine('{"type":"chat","player":"Steve","message":42}'), null);
  assert.equal(parseModLine('{"type":"chat","player":"Steve"}'), null);
  assert.equal(parseModLine('{"type":"heartbeat","tps":"20","players":[]}'), null);
  assert.equal(parseModLine('{"type":"heartbeat","tps":20,"players":["a",1]}'), null);
  assert.equal(parseModLine('{"type":"cmdResult","id":"x","output":"not an array"}'), null);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd hub && npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/protocol.ts`.

- [ ] **Step 4: Implement**

`hub/src/protocol.ts`:

```ts
// Wire contract between the mod and the hub: one JSON object per line.
export const PROTOCOL_VERSION = 1;

export type Hello = { type: 'hello'; protocol: number; serverId: string; token: string; modVersion: string };

export type ModMsg =
  | { type: 'started' }
  | { type: 'stopping' }
  | { type: 'heartbeat'; tps: number; players: string[] }
  | { type: 'chat'; player: string; message: string }
  | { type: 'join'; player: string }
  | { type: 'leave'; player: string }
  | { type: 'death'; player: string; message: string }
  | { type: 'achievement'; player: string; achievement: string }
  | { type: 'cmdResult'; id: string; output: string[] };

export type HubMsg =
  | { type: 'welcome' }
  | { type: 'reject'; reason: string }
  | { type: 'say'; author: string; message: string }
  | { type: 'cmd'; id: string; command: string };

type Kind = 'string' | 'number' | 'string[]';

const SCHEMAS: Record<string, Record<string, Kind>> = {
  hello: { protocol: 'number', serverId: 'string', token: 'string', modVersion: 'string' },
  started: {},
  stopping: {},
  heartbeat: { tps: 'number', players: 'string[]' },
  chat: { player: 'string', message: 'string' },
  join: { player: 'string' },
  leave: { player: 'string' },
  death: { player: 'string', message: 'string' },
  achievement: { player: 'string', achievement: 'string' },
  cmdResult: { id: 'string', output: 'string[]' },
};

function hasKind(value: unknown, kind: Kind): boolean {
  if (kind === 'string[]') return Array.isArray(value) && value.every((v) => typeof v === 'string');
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'string';
}

/** Parses one line from a mod; null for malformed JSON, unknown types, or wrong field types. */
export function parseModLine(line: string): Hello | ModMsg | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;
  if (typeof msg.type !== 'string' || !Object.hasOwn(SCHEMAS, msg.type)) return null;
  for (const [field, kind] of Object.entries(SCHEMAS[msg.type])) {
    if (!hasKind(msg[field], kind)) return null;
  }
  return msg as Hello | ModMsg;
}
```

- [ ] **Step 5: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 4`, `ℹ fail 0`, and `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add hub/package.json hub/package-lock.json hub/tsconfig.json hub/src/protocol.ts hub/test/protocol.test.ts
git commit -m "feat(hub): npm project and mod protocol parser"
```

---

### Task 2: Uptime database

**Files:**
- Create: `hub/src/db.ts`
- Test: `hub/test/db.test.ts`

**Interfaces:**
- Produces: `type State = 'up' | 'down' | 'unknown'`; `type Row = { ts: number; state: State }`; `computeUptime(rows: Row[], from: number, to: number): number | null`; `class Db` with `constructor(path: string)`, `record(serverId, state: State, reason: string, ts?)`, `touch(ts?)`, `markHubRestart(serverIds: string[], now?)`, `uptime(serverId, from, to?): number | null`, `close()`.

- [ ] **Step 1: Write the failing test**

`hub/test/db.test.ts`:

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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd hub && npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/db.ts`.

- [ ] **Step 3: Implement**

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

  record(serverId: string, state: State, reason: string, ts = Date.now()): void {
    this.#db
      .prepare('INSERT INTO events (server_id, ts, state, reason) VALUES (?, ?, ?, ?)')
      .run(serverId, ts, state, reason);
    this.touch(ts); // the hub was alive at least until this event
  }

  /** Stamps the hub as alive. Call every minute. */
  touch(ts = Date.now()): void {
    this.#db
      .prepare("INSERT INTO meta (key, value) VALUES ('last_alive', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(ts);
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
Expected: `ℹ pass 10`, `ℹ fail 0`, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add hub/src/db.ts hub/test/db.test.ts
git commit -m "feat(hub): SQLite uptime log"
```

---

### Task 3: ServerHub (TCP server, registry, public API)

**Files:**
- Create: `hub/src/servers.ts`
- Test: `hub/test/servers.test.ts`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION`, `parseModLine`, `Hello`, `HubMsg`, `ModMsg` from Task 1.
- Produces:
  - `type ServerConfig = { id: string; name: string; token: string }`
  - `type ServerState = { id; name; online: boolean; hung: boolean; tps: number | null; players: string[] }`
  - `type Lifecycle = 'connected' | 'started' | 'stopped' | 'crashed' | 'hung' | 'recovered'`
  - `type HubEvent = { serverId: string } & (GameMsg | { type: Lifecycle })`, where `GameMsg` is the `chat | join | leave | death | achievement` members of `ModMsg`
  - `type HubOptions = { hungMs?; cmdTimeoutMs?; helloTimeoutMs? }`
  - `stripCodes(s): string` and `mcText(s, max): string`
  - `class ServerHub extends EventEmitter<{ event: [HubEvent] }>` with `listen(port, host?) → Promise<number>`, `close()`, `list()`, `get(id)`, `say(id, author, message): boolean`, `runCommand(id, command, by): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

`hub/test/servers.test.ts`:

```ts
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { ServerHub, type HubEvent, type HubOptions } from '../src/servers.ts';

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
  await assert.rejects(timedOut, /timed out/);
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd hub && npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/servers.ts`.

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

export type Lifecycle = 'connected' | 'started' | 'stopped' | 'crashed' | 'hung' | 'recovered';
export type GameMsg = Extract<ModMsg, { type: 'chat' | 'join' | 'leave' | 'death' | 'achievement' }>;
export type HubEvent = { serverId: string } & (GameMsg | { type: Lifecycle });

export type HubOptions = { hungMs?: number; cmdTimeoutMs?: number; helloTimeoutMs?: number };

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
  #closing = false;
  #hungMs: number;
  #cmdTimeoutMs: number;
  #helloTimeoutMs: number;

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
  }

  /** Starts listening. Resolves with the bound port (pass 0 for a random one). */
  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.#accept(socket));
      server.once('error', reject);
      server.listen(port, host, () => {
        this.#server = server;
        this.#timer = setInterval(() => this.#checkHung(), Math.min(5_000, this.#hungMs / 2));
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#timer);
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
        reject(new Error('command timed out'));
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
        this.emit('event', { serverId: id, ...msg });
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

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 23`, `ℹ fail 0`, and `tsc` prints nothing. The `[cmd] test on gtnh: …` log lines are expected (audit log).

- [ ] **Step 5: Commit**

```bash
git add hub/src/servers.ts hub/test/servers.test.ts
git commit -m "feat(hub): ServerHub with handshake, liveness and commands"
```

---

### Task 4: Discord frontend

**Files:**
- Create: `hub/src/discord.ts`
- Test: `hub/test/discord.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 2); `ServerHub`, `HubEvent`, `ServerState`, `stripCodes` (Task 3).
- Produces: `type DiscordConfig = { guildId; adminRoleId; channels: Record<serverId, channelId> }`; pure formatters `md`, `formatEvent`, `formatStatus`, `formatPlayers`, `formatOutput`; `startDiscord(hub, db, cfg, token): Promise<Client>`.

- [ ] **Step 1: Write the failing test**

`hub/test/discord.test.ts`:

````ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatEvent, formatOutput, formatPlayers, formatStatus } from '../src/discord.ts';
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
````

- [ ] **Step 2: Run it to verify it fails**

Run: `cd hub && npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/discord.ts`.

- [ ] **Step 3: Implement**

`hub/src/discord.ts`:

````ts
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Db } from './db.ts';
import { stripCodes, type HubEvent, type ServerHub, type ServerState } from './servers.ts';

export type DiscordConfig = {
  guildId: string;
  adminRoleId: string;
  /** serverId -> channelId */
  channels: Record<string, string>;
};

const DAY = 24 * 60 * 60 * 1000;

const COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Server status, TPS and uptime'),
  new SlashCommandBuilder().setName('list').setDescription('Players online'),
  new SlashCommandBuilder()
    .setName('cmd')
    .setDescription('Run a server console command (admin role only)')
    .addStringOption((o) => o.setName('command').setDescription('Command, without the leading /').setRequired(true)),
].map((c) => c.toJSON());

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
    case 'connected':
      return null; // may just be a reconnect after a hub restart
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
  if (text.length > max) text = text.slice(0, max) + '\n… (truncated)';
  return '```\n' + text + '\n```';
}

export async function startDiscord(hub: ServerHub, db: Db, cfg: DiscordConfig, token: string): Promise<Client> {
  const serverByChannel = new Map(Object.entries(cfg.channels).map(([serverId, channelId]) => [channelId, serverId]));
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [] }, // nothing the bot posts can ping anyone
  });

  hub.on('event', (e) => {
    const text = formatEvent(e);
    const channelId = cfg.channels[e.serverId];
    if (!text || !channelId) return;
    post(channelId, text).catch((err) => console.error(`[discord] post to ${channelId} failed:`, err));
  });

  async function post(channelId: string, text: string): Promise<void> {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isSendable()) await channel.send(text);
  }

  client.on(Events.MessageCreate, (m) => {
    const serverId = serverByChannel.get(m.channelId);
    if (!serverId || m.author.bot || m.webhookId) return;
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
    } else if (i.commandName === 'list') {
      await i.reply(state.online ? formatPlayers(state.players) : `${md(state.name)} is offline.`);
    } else if (i.commandName === 'cmd') {
      if (!i.inCachedGuild() || !i.member.roles.cache.has(cfg.adminRoleId)) {
        await i.reply({ content: 'You need the admin role to run commands.', flags: MessageFlags.Ephemeral });
        return;
      }
      await i.deferReply(); // commands can take longer than Discord's 3 s reply window
      try {
        const output = await hub.runCommand(serverId, i.options.getString('command', true), `discord:${i.user.username} (${i.user.id})`);
        await i.editReply(formatOutput(output));
      } catch (err) {
        await i.editReply(`❌ ${(err as Error).message}`);
      }
    }
  }

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
    c.guilds
      .fetch(cfg.guildId)
      .then((guild) => guild.commands.set(COMMANDS))
      .catch((err) => console.error('[discord] registering slash commands failed:', err));
  });

  await client.login(token);
  return client;
}
````

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 28`, `ℹ fail 0`, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add hub/src/discord.ts hub/test/discord.test.ts
git commit -m "feat(hub): Discord relay, alerts and slash commands"
```

---

### Task 5: Hub entry point and config

**Files:**
- Create: `hub/src/index.ts`, `hub/config.example.json`

**Interfaces:**
- Consumes: `Db`, `State` (Task 2); `ServerHub`, `Lifecycle`, `ServerConfig` (Task 3); `startDiscord` (Task 4).
- Produces: `npm start` runs the hub, reading `config.json` from the current directory (or the path in `argv[2]`) and `DISCORD_TOKEN` from the environment.

- [ ] **Step 1: Write the files**

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
      "channelId": "CHANNEL_ID_FOR_THIS_SERVER"
    }
  ]
}
```

`hub/src/index.ts`:

```ts
import { readFileSync } from 'node:fs';
import { Db, type State } from './db.ts';
import { startDiscord } from './discord.ts';
import { ServerHub, type Lifecycle, type ServerConfig } from './servers.ts';

type Config = {
  listenPort: number;
  dbPath: string;
  guildId: string;
  adminRoleId: string;
  servers: (ServerConfig & { channelId: string })[];
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
]);
hub.on('event', (e) => {
  const state = STATES.get(e.type as Lifecycle);
  if (state) db.record(e.serverId, state, e.type);
});

const port = await hub.listen(config.listenPort);
console.log(`[hub] listening on 127.0.0.1:${port}`);

await startDiscord(
  hub,
  db,
  {
    guildId: config.guildId,
    adminRoleId: config.adminRoleId,
    channels: Object.fromEntries(config.servers.map((s) => [s.id, s.channelId])),
  },
  token,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void hub.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
```

- [ ] **Step 2: Typecheck and run the full suite**

Run: `cd hub && npm run typecheck && npm test`
Expected: `tsc` prints nothing; `ℹ pass 28`, `ℹ fail 0`.

- [ ] **Step 3: Smoke-run without Discord credentials**

Run:
```bash
cd hub && cp config.example.json config.json && DISCORD_TOKEN=bogus timeout 10 node src/index.ts; rm -f config.json hub.db
```
Expected: prints `[hub] listening on 127.0.0.1:25580`, then exits with a discord.js `TokenInvalid` error. Both show that config loading, the DB and the TCP listener work. Then confirm `DISCORD_TOKEN= node src/index.ts` fails with `DISCORD_TOKEN is not set`.

- [ ] **Step 4: Commit**

```bash
git add hub/src/index.ts hub/config.example.json
git commit -m "feat(hub): entry point wiring hub, uptime log and Discord"
```

---

### Task 6: Mod project from the GTNH template

**Files:**
- Create: `mod/` (from the template ZIP), `mod/dependencies.gradle` (replace), `mod/src/main/resources/mcmod.info` (replace)
- Modify: `mod/gradle.properties` (5 keys)
- Delete: the template's `.github/`, `jitpack.yml`, `CODEOWNERS`, `LICENSE`, `LICENSE-template`, `README.md`, `docs/`, `src/main/resources/LICENSE`, `src/main/java/com/`

**Interfaces:**
- Produces: a Gradle project in `mod/` that builds `gtnhdiscord-<version>.jar`, runs JUnit 5 tests, and generates `io.github.edwardpratt.gtnhdiscord.Tags.VERSION`.

- [ ] **Step 1: Unpack the template** (download the starter ZIP; do not clone or fork it, per the template's README)

```bash
tmp=$(mktemp -d)
curl -sL -o "$tmp/t.zip" https://github.com/GTNewHorizons/ExampleMod1.7.10/archive/refs/heads/master.zip
unzip -q "$tmp/t.zip" -d "$tmp"
cp -r "$tmp/ExampleMod1.7.10-master" mod
rm -rf "$tmp"
cd mod
rm -rf .github jitpack.yml CODEOWNERS LICENSE LICENSE-template README.md docs src/main/resources/LICENSE src/main/java/com
mkdir -p src/main/java/io/github/edwardpratt/gtnhdiscord   # the build plugin refuses to configure without the modGroup package dir
```

- [ ] **Step 2: Set the mod identity**

```bash
cd mod
sed -i \
  -e 's/^modName = .*/modName = GTNH Discord/' \
  -e 's/^modId = .*/modId = gtnhdiscord/' \
  -e 's/^modGroup = .*/modGroup = io.github.edwardpratt.gtnhdiscord/' \
  -e 's/^generateGradleTokenClass = .*/generateGradleTokenClass = io.github.edwardpratt.gtnhdiscord.Tags/' \
  -e 's/^usesMavenPublishing = .*/usesMavenPublishing = false/' \
  gradle.properties
grep -nE '^(modName|modId|modGroup|generateGradleTokenClass|usesMavenPublishing) ' gradle.properties
```
Expected: 5 lines showing the new values. If a key is missing (the template changed), add it by hand with the value above.

- [ ] **Step 3: Enable JUnit 5 and replace mcmod.info**

`mod/dependencies.gradle` (the template does not set up JUnit):

```groovy
dependencies {
    testImplementation(platform("org.junit:junit-bom:5.13.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.named("test", Test) { useJUnitPlatform() }
```

`mod/src/main/resources/mcmod.info`:

```json
[{
	"modid": "${modId}",
	"name": "${modName}",
	"description": "Server-side bridge between a GTNH server and the gtnh-discord hub.",
	"version": "${modVersion}",
	"mcversion": "${minecraftVersion}",
	"url": "https://github.com/Edward-Pratt/gtnh-discord",
	"authorList": ["Edward-Pratt"]
}]
```

- [ ] **Step 4: Build**

Run: `cd mod && ./gradlew --console=plain build`
Expected: `BUILD SUCCESSFUL`. The first run downloads and decompiles Minecraft and takes a few minutes. If it fails with `Unable to download toolchain … must have the executable 'javac'`, JDK 25 is missing: install `jdk25-openjdk` (Arch) and retry.

- [ ] **Step 5: Commit**

```bash
git add mod
git status --short mod | grep -v '^A' || true   # expect nothing: build/, .gradle/ and run/ are ignored
git commit -m "chore(mod): scaffold from GTNewHorizons ExampleMod1.7.10"
```

---

### Task 7: HubClient (mod-side connection)

**Files:**
- Create: `mod/src/main/java/io/github/edwardpratt/gtnhdiscord/HubClient.java`
- Test: `mod/src/test/java/io/github/edwardpratt/gtnhdiscord/HubClientTest.java`

**Interfaces:**
- Produces:
  - `new HubClient(String host, int port, String serverId, String token, String modVersion)`
  - `start()`
  - `send(JsonObject)`: drops everything except `started`/`stopping` while disconnected; bounded at `MAX_OUTBOX = 1000`, dropping the oldest.
  - `JsonObject poll()`: returns null when empty.
  - `boolean isConnected()`
  - `stop(long timeoutMs)`: flushes (waiting at most `timeoutMs`; `0` means don't wait), then closes. Idempotent.
  - package-private `static JsonObject parse(String)` and `static String str(JsonObject, String)`
  - package-private `minBackoffMs` and `maxBackoffMs`, for tests.

- [ ] **Step 1: Write the failing test**

`mod/src/test/java/io/github/edwardpratt/gtnhdiscord/HubClientTest.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.function.BooleanSupplier;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;

class HubClientTest {

    /** Plays the hub's side of the protocol over a real socket. */
    static class FakeHub implements AutoCloseable {

        final ServerSocket server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        Socket socket;
        BufferedReader in;
        Writer out;

        FakeHub() throws IOException {
            server.setSoTimeout(5000);
        }

        void accept() throws IOException {
            socket = server.accept();
            socket.setSoTimeout(5000);
            in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            out = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8);
        }

        JsonObject read() throws IOException {
            return HubClient.parse(in.readLine());
        }

        void write(String json) throws IOException {
            out.write(json + "\n");
            out.flush();
        }

        JsonObject handshake() throws IOException {
            accept();
            JsonObject hello = read();
            write("{\"type\":\"welcome\"}");
            return hello;
        }

        @Override
        public void close() throws IOException {
            if (socket != null) socket.close();
            server.close();
        }
    }

    FakeHub hub;
    HubClient client;

    @BeforeEach
    void setUp() throws IOException {
        hub = new FakeHub();
        client = new HubClient("127.0.0.1", hub.server.getLocalPort(), "gtnh", "secret-token-0123", "test");
        client.minBackoffMs = 50;
        client.maxBackoffMs = 200;
    }

    @AfterEach
    void tearDown() throws IOException {
        client.stop(1000);
        hub.close();
    }

    static JsonObject msg(String type) {
        JsonObject o = new JsonObject();
        o.addProperty("type", type);
        return o;
    }

    static void waitUntil(BooleanSupplier cond) throws InterruptedException {
        long end = System.currentTimeMillis() + 5000;
        while (!cond.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("condition not met in time");
            Thread.sleep(10);
        }
    }

    @Test
    void handshakesThenSendsAndReceives() throws Exception {
        client.start();
        JsonObject hello = hub.handshake();
        assertEquals("hello", HubClient.str(hello, "type"));
        assertEquals("gtnh", HubClient.str(hello, "serverId"));
        assertEquals("secret-token-0123", HubClient.str(hello, "token"));
        assertEquals(
            1,
            hello.get("protocol")
                .getAsInt());
        waitUntil(client::isConnected);

        JsonObject chat = msg("chat");
        chat.addProperty("player", "Steve");
        chat.addProperty("message", "hi");
        client.send(chat);
        assertEquals(chat, hub.read());

        hub.write("{\"type\":\"say\",\"author\":\"Bob\",\"message\":\"yo\"}");
        waitUntil(() -> client.poll() != null);
    }

    @Test
    void whileDisconnectedKeepsOnlyLifecycleMessages() throws Exception {
        client.send(msg("chat"));
        client.send(msg("heartbeat"));
        client.send(msg("started"));
        client.start();
        hub.handshake();
        assertEquals("started", HubClient.str(hub.read(), "type"));
        waitUntil(client::isConnected);
        client.send(msg("join"));
        assertEquals("join", HubClient.str(hub.read(), "type"));
    }

    @Test
    void dropsOldestWhenOutboxIsFull() throws Exception {
        for (int i = 0; i <= HubClient.MAX_OUTBOX; i++) {
            JsonObject m = msg("started");
            m.addProperty("seq", i);
            client.send(m);
        }
        client.start();
        hub.handshake();
        assertEquals(
            1,
            hub.read()
                .get("seq")
                .getAsInt()); // seq 0 was dropped
    }

    @Test
    void reconnectsAfterTheHubDropsTheConnection() throws Exception {
        client.start();
        hub.handshake();
        waitUntil(client::isConnected);
        hub.socket.close();
        waitUntil(() -> !client.isConnected());
        hub.handshake();
        waitUntil(client::isConnected);
    }

    @Test
    void refusedConnectionStaysDisconnected() throws Exception {
        client.start();
        hub.accept();
        hub.read();
        hub.write("{\"type\":\"reject\",\"reason\":\"bad token\"}");
        assertNull(hub.in.readLine()); // client hangs up
        assertFalse(client.isConnected());
    }

    @Test
    void stopFlushesQueuedMessagesThenCloses() throws Exception {
        client.start();
        hub.handshake();
        waitUntil(client::isConnected);
        client.send(msg("stopping"));
        client.stop(2000);
        assertEquals("stopping", HubClient.str(hub.read(), "type"));
        assertNull(hub.in.readLine());
        assertTrue(!client.isConnected());
    }

    @Test
    void stopWithZeroTimeoutReturnsEvenIfTheHubNeverAnswers() throws Exception {
        client.start();
        hub.accept();
        hub.read(); // hello arrives, but no welcome is ever sent: the client is blocked reading
        assertTimeoutPreemptively(Duration.ofSeconds(2), () -> client.stop(0));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mod && ./gradlew --console=plain test`
Expected: FAIL at `compileTestJava` with `cannot find symbol … class HubClient`.

- [ ] **Step 3: Implement**

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/HubClient.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Line-delimited JSON connection to the hub. Runs on its own daemon threads and never touches Minecraft classes, so
 * the game thread only ever calls {@link #send} and {@link #poll}.
 */
public class HubClient {

    static final int MAX_OUTBOX = 1000;
    private static final Logger LOG = LogManager.getLogger("gtnhdiscord");

    private final String host;
    private final int port;
    private final JsonObject hello = new JsonObject();
    private final LinkedBlockingDeque<String> outbox = new LinkedBlockingDeque<>();
    private final ConcurrentLinkedQueue<JsonObject> inbox = new ConcurrentLinkedQueue<>();
    private volatile boolean running;
    private volatile boolean connected;
    private volatile Socket socket;
    private Thread thread;
    long minBackoffMs = 1000;
    long maxBackoffMs = 30_000;

    public HubClient(String host, int port, String serverId, String token, String modVersion) {
        this.host = host;
        this.port = port;
        hello.addProperty("type", "hello");
        hello.addProperty("protocol", 1);
        hello.addProperty("serverId", serverId);
        hello.addProperty("token", token);
        hello.addProperty("modVersion", modVersion);
    }

    public synchronized void start() {
        if (running) return;
        running = true;
        thread = new Thread(this::run, "GTNHDiscord-hub");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * Queues a message for the hub. While disconnected only started/stopping are kept, so a hub outage never replays
     * stale chat. The queue is bounded: when full, the oldest message is dropped.
     */
    public void send(JsonObject msg) {
        String type = msg.get("type")
            .getAsString();
        if (!connected && !type.equals("started") && !type.equals("stopping")) return;
        synchronized (outbox) {
            if (outbox.size() >= MAX_OUTBOX) outbox.pollFirst();
            outbox.offerLast(msg.toString());
        }
    }

    /** Next message from the hub, or null. */
    public JsonObject poll() {
        return inbox.poll();
    }

    public boolean isConnected() {
        return connected;
    }

    /**
     * Writes out whatever is queued (waiting at most timeoutMs; 0 = don't wait), then disconnects for good. Safe to
     * call twice.
     */
    public void stop(long timeoutMs) {
        running = false;
        Thread t = thread;
        if (t == null) return;
        t.interrupt();
        try {
            if (timeoutMs > 0) t.join(timeoutMs); // join(0) would wait forever
        } catch (InterruptedException e) {
            Thread.currentThread()
                .interrupt();
        }
        closeQuietly(socket);
    }

    private void run() {
        long backoff = minBackoffMs;
        while (running) {
            try (Socket s = new Socket()) {
                socket = s;
                s.connect(new InetSocketAddress(host, port), 5000);
                Writer out = new BufferedWriter(new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8));
                BufferedReader in = new BufferedReader(
                    new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                writeLine(out, hello.toString());
                JsonObject reply = parse(in.readLine());
                if (reply != null && "welcome".equals(str(reply, "type"))) {
                    connected = true;
                    backoff = minBackoffMs;
                    LOG.info("Connected to hub at {}:{}", host, port);
                    Thread reader = new Thread(() -> readLoop(s, in), "GTNHDiscord-hub-reader");
                    reader.setDaemon(true);
                    reader.start();
                    writeLoop(s, out);
                } else {
                    LOG.error("Hub refused connection: {}", reply == null ? "no reply" : str(reply, "reason"));
                    backoff = maxBackoffMs;
                }
            } catch (IOException e) {
                if (running) LOG.warn("Hub connection failed: {}", e.getMessage());
            } finally {
                connected = false;
            }
            if (!running) return;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                return;
            }
            backoff = Math.min(backoff * 2, maxBackoffMs);
        }
    }

    private void writeLoop(Socket s, Writer out) throws IOException {
        while (running && !s.isClosed()) {
            String line;
            try {
                line = outbox.pollFirst(200, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                continue; // stop() interrupts us; the loop condition sees running == false
            }
            if (line != null) writeLine(out, line);
        }
        if (s.isClosed()) throw new IOException("connection closed by hub");
        String line;
        while ((line = outbox.pollFirst()) != null) writeLine(out, line); // stopping: flush what's left
    }

    private void readLoop(Socket s, BufferedReader in) {
        try {
            String line;
            while ((line = in.readLine()) != null) {
                JsonObject msg = parse(line);
                if (msg != null) inbox.add(msg);
            }
        } catch (IOException ignored) {} finally {
            closeQuietly(s);
        }
    }

    private static void writeLine(Writer out, String line) throws IOException {
        out.write(line);
        out.write('\n');
        out.flush();
    }

    static JsonObject parse(String line) {
        if (line == null) return null;
        try {
            JsonElement e = new JsonParser().parse(line);
            return e.isJsonObject() ? e.getAsJsonObject() : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    static String str(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e != null && e.isJsonPrimitive() ? e.getAsString() : "";
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {}
    }
}
```

- [ ] **Step 4: Verify**

Run:
```bash
cd mod && ./gradlew --console=plain spotlessApply test
grep -ho 'tests="[0-9]*" skipped="[0-9]*" failures="[0-9]*" errors="[0-9]*"' build/test-results/test/*.xml
```
Expected: `BUILD SUCCESSFUL` and `tests="7" skipped="0" failures="0" errors="0"`.

- [ ] **Step 5: Commit**

```bash
git add mod/src
git commit -m "feat(mod): HubClient with reconnect, bounded outbox and flush-on-stop"
```

---

### Task 8: Mod entry point and game events

**Files:**
- Create: `mod/src/main/java/io/github/edwardpratt/gtnhdiscord/GameEvents.java`, `mod/src/main/java/io/github/edwardpratt/gtnhdiscord/GtnhDiscord.java`

**Interfaces:**
- Consumes: `HubClient` (Task 7), `Tags.VERSION` (generated, Task 6).
- Produces: `GtnhDiscord.LOG`; `GameEvents.msg(String type, String... keyValues)`. The mod reads `config/gtnhdiscord.cfg` (`hubHost`, `hubPort`, `serverId`, `token`).

These classes are glue around Minecraft and can only be exercised on a real server (Task 9). The checks here are compilation against the real 1.7.10 sources plus a bytecode inspection that the obfuscated names were remapped. Every MC/Forge name used below was verified against the decompiled 1.7.10 sources. The `func_*` names are the correct dev-environment names because MCP stable-12 has no readable mapping for them.

- [ ] **Step 1: Write the event handlers**

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/GameEvents.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.network.rcon.RConConsoleSource;
import net.minecraft.server.MinecraftServer;
import net.minecraft.stats.StatisticsFile;
import net.minecraft.util.ChatComponentText;
import net.minecraft.util.ChatStyle;
import net.minecraft.util.EnumChatFormatting;
import net.minecraft.util.IChatComponent;
import net.minecraft.util.MathHelper;
import net.minecraftforge.event.ServerChatEvent;
import net.minecraftforge.event.entity.living.LivingDeathEvent;
import net.minecraftforge.event.entity.player.AchievementEvent;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.common.eventhandler.EventPriority;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.PlayerEvent;
import cpw.mods.fml.common.gameevent.TickEvent;

/**
 * Game-side half of the bridge. Registered on both buses by {@link GtnhDiscord}: chat/death/achievement are Forge-bus
 * events, login/logout/tick are FML-bus events. Everything here runs on the server thread.
 */
public class GameEvents {

    private static final long HEARTBEAT_MS = 5000;

    private final HubClient client;
    private long lastHeartbeat;

    GameEvents(HubClient client) {
        this.client = client;
    }

    static JsonObject msg(String type, String... keyValues) {
        JsonObject o = new JsonObject();
        o.addProperty("type", type);
        for (int i = 0; i + 1 < keyValues.length; i += 2) o.addProperty(keyValues[i], keyValues[i + 1]);
        return o;
    }

    // LOWEST priority + canceled events not received: muted chat and prevented deaths are not relayed.
    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onChat(ServerChatEvent e) {
        client.send(msg("chat", "player", e.username, "message", e.message));
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onDeath(LivingDeathEvent e) {
        if (!(e.entityLiving instanceof EntityPlayerMP)) return;
        EntityPlayerMP player = (EntityPlayerMP) e.entityLiving;
        // Same call vanilla EntityPlayerMP.onDeath uses for the death broadcast.
        String text = player.func_110142_aN()
            .func_151521_b()
            .getUnformattedText();
        client.send(msg("death", "player", player.getCommandSenderName(), "message", text));
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onAchievement(AchievementEvent e) {
        if (!(e.entityPlayer instanceof EntityPlayerMP)) return;
        // Fires on every trigger; only report a real first unlock.
        StatisticsFile stats = ((EntityPlayerMP) e.entityPlayer).func_147099_x();
        if (stats.hasAchievementUnlocked(e.achievement) || !stats.canUnlockAchievement(e.achievement)) return;
        String name = e.achievement.func_150951_e()
            .getUnformattedText();
        client.send(msg("achievement", "player", e.entityPlayer.getCommandSenderName(), "achievement", name));
    }

    @SubscribeEvent
    public void onLogin(PlayerEvent.PlayerLoggedInEvent e) {
        client.send(msg("join", "player", e.player.getCommandSenderName()));
    }

    @SubscribeEvent
    public void onLogout(PlayerEvent.PlayerLoggedOutEvent e) {
        client.send(msg("leave", "player", e.player.getCommandSenderName()));
    }

    @SubscribeEvent
    public void onTick(TickEvent.ServerTickEvent e) {
        if (e.phase != TickEvent.Phase.END) return;
        try {
            MinecraftServer server = MinecraftServer.getServer();
            JsonObject in;
            while ((in = client.poll()) != null) handle(server, in);
            // Sent from the tick so that a frozen tick loop stops heartbeats (that is how the hub spots a hang).
            long now = System.currentTimeMillis();
            if (now - lastHeartbeat >= HEARTBEAT_MS) {
                lastHeartbeat = now;
                client.send(heartbeat(server));
            }
        } catch (RuntimeException ex) {
            GtnhDiscord.LOG.error("Discord bridge tick failed", ex);
        }
    }

    private void handle(MinecraftServer server, JsonObject in) {
        String type = HubClient.str(in, "type");
        if (type.equals("say")) {
            IChatComponent line = new ChatComponentText("");
            line.appendSibling(
                new ChatComponentText("[Discord] ").setChatStyle(new ChatStyle().setColor(EnumChatFormatting.BLUE)));
            line.appendSibling(
                new ChatComponentText("<" + HubClient.str(in, "author") + "> " + HubClient.str(in, "message")));
            server.getConfigurationManager()
                .sendChatMsg(line);
        } else if (type.equals("cmd")) {
            final List<String> output = new ArrayList<>();
            // Vanilla's RCON sender: op-level, real world and coordinates. We only capture its replies per line.
            RConConsoleSource sender = new RConConsoleSource() {

                @Override
                public String getCommandSenderName() {
                    return "Discord";
                }

                @Override
                public void addChatMessage(IChatComponent message) {
                    output.add(message.getUnformattedText());
                }
            };
            server.getCommandManager()
                .executeCommand(sender, HubClient.str(in, "command"));
            JsonObject result = msg("cmdResult", "id", HubClient.str(in, "id"));
            JsonArray lines = new JsonArray();
            for (String s : output) lines.add(new JsonPrimitive(s));
            result.add("output", lines);
            client.send(result);
        }
    }

    private static JsonObject heartbeat(MinecraftServer server) {
        double msPerTick = MathHelper.average(server.tickTimeArray) * 1.0E-6D; // tickTimeArray is nanoseconds
        JsonObject o = msg("heartbeat");
        o.addProperty("tps", Math.min(20.0, 1000.0 / Math.max(msPerTick, 0.001)));
        JsonArray players = new JsonArray();
        for (String name : server.getAllUsernames()) players.add(new JsonPrimitive(name));
        o.add("players", players);
        return o;
    }
}
```

- [ ] **Step 2: Write the mod entry point**

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/GtnhDiscord.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.common.config.Configuration;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.Mod;
import cpw.mods.fml.common.event.FMLPreInitializationEvent;
import cpw.mods.fml.common.event.FMLServerStartedEvent;
import cpw.mods.fml.common.event.FMLServerStartingEvent;
import cpw.mods.fml.common.event.FMLServerStoppedEvent;
import cpw.mods.fml.common.event.FMLServerStoppingEvent;

@Mod(
    modid = GtnhDiscord.MODID,
    version = Tags.VERSION,
    name = "GTNH Discord",
    acceptedMinecraftVersions = "[1.7.10]",
    acceptableRemoteVersions = "*")
public class GtnhDiscord {

    public static final String MODID = "gtnhdiscord";
    public static final Logger LOG = LogManager.getLogger(MODID);

    private String hubHost;
    private int hubPort;
    private String serverId;
    private String token;
    private HubClient client;
    private GameEvents events;

    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        Configuration config = new Configuration(event.getSuggestedConfigurationFile());
        String general = Configuration.CATEGORY_GENERAL;
        hubHost = config.getString("hubHost", general, "127.0.0.1", "Address of the gtnh-discord hub");
        hubPort = config.getInt("hubPort", general, 25580, 1, 65535, "TCP port of the hub");
        serverId = config.getString("serverId", general, "gtnh", "This server's id in the hub's config.json");
        token = config.getString("token", general, "", "This server's token from the hub's config.json");
        if (config.hasChanged()) config.save();
    }

    @Mod.EventHandler
    public void serverStarting(FMLServerStartingEvent event) {
        if (!event.getServer()
            .isDedicatedServer()) return;
        if (token.isEmpty()) {
            LOG.warn("No token set in config/gtnhdiscord.cfg - Discord bridge disabled");
            return;
        }
        client = new HubClient(hubHost, hubPort, serverId, token, Tags.VERSION);
        events = new GameEvents(client);
        MinecraftForge.EVENT_BUS.register(events);
        FMLCommonHandler.instance()
            .bus()
            .register(events);
        client.start();
    }

    @Mod.EventHandler
    public void serverStarted(FMLServerStartedEvent event) {
        if (client != null) client.send(GameEvents.msg("started"));
    }

    @Mod.EventHandler
    public void serverStopping(FMLServerStoppingEvent event) {
        if (client == null) return;
        client.send(GameEvents.msg("stopping"));
        client.stop(2000); // flush before the JVM can exit, so a clean stop never looks like a crash
    }

    @Mod.EventHandler
    public void serverStopped(FMLServerStoppedEvent event) {
        if (client == null) return;
        client.stop(0); // no-op after a clean stop; after a crash, drops the connection right away
        MinecraftForge.EVENT_BUS.unregister(events);
        FMLCommonHandler.instance()
            .bus()
            .unregister(events);
        client = null;
        events = null;
    }
}
```

- [ ] **Step 3: Build and inspect the jar**

Run:
```bash
cd mod && ./gradlew --console=plain spotlessApply build
jar=$(ls -t build/libs/gtnhdiscord-*.jar | grep -v -e '-dev' -e '-sources' | head -1)   # newest; older builds leave other versions behind
unzip -l "$jar" | grep -E 'class|mcmod'
javap -v -cp "$jar" io.github.edwardpratt.gtnhdiscord.HubClient | grep 'major version'
javap -cp "$jar" 'io.github.edwardpratt.gtnhdiscord.GameEvents$1'
```
Expected:
- `BUILD SUCCESSFUL`.
- The jar lists `GameEvents.class`, `GameEvents$1.class`, `GtnhDiscord.class`, `HubClient.class`, `Tags.class` and `mcmod.info`.
- `major version: 52` (Java 8).
- `GameEvents$1` shows the SRG names `func_70005_c_()` and `func_145747_a(...)`. This proves the reobfuscation step remapped `getCommandSenderName`/`addChatMessage`, so the override works on a real server.

- [ ] **Step 4: Commit**

```bash
git add mod/src
git commit -m "feat(mod): relay game events, run commands, heartbeat from the tick"
```

---

### Task 9: README and end-to-end smoke test

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

`README.md`:

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
| `hub/` | The bot. Owns server state and uptime, talks to Discord. | Node 26 |
| `docs/` | Design spec and implementation plan. | — |

## Setup

### 1. Discord application

1. <https://discord.com/developers/applications> → **New Application** → **Bot**.
   Copy the bot token.
2. On the **Bot** page enable **Message Content Intent**. Without it the bot
   receives empty messages and Discord → game chat does nothing.
3. **OAuth2 → URL Generator**: scopes `bot` and `applications.commands`;
   permissions *View Channels*, *Send Messages*, *Read Message History*.
   Open the URL and add the bot to your Discord server.
4. In Discord, enable *Settings → Advanced → Developer Mode*, then right-click
   to **Copy ID** of: your Discord server (guild), the channel for each game
   server, and the role allowed to use `/cmd`.

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

`config.json` and `.env` are git-ignored. To keep it running, a systemd user
unit (`~/.config/systemd/user/gtnh-discord.service`):

```ini
[Unit]
Description=GTNH Discord hub
After=network-online.target

[Service]
WorkingDirectory=/path/to/gtnh-discord/hub
EnvironmentFile=/path/to/gtnh-discord/hub/.env
ExecStart=/usr/bin/node src/index.ts
Restart=on-failure

[Install]
WantedBy=default.target
```

`systemctl --user enable --now gtnh-discord` (and `loginctl enable-linger $USER`
so it runs without you logged in).

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

## Using it

- Chat in the linked channel appears in game as `[Discord] <name> message`.
  In-game chat, joins, leaves, deaths and achievements post to the channel.
- `/status` shows online state, TPS, player count and 24 h / 7 d uptime.
- `/list` shows online players.
- `/cmd <command>` runs a console command and shows its output. Only members
  with the admin role can use it. Every command is logged by the hub.
- Alerts: started, stopped, went down unexpectedly (crash or kill), not
  responding (no heartbeat for 30 s), responding again.

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

- [ ] **Step 2: Final automated checks**

Run: `cd hub && npm ci && npm test && npm run typecheck && cd ../mod && ./gradlew --console=plain spotlessApply build`
Expected: hub `ℹ fail 0`, `tsc` silent, mod `BUILD SUCCESSFUL`. Also confirm `git status` shows no stray files (e.g. `hub/hub.db`, `hub/config.json`).

- [ ] **Step 3: Commit and push**

```bash
git add README.md
git commit -m "docs: README with setup and usage"
git push
```

- [ ] **Step 4: Manual end-to-end test on the real GTNH server (with the user)**

The user must do this part, because it needs their Discord bot token and their server. Walk through README setup steps 1–3, then check each item and record the result:

1. Server start → the channel shows "✅ Server started". `/status` shows 🟢, a TPS near 20 and uptime.
2. In-game chat, join, leave, a death (e.g. `/kill`), and a first-time achievement each appear in the channel. Opening the inventory again must **not** re-post "Taking Inventory".
3. Discord message → shows in game as a blue `[Discord]` prefix, then `<name> text`. A message containing `@everyone` pings nobody in Discord.
4. `/cmd list` by an admin-role member shows the player list. By a non-admin it's refused (ephemeral). `/cmd forge tps` output comes back in a code block.
5. `/stop` in game → "🛑 Server stopped" (not "went down unexpectedly").
6. Start the server, then `kill -9` its Java process → "💥 Server went down unexpectedly". Start it again and stop it with SIGTERM (`kill <pid>` / `systemctl stop` / Ctrl+C in its console) → "🛑 Server stopped" (may follow a burst of "left" posts).
7. Restart the hub while the server runs → no alert is posted, and `/status` shows it online again within a few seconds.

Anything that fails here is a bug. Fix it with superpowers:systematic-debugging before calling v1 done.

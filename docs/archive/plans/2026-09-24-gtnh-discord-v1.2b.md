# GTNH Discord v1.2b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adds five things on top of v1.2a, all shipping in the same release:
- per-dimension tick times, lag alerts and `/tps`;
- BetterQuesting quest announcements (main quests at once, the rest batched);
- account linking with `/link` and `/discord link <code>`;
- exact backup events from ServerUtilities' log;
- late `/cmd` output posted as follow-ups.

**Architecture:** The protocol stays v1: every new message is additive, and both sides ignore types they don't know. There are three new hub-core modules:
- `lag.ts`
- `quests.ts`
- `links.ts`

`db.ts` gains the `tps` and `links` tables. The mod gains:
- a BetterQuesting listener, loaded only when BetterQuesting is installed;
- a log4j appender on ServerUtilities' logger;
- the `/discord` command;
- a late phase for `/cmd` output;
- `dims` in the heartbeat.

**Tech Stack:** as for v1.2a, plus a `compileOnly` BetterQuesting dev jar (`com.github.GTNewHorizons:BetterQuesting:3.8.87-GTNH:dev`) and log4j2 (bundled with Minecraft).

**Spec:** `docs/superpowers/specs/2026-09-24-gtnh-discord-v1.2b-design.md` (the v1, v1.1 and v1.2a specs still apply)

**Precondition:** the v1.2a plan (`docs/superpowers/plans/2026-09-24-gtnh-discord-v1.2a.md`) is fully implemented on this branch: the hub suite is at 86 tests and the mod has CommandOutput and flushPending.

## Global Constraints

- The protocol stays `1`. New message types and fields are additive only.
- Hub runs with `node src/index.ts` (Node type stripping). Use erasable TypeScript only. Relative imports end in `.ts`.
- Hub dependencies stay exactly `discord.js` (runtime), plus `typescript` and `@types/node` (dev).
- Hub-core modules (`servers`, `db`, `restarts`, `daily`, `units`, `playtime`, `summary`, `backups`, `crashlogs`, `lag`, `quests`, `links`) must not import `discord.js` or `format.ts`.
- Every Discord call and filesystem scan is best-effort. Database writes never throw. Mod handlers never throw into the game loop.
- Mod code must run on Java 8 (Gson 2.2.4, log4j 2.0-beta9). **Event-listener classes are `public`**, because FML's event bus generates their caller in another package. BetterQuesting is `compileOnly` and touched only by `QuestEvents`.
- Always run `./gradlew spotlessApply` before `build`. The hub must pass on Node 24 and 26.
- Every commit message ends with these trailer lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019KzyhKnrr3Gj8zCrcVtthm
  ```

## Review Focus

These need the real server, so they're pinned by the Task 7 manual checklist:

1. **Quest names on the real GTNH server.** Names come from the server's translation table. If every post says "a quest", GTNH's quest names aren't in it, and the lang source needs another look.
2. **The server's BetterQuesting version.** Compare `ls mods | grep -i betterquesting` with 3.8.87. If the mod logs a `NoSuchFieldError`/`NoSuchMethodError` from `QuestEvents`, change `dependencies.gradle` to the server's version and rebuild.
3. **The appender sees ServerUtilities' log lines.** The next scheduled backup posts "✅ Backup finished (… seconds (…))". If it doesn't, check the logger name (`Server Utilities`) against the server's log.
4. **`/discord` clashes with another mod's command.** If `/discord link` runs someone else's command, rename ours in `DiscordCommand.getCommandName`.
5. **Linking end to end.** `/link`, then `/discord link CODE` in game → green "[Discord] Linked to …". The channel shows "🔗 … linked to @you" with no ping, and your Discord chat appears in game under your Minecraft name.

---

### Task 1: Protocol messages and ServerHub routing

**Files:**
- Modify: `hub/src/protocol.ts` (new message types, and the `boolean`, `dims?` and `quests` field kinds)
- Modify: `hub/src/servers.ts` (`ServerState.dims`, the new game events, `sendLinkResult`, `runCommand(…, onLate?)`, `cmdLate` routing)
- Modify: `hub/src/format.ts`: one edit, so `formatEvent` handles the new event types
- Test: `hub/test/protocol.test.ts`, `hub/test/servers.test.ts`; fixture updates in `hub/test/format.test.ts` and `hub/test/playtime.test.ts`

**Interfaces:**
- Produces:
  - `DimTime = { id, name, ms }` and `QuestDone = { name, main }`
  - `ModMsg` gains `quest`, `link`, `unlink`, `backup` and `cmdLate`; `HubMsg` gains `linkResult`
  - `ServerState.dims: DimTime[]`
  - `HubEvent` includes `quest`/`link`/`unlink`/`backup`
  - `ServerHub.sendLinkResult(id, player, ok, message): boolean`
  - `ServerHub.runCommand(id, command, by, onLate?)`
  - `HubOptions.lateMs`

- [ ] **Step 1: Write the failing tests**

`hub/test/protocol.test.ts`, the full file (two new tests at the end):

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

test('heartbeat dims are optional but validated', () => {
  assert.ok(parseModLine('{"type":"heartbeat","tps":20,"players":[]}'));
  const dims = [{ id: 0, name: 'Overworld', ms: 12.5 }];
  assert.deepEqual(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims })), {
    type: 'heartbeat',
    tps: 20,
    players: [],
    dims,
  });
  const six = Array(6).fill(dims[0]);
  assert.equal(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims: six })), null);
  assert.equal(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims: [{ id: 0, name: '', ms: 1 }] })), null);
  assert.equal(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims: 'x' })), null);
});

test('v1.2b messages validate every field', () => {
  assert.ok(parseModLine('{"type":"quest","player":"Steve","quests":[{"name":"Stone Age","main":true}]}'));
  assert.equal(parseModLine('{"type":"quest","player":"Steve","quests":[]}'), null);
  assert.equal(parseModLine('{"type":"quest","player":"Steve","quests":[{"name":"x","main":"yes"}]}'), null);
  assert.ok(parseModLine('{"type":"link","player":"Steve","uuid":"u","code":"ABC234"}'));
  assert.equal(parseModLine('{"type":"link","player":"Steve","code":"ABC234"}'), null);
  assert.ok(parseModLine('{"type":"unlink","player":"Steve"}'));
  assert.ok(parseModLine('{"type":"backup","ok":false,"detail":"disk full"}'));
  assert.equal(parseModLine('{"type":"backup","ok":"false","detail":"x"}'), null);
  assert.ok(parseModLine('{"type":"cmdLate","id":"1","output":["a"]}'));
  assert.ok(parseModLine('{"type":"unlink","player":"Steve","extra":1}')); // extra fields are ignored
});
```

`hub/test/servers.test.ts`, the full file (three new tests at the end):

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

test('v1.2b game messages become events; heartbeat dims land in the state', async (t) => {
  const { hub, port, events } = await setup(t);
  const mod = await online(port);
  mod.send({ type: 'heartbeat', tps: 18, players: [], dims: [{ id: -1, name: 'Nether', ms: 60 }] });
  mod.send({ type: 'quest', player: 'Steve', quests: [{ name: 'Stone Age', main: true }] });
  mod.send({ type: 'link', player: 'Steve', uuid: 'u-1', code: 'ABC234' });
  mod.send({ type: 'backup', ok: true, detail: '12.3 seconds (1.2GB)' });
  await until(() => events.length === 4);
  assert.deepEqual(hub.get('gtnh')?.dims, [{ id: -1, name: 'Nether', ms: 60 }]);
  assert.deepEqual(
    events.slice(1).map((e) => e.type),
    ['quest', 'link', 'backup'],
  );
});

test('sendLinkResult reaches the mod', async (t) => {
  const { hub, port } = await setup(t);
  assert.equal(hub.sendLinkResult('gtnh', 'Steve', true, 'Linked'), false); // offline
  const mod = await online(port);
  assert.equal(hub.sendLinkResult('gtnh', 'Steve', true, 'Linked'), true);
  assert.deepEqual(await mod.next(), { type: 'linkResult', player: 'Steve', ok: true, message: 'Linked' });
});

test('late command output reaches onLate until it expires', async (t) => {
  const { hub, port } = await setup(t, { lateMs: 150 });
  const mod = await online(port);
  const late: string[][] = [];
  const result = hub.runCommand('gtnh', 'spark profiler', 'test', (lines) => late.push(lines));
  const cmd = (await mod.next()) as { id: string };
  mod.send({ type: 'cmdResult', id: cmd.id, output: ['Profiler started'] });
  assert.deepEqual(await result, ['Profiler started']);
  mod.send({ type: 'cmdLate', id: cmd.id, output: ['https://spark.lucko.me/abc'] });
  mod.send({ type: 'cmdLate', id: 'unknown', output: ['ignored'] });
  await until(() => late.length === 1);
  await sleep(250);
  mod.send({ type: 'cmdLate', id: cmd.id, output: ['too late'] });
  await sleep(50);
  assert.deepEqual(late, [['https://spark.lucko.me/abc']]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd hub && npm test`
Expected: FAIL. The `heartbeat dims…` test fails on the 6-dimension case, `v1.2b messages…` returns null for `quest`, `sendLinkResult` is not a function, and `late command output…` never receives `onLate`.

- [ ] **Step 3: Implement**

`hub/src/protocol.ts`:

```ts
// Wire contract between the mod and the hub: one JSON object per line.
export const PROTOCOL_VERSION = 1;

export type Hello = { type: 'hello'; protocol: number; serverId: string; token: string; modVersion: string };

export type ModMsg =
  | { type: 'started' }
  | { type: 'stopping' }
  | { type: 'heartbeat'; tps: number; players: string[]; dims?: DimTime[] }
  | { type: 'chat'; player: string; message: string }
  | { type: 'join'; player: string }
  | { type: 'leave'; player: string }
  | { type: 'death'; player: string; message: string }
  | { type: 'achievement'; player: string; achievement: string }
  | { type: 'cmdResult'; id: string; output: string[] }
  | { type: 'cmdLate'; id: string; output: string[] }
  | { type: 'quest'; player: string; quests: QuestDone[] }
  | { type: 'link'; player: string; uuid: string; code: string }
  | { type: 'unlink'; player: string }
  | { type: 'backup'; ok: boolean; detail: string };

/** A dimension's mean tick time. */
export type DimTime = { id: number; name: string; ms: number };
/** A completed quest. */
export type QuestDone = { name: string; main: boolean };

export type HubMsg =
  | { type: 'welcome' }
  | { type: 'reject'; reason: string }
  | { type: 'say'; author: string; message: string }
  | { type: 'cmd'; id: string; command: string }
  | { type: 'linkResult'; player: string; ok: boolean; message: string };

type Kind = 'string' | 'number' | 'boolean' | 'string[]' | 'dims?' | 'quests';

const SCHEMAS: Record<string, Record<string, Kind>> = {
  hello: { protocol: 'number', serverId: 'string', token: 'string', modVersion: 'string' },
  started: {},
  stopping: {},
  heartbeat: { tps: 'number', players: 'string[]', dims: 'dims?' },
  chat: { player: 'string', message: 'string' },
  join: { player: 'string' },
  leave: { player: 'string' },
  death: { player: 'string', message: 'string' },
  achievement: { player: 'string', achievement: 'string' },
  cmdResult: { id: 'string', output: 'string[]' },
  cmdLate: { id: 'string', output: 'string[]' },
  quest: { player: 'string', quests: 'quests' },
  link: { player: 'string', uuid: 'string', code: 'string' },
  unlink: { player: 'string' },
  backup: { ok: 'boolean', detail: 'string' },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string' && v.length > 0;
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

function hasKind(value: unknown, kind: Kind): boolean {
  switch (kind) {
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'number':
      return finite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'dims?': // optional: older mods don't send it
      return (
        value === undefined ||
        (Array.isArray(value) &&
          value.length <= 5 &&
          value.every((d) => isObject(d) && finite(d.id) && text(d.name) && finite(d.ms)))
      );
    case 'quests':
      return (
        Array.isArray(value) &&
        value.length >= 1 &&
        value.length <= 50 &&
        value.every((q) => isObject(q) && text(q.name) && typeof q.main === 'boolean')
      );
    case 'string':
      return typeof value === 'string';
  }
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

`hub/src/servers.ts`:

```ts
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { PROTOCOL_VERSION, parseModLine, type DimTime, type Hello, type HubMsg, type ModMsg } from './protocol.ts';

export type ServerConfig = { id: string; name: string; token: string };

export type ServerState = {
  id: string;
  name: string;
  online: boolean;
  hung: boolean;
  tps: number | null;
  players: string[];
  /** Slowest dimensions from the latest heartbeat (empty with an older mod). */
  dims: DimTime[];
};

export type Lifecycle = 'connected' | 'started' | 'stopped' | 'crashed' | 'hung' | 'recovered' | 'offline';
export type GameMsg = Extract<
  ModMsg,
  { type: 'chat' | 'join' | 'leave' | 'death' | 'achievement' | 'quest' | 'link' | 'unlink' | 'backup' }
>;
export type HubEvent = { serverId: string } & (GameMsg | { type: Lifecycle });

export type HubOptions = { hungMs?: number; cmdTimeoutMs?: number; helloTimeoutMs?: number; graceMs?: number; lateMs?: number };

type Late = { onLate: (output: string[]) => void; timer: NodeJS.Timeout };

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
  #lateMs: number;
  #late = new Map<string, Late>(); // command id -> handler for output that arrives after the result
  #helloTimeoutMs: number;
  #graceMs: number;

  constructor(servers: ServerConfig[], opts: HubOptions = {}) {
    super();
    for (const s of servers) {
      if (s.token.length < 16) throw new Error(`server "${s.id}": token must be at least 16 characters`);
      this.#configs.set(s.id, s);
      this.#states.set(s.id, { id: s.id, name: s.name, online: false, hung: false, tps: null, players: [], dims: [] });
    }
    this.#hungMs = opts.hungMs ?? 30_000;
    this.#cmdTimeoutMs = opts.cmdTimeoutMs ?? 10_000;
    this.#lateMs = opts.lateMs ?? 15 * 60_000; // Discord allows interaction follow-ups for 15 minutes
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
    this.#send(conn.socket, { type: 'say', author: mcText(author, 32) || '?', message: text });
    return true;
  }

  /** Tells a player in game how their `/discord link` or `unlink` went. False if the server is offline. */
  sendLinkResult(id: string, player: string, ok: boolean, message: string): boolean {
    const conn = this.#conns.get(id);
    if (!conn) return false;
    this.#send(conn.socket, { type: 'linkResult', player, ok, message });
    return true;
  }

  /**
   * Runs a console command. `by` names who asked, for the audit log. `onLate` gets output that arrives after
   * the result (e.g. spark's profiler link), for 15 minutes.
   */
  runCommand(id: string, command: string, by: string, onLate?: (output: string[]) => void): Promise<string[]> {
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
      conn.pending.set(cmdId, {
        resolve: (output) => {
          if (onLate) this.#late.set(cmdId, { onLate, timer: setTimeout(() => this.#late.delete(cmdId), this.#lateMs) });
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
      Object.assign(this.#states.get(id)!, { online: false, hung: false, tps: null, players: [], dims: [] });
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
        try {
          late.onLate(msg.output);
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
```

Then make `formatEvent` handle the new event types, and add `dims` to the test fixtures (`ServerState` now requires it):

```bash
cd hub && python3 - <<'EOF'
def edit(p, old, new):
    s = open(p).read()
    assert s.count(old) == 1, (p, old)
    open(p, 'w').write(s.replace(old, new))

edit('src/format.ts',
     "    case 'offline': // hub-start bookkeeping for uptime, not news\n      return null;",
     "    case 'offline': // hub-start bookkeeping for uptime, not news\n"
     "    case 'quest': // batched by the QuestAnnouncer\n"
     "    case 'link': // answered by Links\n"
     "    case 'unlink':\n"
     "    case 'backup': // posted as a notice\n"
     "      return null;")
edit('test/format.test.ts',
     "tps: 19.96, players: ['a_b', 'c'] };",
     "tps: 19.96, players: ['a_b', 'c'], dims: [] };")
edit('test/format.test.ts',
     "online: true, hung: false, tps: 19.7, players: ['Steve', 'Alex'] };",
     "online: true, hung: false, tps: 19.7, players: ['Steve', 'Alex'], dims: [] };")
edit('test/playtime.test.ts',
     "{ id: 's', name: 'S', online, hung: false, tps: 20, players },",
     "{ id: 's', name: 'S', online, hung: false, tps: 20, players, dims: [] },")
EOF
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 91`, `ℹ fail 0`, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add hub/src/protocol.ts hub/src/servers.ts hub/src/format.ts hub/test/protocol.test.ts hub/test/servers.test.ts hub/test/format.test.ts hub/test/playtime.test.ts
git commit -m "feat(hub): v1.2b messages (dims, quest, link, backup, cmdLate), link results, late command output"
```

---

### Task 2: TPS history and lag alerts

**Files:**
- Modify: `hub/src/db.ts` (the `tps` and `links` tables and their queries)
- Create: `hub/src/lag.ts`
- Test: `hub/test/db.test.ts`, `hub/test/lag.test.ts`

**Interfaces:**
- Consumes: `ServerState.dims` (Task 1).
- Produces:
  - `Db`:
    - TPS: `recordTps(serverId, ts, tps, worstName, worstMs)`, `tpsSince(serverId, from)`, `tpsStats(serverId, from, to) → { avg, min } | null`
    - links: `link(discordId, player, uuid, ts)`, `unlinkDiscord(id): boolean`, `unlinkPlayer(player): boolean`, `linkByDiscord(id)`, `linkByPlayer(player)`
  - `LagConfig`, `DEFAULT_LAG`, and `sparkline(values, max = 20)`
  - `LagMonitor(hub, db, configs, notify)` with `.sample(now)`, `.start()` and `.stop()`

- [ ] **Step 1: Write the failing tests**

`hub/test/db.test.ts`, the full file (the `tps samples` test is at the end):

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

test('playtime counts only the overlap with the window, open sessions until now, names case-insensitively', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'Steve', 1000);
  db.closeSession('s', 'Steve', 5000);
  db.openSession('s', 'Steve', 8000); // still online
  assert.equal(db.playtime('s', 'steve', 0, 10_000, 10_000), 4000 + 2000);
  assert.equal(db.playtime('s', 'Steve', 2000, 4000, 10_000), 2000);
  assert.equal(db.playtime('s', 'Steve', 6000, 7000, 10_000), 0);
  assert.equal(db.playtime('other', 'Steve', 0, 10_000, 10_000), 0);
  db.close();
});

test('lastSeen: online, last session end, or never', () => {
  const db = new Db(':memory:');
  assert.equal(db.lastSeen('s', 'Alex'), null);
  db.openSession('s', 'Alex', 1000);
  assert.deepEqual(db.lastSeen('s', 'alex'), { online: true });
  db.closeSession('s', 'Alex', 3000);
  assert.equal(db.lastSeen('s', 'Alex'), 3000);
  db.close();
});

test('top ranks players by playtime in the window', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'A', 0);
  db.closeSession('s', 'A', 1000);
  db.openSession('s', 'B', 0);
  db.closeSession('s', 'B', 3000);
  db.openSession('s', 'C', 5000);
  db.closeSession('s', 'C', 6000);
  assert.deepEqual(db.top('s', 0, 4000, 10), [
    { player: 'B', ms: 3000 },
    { player: 'A', ms: 1000 },
  ]);
  assert.equal(db.top('s', 0, 10_000, 1).length, 1);
  db.close();
});

test('peaks keep the daily maximum; countEvents counts reasons in a window', () => {
  const db = new Db(':memory:');
  db.recordPeak('s', '2026-09-24', 3);
  db.recordPeak('s', '2026-09-24', 5);
  db.recordPeak('s', '2026-09-24', 2);
  assert.equal(db.peak('s', '2026-09-24'), 5);
  assert.equal(db.peak('s', '2026-09-25'), null);
  db.record('s', 'up', 'started', 100);
  db.record('s', 'down', 'crashed', 200);
  db.record('s', 'up', 'started', 300);
  assert.equal(db.countEvents('s', 'started', 0, 1000), 2);
  assert.equal(db.countEvents('s', 'crashed', 250, 1000), 0);
  db.close();
});

test('markHubRestart ends open sessions at the last stamp, not across the outage', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'Steve', 1000);
  db.touch(2000); // hub last alive
  db.markHubRestart(['s'], 100_000); // hub back much later
  assert.equal(db.lastSeen('s', 'Steve'), 2000);
  assert.equal(db.playtime('s', 'Steve', 0, 100_000, 100_000), 1000);
  db.close();
});

test('session and peak writes never throw either', () => {
  const db = new Db(':memory:');
  db.close();
  assert.doesNotThrow(() => db.openSession('s', 'a', 1));
  assert.doesNotThrow(() => db.closeSession('s', 'a', 2));
  assert.doesNotThrow(() => db.recordPeak('s', '2026-09-24', 1));
});

test('tps samples: since, average and minimum', () => {
  const db = new Db(':memory:');
  db.recordTps('s', 1000, 20, null, null);
  db.recordTps('s', 2000, 10, 'Nether', 90);
  db.recordTps('s', 3000, 15, 'Overworld', 40);
  assert.deepEqual(db.tpsSince('s', 2000), [
    { ts: 2000, tps: 10 },
    { ts: 3000, tps: 15 },
  ]);
  assert.deepEqual(db.tpsStats('s', 0, 3000), { avg: 15, min: 10 });
  assert.equal(db.tpsStats('s', 5000, 6000), null);
  db.close();
});
```

`hub/test/lag.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db } from '../src/db.ts';
import { LagMonitor, sparkline, type LagConfig } from '../src/lag.ts';
import type { ServerHub, ServerState } from '../src/servers.ts';

const MIN = 60_000;

function setup(configs: Record<string, LagConfig> = {}) {
  let state: ServerState = { id: 's', name: 'S', online: true, hung: false, tps: 20, players: [], dims: [] };
  const hub = { list: () => [state] } as unknown as Pick<ServerHub, 'list'>;
  const db = new Db(':memory:');
  const notices: string[] = [];
  const lag = new LagMonitor(hub, db, configs, (_id, text) => notices.push(text));
  let now = 1_000_000;
  const sample = (patch: Partial<ServerState>) => {
    state = { ...state, ...patch };
    lag.sample((now += MIN));
  };
  return { db, notices, sample };
}

const nether = [{ id: -1, name: 'Nether', ms: 72.4 }];

test('alerts after TPS stays low for the configured minutes, then once on recovery', () => {
  const { notices, sample } = setup();
  sample({ tps: 12.3, dims: nether });
  assert.deepEqual(notices, []); // one low minute isn't lag yet
  sample({ tps: 12.3, dims: nether });
  sample({ tps: 11, dims: nether }); // still lagging: no repeat
  assert.deepEqual(notices, ['🐢 Lag: 12.3 TPS; slowest: Nether (DIM -1) 72 ms/tick']);
  sample({ tps: 19.9 });
  sample({ tps: 20 });
  assert.deepEqual(notices.slice(1), ['✅ TPS back to normal (19.9)']);
});

test('a single normal sample resets the count', () => {
  const { notices, sample } = setup();
  sample({ tps: 10 });
  sample({ tps: 20 });
  sample({ tps: 10 });
  assert.deepEqual(notices, []);
});

test('offline or hung servers are neither sampled nor judged; lag state clears silently', () => {
  const { db, notices, sample } = setup();
  sample({ tps: 10 });
  sample({ tps: 10 }); // lag alert
  sample({ online: false, tps: null });
  sample({ online: true, hung: true, tps: 10 });
  sample({ hung: false, tps: 20 }); // back: no "back to normal", the outage had its own alerts
  assert.equal(notices.length, 1);
  assert.equal(db.tpsSince('s', 0).length, 3);
});

test('thresholds are per server and can be switched off', () => {
  const strict = setup({ s: { tps: 18, minutes: 1, enabled: true } });
  strict.sample({ tps: 17 });
  assert.equal(strict.notices.length, 1);
  const off = setup({ s: { tps: 15, minutes: 1, enabled: false } });
  off.sample({ tps: 5 });
  assert.deepEqual(off.notices, []);
  assert.equal(off.db.tpsSince('s', 0).length, 1); // still recorded for /tps
});

test('sparkline scales 0–20 TPS onto eight bars', () => {
  assert.equal(sparkline([0, 5, 10, 15, 20, 25, -1]), '▁▃▅▇██▁');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd hub && npm test`
Expected: FAIL. `db.test.ts` fails with `db.recordTps is not a function`, and `lag.test.ts` with `ERR_MODULE_NOT_FOUND`.

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

/** SQLite store: server up/down transitions (uptime) and player sessions (playtime). */
export class Db {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (server_id TEXT NOT NULL, ts INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_server_ts ON events (server_id, ts);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (server_id TEXT NOT NULL, player TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER);
      CREATE INDEX IF NOT EXISTS sessions_server_player ON sessions (server_id, player);
      CREATE TABLE IF NOT EXISTS peaks (server_id TEXT NOT NULL, day TEXT NOT NULL, peak INTEGER NOT NULL, PRIMARY KEY (server_id, day));
      CREATE TABLE IF NOT EXISTS tps (server_id TEXT NOT NULL, ts INTEGER NOT NULL, tps REAL NOT NULL, worst_name TEXT, worst_ms REAL);
      CREATE INDEX IF NOT EXISTS tps_server_ts ON tps (server_id, ts);
      CREATE TABLE IF NOT EXISTS links (discord_id TEXT PRIMARY KEY, player TEXT NOT NULL, uuid TEXT NOT NULL, linked_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS links_player ON links (player COLLATE NOCASE);
    `);
  }

  /** Writes never throw: a database error (disk full, locked) is logged instead of taking the hub down. */
  #write(label: string, sql: string, ...params: (string | number | null)[]): void {
    try {
      this.#db.prepare(sql).run(...params);
    } catch (err) {
      console.error(`[db] ${label} failed:`, (err as Error).message);
    }
  }

  record(serverId: string, state: State, reason: string, ts = Date.now()): void {
    this.#write('record', 'INSERT INTO events (server_id, ts, state, reason) VALUES (?, ?, ?, ?)', serverId, ts, state, reason);
    this.touch(ts); // the hub was alive at least until this event
  }

  /** Stamps the hub as alive. Call every minute. */
  touch(ts = Date.now()): void {
    this.#write(
      'touch',
      "INSERT INTO meta (key, value) VALUES ('last_alive', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ts,
    );
  }

  /**
   * Call once at hub startup: the time since the last touch is unknown for every server, and sessions still
   * open end at that last touch. Both use the old stamp, read before touch(now) replaces it.
   */
  markHubRestart(serverIds: string[], now = Date.now()): void {
    const last = this.#db.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get() as
      | { value: number }
      | undefined;
    this.#write('close sessions', 'UPDATE sessions SET end = ? WHERE end IS NULL', last?.value ?? now);
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

  countEvents(serverId: string, reason: string, from: number, to: number): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE server_id = ? AND reason = ? AND ts >= ? AND ts < ?')
      .get(serverId, reason, from, to) as { n: number };
    return row.n;
  }

  openSession(serverId: string, player: string, ts: number): void {
    this.#write('open session', 'INSERT INTO sessions (server_id, player, start, end) VALUES (?, ?, ?, NULL)', serverId, player, ts);
  }

  closeSession(serverId: string, player: string, ts: number): void {
    this.#write('close session', 'UPDATE sessions SET end = ? WHERE server_id = ? AND player = ? AND end IS NULL', ts, serverId, player);
  }

  /** Playtime in [from, to]; an open session counts until `now`. Names match case-insensitively. */
  playtime(serverId: string, player: string, from: number, to: number, now = Date.now()): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(MIN(COALESCE(end, ?1), ?2) - MAX(start, ?3)), 0) AS ms FROM sessions
         WHERE server_id = ?4 AND player = ?5 COLLATE NOCASE AND start < ?2 AND COALESCE(end, ?1) > ?3`,
      )
      .get(now, to, from, serverId, player) as { ms: number };
    return row.ms;
  }

  /** `{ online: true }` while a session is open, else the last session's end, or null if never seen. */
  lastSeen(serverId: string, player: string): { online: true } | number | null {
    const row = this.#db
      .prepare('SELECT MAX(end) AS last, SUM(end IS NULL) AS open FROM sessions WHERE server_id = ? AND player = ? COLLATE NOCASE')
      .get(serverId, player) as { last: number | null; open: number | null };
    if (row.open) return { online: true };
    return row.last;
  }

  /** Players by playtime in [from, to], most first. */
  top(serverId: string, from: number, to: number, limit: number, now = Date.now()): { player: string; ms: number }[] {
    return this.#db
      .prepare(
        `SELECT player, SUM(MIN(COALESCE(end, ?1), ?2) - MAX(start, ?3)) AS ms FROM sessions
         WHERE server_id = ?4 AND start < ?2 AND COALESCE(end, ?1) > ?3
         GROUP BY player COLLATE NOCASE ORDER BY ms DESC LIMIT ?5`,
      )
      .all(now, to, from, serverId, limit)
      .map((r) => ({ player: r.player as string, ms: r.ms as number })); // plain objects, not sqlite's null-prototype rows
  }

  /** Keeps the highest player count seen on a local day ("YYYY-MM-DD"). */
  recordPeak(serverId: string, day: string, count: number): void {
    this.#write(
      'peak',
      'INSERT INTO peaks (server_id, day, peak) VALUES (?, ?, ?) ON CONFLICT (server_id, day) DO UPDATE SET peak = MAX(peak, excluded.peak)',
      serverId,
      day,
      count,
    );
  }

  peak(serverId: string, day: string): number | null {
    const row = this.#db.prepare('SELECT peak FROM peaks WHERE server_id = ? AND day = ?').get(serverId, day) as
      | { peak: number }
      | undefined;
    return row?.peak ?? null;
  }

  recordTps(serverId: string, ts: number, tps: number, worstName: string | null, worstMs: number | null): void {
    this.#write('tps', 'INSERT INTO tps (server_id, ts, tps, worst_name, worst_ms) VALUES (?, ?, ?, ?, ?)', serverId, ts, tps, worstName, worstMs);
  }

  /** TPS samples at or after `from`, oldest first. */
  tpsSince(serverId: string, from: number): { ts: number; tps: number }[] {
    return this.#db
      .prepare('SELECT ts, tps FROM tps WHERE server_id = ? AND ts >= ? ORDER BY ts')
      .all(serverId, from)
      .map((r) => ({ ts: r.ts as number, tps: r.tps as number }));
  }

  /** Average and minimum TPS over [from, to), or null without samples. */
  tpsStats(serverId: string, from: number, to: number): { avg: number; min: number } | null {
    const row = this.#db
      .prepare('SELECT AVG(tps) AS avg, MIN(tps) AS min FROM tps WHERE server_id = ? AND ts >= ? AND ts < ?')
      .get(serverId, from, to) as { avg: number | null; min: number | null };
    return row.avg === null || row.min === null ? null : { avg: row.avg, min: row.min };
  }

  /** Links a Discord account to a Minecraft player, replacing any earlier link of either. */
  link(discordId: string, player: string, uuid: string, ts: number): void {
    this.#write('unlink old', 'DELETE FROM links WHERE discord_id = ? OR player = ? COLLATE NOCASE', discordId, player);
    this.#write('link', 'INSERT INTO links (discord_id, player, uuid, linked_at) VALUES (?, ?, ?, ?)', discordId, player, uuid, ts);
  }

  /** True if a link was removed. */
  unlinkDiscord(discordId: string): boolean {
    return this.#delete('DELETE FROM links WHERE discord_id = ?', discordId);
  }

  unlinkPlayer(player: string): boolean {
    return this.#delete('DELETE FROM links WHERE player = ? COLLATE NOCASE', player);
  }

  #delete(sql: string, param: string): boolean {
    try {
      return Number(this.#db.prepare(sql).run(param).changes) > 0;
    } catch (err) {
      console.error('[db] unlink failed:', (err as Error).message);
      return false;
    }
  }

  linkByDiscord(discordId: string): { player: string; uuid: string } | null {
    const row = this.#db.prepare('SELECT player, uuid FROM links WHERE discord_id = ?').get(discordId) as
      | { player: string; uuid: string }
      | undefined;
    return row ? { player: row.player, uuid: row.uuid } : null;
  }

  linkByPlayer(player: string): { discordId: string; player: string } | null {
    const row = this.#db.prepare('SELECT discord_id, player FROM links WHERE player = ? COLLATE NOCASE').get(player) as
      | { discord_id: string; player: string }
      | undefined;
    return row ? { discordId: row.discord_id, player: row.player } : null;
  }

  close(): void {
    this.#db.close();
  }
}
```

`hub/src/lag.ts`:

```ts
import type { Db } from './db.ts';
import type { ServerHub } from './servers.ts';

export type LagConfig = { tps: number; minutes: number; enabled: boolean };
export const DEFAULT_LAG: LagConfig = { tps: 15, minutes: 2, enabled: true };

const BARS = '▁▂▃▄▅▆▇█';

/** One bar per value, scaled 0..max (20 TPS). */
export function sparkline(values: number[], max = 20): string {
  return values.map((v) => BARS[Math.min(7, Math.max(0, Math.floor((v / max) * 8)))]).join('');
}

/**
 * Samples each server's TPS once a minute into the `tps` table and alerts when it stays low. Lag is only judged
 * while a server is online and responding: crashes and hangs have their own alerts. Hub core (plain-text notices).
 */
export class LagMonitor {
  #hub: Pick<ServerHub, 'list'>;
  #db: Db;
  #configs: Record<string, LagConfig>;
  #notify: (serverId: string, text: string) => void;
  #low = new Map<string, number>(); // serverId -> consecutive low samples
  #lagging = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(hub: Pick<ServerHub, 'list'>, db: Db, configs: Record<string, LagConfig>, notify: (serverId: string, text: string) => void) {
    this.#hub = hub;
    this.#db = db;
    this.#configs = configs;
    this.#notify = notify;
  }

  start(intervalMs = 60_000): void {
    this.#timer = setInterval(() => this.sample(Date.now()), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  sample(now: number): void {
    for (const s of this.#hub.list()) {
      if (!s.online || s.hung || s.tps === null) {
        this.#low.delete(s.id);
        this.#lagging.delete(s.id); // the crash/hang alert covers it; no "back to normal" later
        continue;
      }
      const worst = s.dims[0];
      this.#db.recordTps(s.id, now, s.tps, worst?.name ?? null, worst?.ms ?? null);
      const cfg = this.#configs[s.id] ?? DEFAULT_LAG;
      if (!cfg.enabled) continue;
      if (s.tps < cfg.tps) {
        const low = (this.#low.get(s.id) ?? 0) + 1;
        this.#low.set(s.id, low);
        if (low >= cfg.minutes && !this.#lagging.has(s.id)) {
          this.#lagging.add(s.id);
          const where = worst ? `${worst.name} (DIM ${worst.id}) ${Math.round(worst.ms)} ms/tick` : 'unknown';
          this.#notify(s.id, `🐢 Lag: ${s.tps.toFixed(1)} TPS; slowest: ${where}`);
        }
      } else {
        this.#low.delete(s.id);
        if (this.#lagging.delete(s.id)) this.#notify(s.id, `✅ TPS back to normal (${s.tps.toFixed(1)})`);
      }
    }
  }
}
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 97`, `ℹ fail 0`, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add hub/src/db.ts hub/src/lag.ts hub/test/db.test.ts hub/test/lag.test.ts
git commit -m "feat(hub): TPS history and lag alerts naming the slowest dimension"
```

---

### Task 3: Quest announcer

**Files:**
- Create: `hub/src/quests.ts`
- Test: `hub/test/quests.test.ts`

**Interfaces:**
- Consumes: `QuestDone` (Task 1).
- Produces:
  - `QuestMode` and `QUEST_MODES`
  - `QuestBatch = { serverId, player, quests: QuestDone[], count }`
  - `QuestAnnouncer(modes, emit)` with `.add(serverId, player, quests)`, `.flush()`, `.start()` and `.stop()`

- [ ] **Step 1: Write the failing test**

`hub/test/quests.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuestAnnouncer, type QuestBatch, type QuestMode } from '../src/quests.ts';

const main = { name: 'Stone Age', main: true };
const q = (name: string) => ({ name, main: false });

function setup(mode: QuestMode) {
  const out: QuestBatch[] = [];
  const announcer = new QuestAnnouncer({ s: mode }, (b) => out.push(b));
  return { announcer, out };
}

test('batched: main quests at once, the rest rolled up per player on flush', () => {
  const { announcer, out } = setup('batched');
  announcer.add('s', 'Steve', [main, q('a')]);
  announcer.add('s', 'Steve', [q('b'), q('c')]);
  announcer.add('s', 'Alex', [q('d')]);
  assert.deepEqual(out, [{ serverId: 's', player: 'Steve', quests: [main], count: 1 }]);
  announcer.flush();
  assert.deepEqual(out.slice(1), [
    { serverId: 's', player: 'Steve', quests: [q('c')], count: 3 },
    { serverId: 's', player: 'Alex', quests: [q('d')], count: 1 },
  ]);
  announcer.flush();
  assert.equal(out.length, 3); // nothing left
});

test('main, all and off modes', () => {
  const m = setup('main');
  m.announcer.add('s', 'Steve', [main, q('a')]);
  m.announcer.flush();
  assert.deepEqual(m.out, [{ serverId: 's', player: 'Steve', quests: [main], count: 1 }]);
  const all = setup('all');
  all.announcer.add('s', 'Steve', [main, q('a')]);
  assert.deepEqual(all.out, [{ serverId: 's', player: 'Steve', quests: [main, q('a')], count: 2 }]);
  const off = setup('off');
  off.announcer.add('s', 'Steve', [main]);
  off.announcer.flush();
  assert.deepEqual(off.out, []);
});

test('an unknown server defaults to batched', () => {
  const out: QuestBatch[] = [];
  const announcer = new QuestAnnouncer({}, (b) => out.push(b));
  announcer.add('other', 'Steve', [q('a')]);
  assert.deepEqual(out, []);
  announcer.flush();
  assert.equal(out.length, 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd hub && npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/quests.ts`.

- [ ] **Step 3: Implement**

`hub/src/quests.ts`:

```ts
import type { QuestDone } from './protocol.ts';

export type QuestMode = 'batched' | 'main' | 'all' | 'off';
export const QUEST_MODES: readonly QuestMode[] = ['batched', 'main', 'all', 'off'];

/** `quests` to name; `count` is the total (greater than quests.length for a batched roll-up). */
export type QuestBatch = { serverId: string; player: string; quests: QuestDone[]; count: number };

/**
 * Decides which quest completions get posted: main quests at once, the rest by mode (`batched` rolls them up per
 * player every 10 minutes). Hub core: works on plain data, `emit` does the posting.
 */
export class QuestAnnouncer {
  #modes: Record<string, QuestMode>;
  #emit: (batch: QuestBatch) => void;
  #pending = new Map<string, { serverId: string; player: string; count: number; latest: QuestDone }>();
  #timer: NodeJS.Timeout | undefined;

  constructor(modes: Record<string, QuestMode>, emit: (batch: QuestBatch) => void) {
    this.#modes = modes;
    this.#emit = emit;
  }

  start(intervalMs = 10 * 60_000): void {
    this.#timer = setInterval(() => this.flush(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  add(serverId: string, player: string, quests: QuestDone[]): void {
    const mode = this.#modes[serverId] ?? 'batched';
    if (mode === 'off') return;
    const now = mode === 'all' ? quests : quests.filter((q) => q.main);
    if (now.length) this.#emit({ serverId, player, quests: now, count: now.length });
    const later = quests.filter((q) => !q.main);
    if (mode !== 'batched' || !later.length) return;
    const key = `${serverId}\u0000${player}`;
    const p = this.#pending.get(key) ?? { serverId, player, count: 0, latest: later[0] };
    p.count += later.length;
    p.latest = later[later.length - 1];
    this.#pending.set(key, p);
  }

  /** Posts one roll-up line per player with batched quests, then starts over. */
  flush(): void {
    for (const p of this.#pending.values()) this.#emit({ serverId: p.serverId, player: p.player, quests: [p.latest], count: p.count });
    this.#pending.clear();
  }
}
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 100`, `ℹ fail 0`, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add hub/src/quests.ts hub/test/quests.test.ts
git commit -m "feat(hub): quest announcer (main at once, others batched per player)"
```

---

### Task 4: Account linking

**Files:**
- Create: `hub/src/links.ts`
- Test: `hub/test/links.test.ts`

**Interfaces:**
- Consumes: `Db` link methods (Task 2); `ServerHub.on` and `sendLinkResult` (Task 1).
- Produces:
  - `CODE_ALPHABET`
  - `Links(db, hub, onLinked)` with `.issue(discordId, discordName, now?) → code`, `.redeem(code, player, uuid, now?) → { ok, message, discordId? }` and `.unlinkDiscord(id)`
  - it answers the mod's `link`/`unlink` events itself

- [ ] **Step 1: Write the failing test**

`hub/test/links.test.ts`:

```ts
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Db } from '../src/db.ts';
import { CODE_ALPHABET, Links } from '../src/links.ts';
import type { HubEvent, ServerHub } from '../src/servers.ts';

function setup() {
  const db = new Db(':memory:');
  const events = new EventEmitter<{ event: [HubEvent] }>();
  const results: string[] = [];
  const linked: string[] = [];
  const hub = {
    on: (name: 'event', fn: (e: HubEvent) => void) => events.on(name, fn),
    sendLinkResult: (_id: string, player: string, ok: boolean, message: string) => results.push(`${player}|${ok}|${message}`),
  } as unknown as Pick<ServerHub, 'on' | 'sendLinkResult'>;
  const links = new Links(db, hub, (serverId, player, discordId) => linked.push(`${serverId}|${player}|${discordId}`));
  return { db, links, events, results, linked };
}

test('a code links once, case-insensitively, and replaces the previous code', () => {
  const { db, links } = setup();
  const first = links.issue('d1', 'Edward');
  const code = links.issue('d1', 'Edward');
  assert.equal(code.length, 6);
  assert.ok([...code].every((c) => CODE_ALPHABET.includes(c)));
  assert.equal(links.redeem(first, 'Steve', 'u1').ok, false); // replaced
  assert.deepEqual(links.redeem(code.toLowerCase(), 'Steve', 'u1'), {
    ok: true,
    message: 'Linked to Edward on Discord.',
    discordId: 'd1',
  });
  assert.equal(links.redeem(code, 'Steve', 'u1').ok, false); // used up
  assert.deepEqual(db.linkByDiscord('d1'), { player: 'Steve', uuid: 'u1' });
  assert.deepEqual(db.linkByPlayer('steve'), { discordId: 'd1', player: 'Steve' });
});

test('codes expire after 10 minutes', () => {
  const { links } = setup();
  const code = links.issue('d1', 'Edward', 0);
  assert.equal(links.redeem(code, 'Steve', 'u1', 10 * 60_000).ok, false);
});

test('a player or a Discord account has at most one link', () => {
  const { db, links } = setup();
  links.redeem(links.issue('d1', 'A'), 'Steve', 'u1');
  links.redeem(links.issue('d2', 'B'), 'Steve', 'u1'); // Steve moves to d2
  assert.equal(db.linkByDiscord('d1'), null);
  links.redeem(links.issue('d2', 'B'), 'Alex', 'u2'); // d2 moves to Alex
  assert.equal(db.linkByPlayer('Steve'), null);
  assert.deepEqual(db.linkByDiscord('d2'), { player: 'Alex', uuid: 'u2' });
  assert.equal(links.unlinkDiscord('d2'), true);
  assert.equal(links.unlinkDiscord('d2'), false);
});

test('five wrong guesses lock the player out for a while', () => {
  const { links } = setup();
  const code = links.issue('d1', 'Edward', 0);
  for (let i = 0; i < 5; i++) assert.match(links.redeem('WRONG1', 'Steve', 'u1', 1000).message, /unknown or expired/);
  assert.match(links.redeem(code, 'Steve', 'u1', 2000).message, /Too many attempts/);
  const fresh = links.issue('d1', 'Edward', 10 * 60_000 + 1000);
  assert.equal(links.redeem(fresh, 'Steve', 'u1', 10 * 60_000 + 1001).ok, true); // the lock wears off
});

test('link and unlink messages from the mod are answered and announced', () => {
  const { links, events, results, linked } = setup();
  const code = links.issue('d1', 'Edward');
  events.emit('event', { serverId: 'gtnh', type: 'link', player: 'Steve', uuid: 'u1', code });
  events.emit('event', { serverId: 'gtnh', type: 'unlink', player: 'Steve' });
  events.emit('event', { serverId: 'gtnh', type: 'unlink', player: 'Steve' });
  assert.deepEqual(results, [
    'Steve|true|Linked to Edward on Discord.',
    'Steve|true|Unlinked from Discord.',
    "Steve|false|You weren't linked.",
  ]);
  assert.deepEqual(linked, ['gtnh|Steve|d1']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd hub && npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/links.ts`.

- [ ] **Step 3: Implement**

`hub/src/links.ts`:

```ts
import { randomInt } from 'node:crypto';
import type { Db } from './db.ts';
import type { ServerHub } from './servers.ts';

/** No 0/O or 1/I: codes are typed by hand in game. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_MS = 10 * 60_000;
const MAX_FAILS = 5;

export type RedeemResult = { ok: boolean; message: string; discordId?: string };

/**
 * Discord ↔ Minecraft account linking: `/link` issues a code, `/discord link <code>` in game redeems it. Codes live
 * in memory only. Handles the mod's link/unlink messages itself; `onLinked` announces a new link. Hub core.
 */
export class Links {
  #db: Db;
  #codes = new Map<string, { discordId: string; discordName: string; expires: number }>();
  #fails = new Map<string, number[]>(); // lower-case player -> recent failed attempt times

  constructor(
    db: Db,
    hub: Pick<ServerHub, 'on' | 'sendLinkResult'>,
    onLinked: (serverId: string, player: string, discordId: string) => void,
  ) {
    this.#db = db;
    hub.on('event', (e) => {
      if (e.type === 'link') {
        const result = this.redeem(e.code, e.player, e.uuid);
        hub.sendLinkResult(e.serverId, e.player, result.ok, result.message);
        if (result.ok && result.discordId) onLinked(e.serverId, e.player, result.discordId);
      } else if (e.type === 'unlink') {
        const removed = this.#db.unlinkPlayer(e.player);
        hub.sendLinkResult(e.serverId, e.player, removed, removed ? 'Unlinked from Discord.' : "You weren't linked.");
      }
    });
  }

  /** A fresh code for this Discord user (replacing any earlier one), valid for 10 minutes. */
  issue(discordId: string, discordName: string, now = Date.now()): string {
    for (const [code, entry] of this.#codes) {
      if (entry.discordId === discordId || entry.expires <= now) this.#codes.delete(code);
    }
    let code: string;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.#codes.has(code));
    this.#codes.set(code, { discordId, discordName, expires: now + CODE_MS });
    return code;
  }

  redeem(code: string, player: string, uuid: string, now = Date.now()): RedeemResult {
    const key = player.toLowerCase();
    const fails = (this.#fails.get(key) ?? []).filter((t) => now - t < CODE_MS);
    if (fails.length >= MAX_FAILS) return { ok: false, message: 'Too many attempts; try again in a few minutes.' };
    const normalized = code.trim().toUpperCase();
    const entry = this.#codes.get(normalized);
    if (!entry || entry.expires <= now) {
      this.#fails.set(key, [...fails, now]);
      return { ok: false, message: 'That code is unknown or expired. Use /link in Discord for a new one.' };
    }
    this.#codes.delete(normalized);
    this.#fails.delete(key);
    this.#db.link(entry.discordId, player, uuid, now);
    return { ok: true, message: `Linked to ${entry.discordName} on Discord.`, discordId: entry.discordId };
  }

  unlinkDiscord(discordId: string): boolean {
    return this.#db.unlinkDiscord(discordId);
  }
}
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 105`, `ℹ fail 0`, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add hub/src/links.ts hub/test/links.test.ts
git commit -m "feat(hub): Discord ↔ Minecraft account linking with capped code guessing"
```

---

### Task 5: Discord frontend and wiring for v1.2b

**Files:**
- Modify: `hub/src/backups.ts`: `watch()` is removed, because the mod's backup events replace it; adds `backupNotice`
- Modify: `hub/src/format.ts` (`formatTps`, `formatQuests`, `formatLinked`), `hub/src/discord.ts`, `hub/src/index.ts`, `hub/config.example.json`
- Test: `hub/test/backups.test.ts`, `hub/test/format.test.ts`, `hub/test/discord.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces:
  - `startDiscord(hub, db, restarts, links, cfg, token) → { client, notice, summary, quests(batch), linked(serverId, player, discordId) }`
  - `COMMANDS` gains `tps`, `link` and `unlink`; `playtime` takes an optional `player` or `user`
  - config fields per server: `lagTps`, `lagMinutes`, `lagAlerts` and `quests`

- [ ] **Step 1: Write the failing tests**

`hub/test/backups.test.ts`, the full file (the `watch` tests are replaced by `backupNotice`):

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { backupNotice, BackupWatcher, listBackups, type Backup } from '../src/backups.ts';

const MIN = 60_000;
const flush = () => new Promise((r) => setImmediate(r)); // lets the injected list() promise settle

test('listBackups finds finished zips newest first and skips everything else', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'backups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = async (name: string, mtimeSec: number, bytes = 10) => {
    await writeFile(join(dir, name), 'x'.repeat(bytes));
    await utimes(join(dir, name), mtimeSec, mtimeSec);
  };
  await file('2026-09-23-06-00-00.zip', 1000, 100);
  await file('2026-09-24-06-00-00.zip', 2000, 200);
  await file('.su-save-123.tmp', 3000); // staging
  await file('notes.txt', 3000);
  await mkdir(join(dir, '2026-09-25-06-00-00.zip')); // a folder, not a backup
  await symlink(join(dir, 'notes.txt'), join(dir, '2026-09-26-06-00-00.zip'));
  assert.deepEqual(
    (await listBackups(dir)).map((b) => [b.name, b.size]),
    [
      ['2026-09-24-06-00-00.zip', 200],
      ['2026-09-23-06-00-00.zip', 100],
    ],
  );
  assert.deepEqual(await listBackups(join(dir, 'missing')), []);
});

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000_000_000 });
  let backups: Backup[] = [];
  const notices: string[] = [];
  const watcher = new BackupWatcher(
    async () => backups,
    (_id, text) => notices.push(text),
  );
  t.after(() => watcher.stop());
  return { watcher, notices, set: (b: Backup[]) => (backups = b) };
}

test('backupNotice turns mod backup events into notices', () => {
  assert.equal(backupNotice(true, '12.3 seconds (1.2GB)'), '✅ Backup finished (12.3 seconds (1.2GB))');
  assert.equal(backupNotice(false, 'disk full'), '❌ Backup failed: disk full');
});

test('the watchdog warns once when backups are overdue and re-arms after a new one', async (t) => {
  const { watcher, notices, set } = setup(t);
  set([{ name: 'a.zip', size: 1, mtimeMs: Date.now() - 30 * 60 * MIN }]); // 30 h old
  watcher.watchdog('gtnh', 26);
  t.mock.timers.tick(10 * MIN);
  await flush();
  t.mock.timers.tick(10 * MIN);
  await flush();
  assert.deepEqual(notices, ['⚠️ No new backup for 30 h (newest: a.zip)']);
  set([{ name: 'b.zip', size: 1, mtimeMs: Date.now() }]);
  t.mock.timers.tick(10 * MIN);
  await flush();
  set([{ name: 'b.zip', size: 1, mtimeMs: Date.now() - 27 * 60 * MIN }]);
  t.mock.timers.tick(10 * MIN);
  await flush();
  assert.equal(notices.length, 2);
  assert.match(notices[1], /No new backup for 27 h/);
});
```

`hub/test/format.test.ts`, the full file:

````ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIEmbed } from 'discord.js';
import {
  COLORS,
  formatBackupList,
  formatBackupStatus,
  formatEvent,
  formatLastSeen,
  formatLinked,
  formatNotice,
  formatOutput,
  formatPlayers,
  formatPlaytime,
  formatPresence,
  formatQuests,
  formatStatus,
  formatSummary,
  formatTop,
  formatTopic,
  formatTps,
  TOPIC_MIN_GAP_MS,
  topicDue,
  type Post,
} from '../src/format.ts';
import type { ServerState } from '../src/servers.ts';

test('formatEvent keeps chat-like events as escaped plain text', () => {
  assert.deepEqual(formatEvent({ serverId: 's', type: 'chat', player: 'x_y_z', message: '**hi** [a](http://x) §cred' }), {
    content: '**x\\_y\\_z**: \\*\\*hi\\*\\* \\[a](http://x) red',
  });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'chat', player: 'a', message: '# big' }), { content: '**a**: \\# big' });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'death', player: 'Steve', message: 'Steve fell from a high place' }), {
    content: '💀 Steve fell from a high place',
  });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'achievement', player: 'Steve', achievement: 'Taking Inventory' }), {
    content: '🏆 **Steve** earned **Taking Inventory**',
  });
});

test('formatEvent announces lifecycle as coloured embeds, but not reconnects', () => {
  assert.equal(formatEvent({ serverId: 's', type: 'connected' }), null);
  assert.equal(formatEvent({ serverId: 's', type: 'offline' }), null);
  assert.deepEqual(formatEvent({ serverId: 's', type: 'crashed' }), {
    embeds: [{ title: '💥 Server went down unexpectedly', color: COLORS.red }],
  });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'started' }), { embeds: [{ title: '✅ Server started', color: COLORS.green }] });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'hung' }), { embeds: [{ title: '⚠️ Server not responding', color: COLORS.orange }] });
});

test('formatNotice colours by the leading emoji', () => {
  const color = (text: string) => (formatNotice(text) as { embeds: { color?: number }[] }).embeds[0].color;
  assert.equal(color('🔄 Restart in 5 minutes (by a)'), COLORS.blue);
  assert.equal(color('❌ Restart failed: timed out'), COLORS.red);
  assert.equal(color('⚠️ No new backup for 30 h'), COLORS.orange);
  assert.equal(color('✅ Backup finished: x.zip'), COLORS.green);
  const long = formatNotice('x'.repeat(300)) as { embeds: { title?: string }[] };
  assert.ok(long.embeds[0].title!.length <= 256);
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

const first = (p: Post) => (p as { embeds: APIEmbed[] }).embeds[0];

test('formatStatus is an embed with state, TPS, players and uptime', () => {
  const base: ServerState = { id: 's', name: 'GTNH', online: true, hung: false, tps: 19.96, players: ['a_b', 'c'], dims: [] };
  const e = first(formatStatus(base, 1, 0.5));
  assert.equal(e.title, 'GTNH — 🟢 Online');
  assert.equal(e.color, COLORS.green);
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['TPS', '20.0'],
      ['Players', '2'],
      ['Uptime 24 h', '100.0%'],
      ['Uptime 7 d', '50.0%'],
      ['Online now', 'a\\_b, c'],
    ],
  );
  assert.equal(first(formatStatus({ ...base, hung: true }, null, null)).title, 'GTNH — 🟠 Not responding');
  const off = first(formatStatus({ ...base, online: false, tps: null, players: [] }, 0, 0));
  assert.equal(off.color, COLORS.red);
  assert.deepEqual(off.fields!.map((f) => f.name), ['Uptime 24 h', 'Uptime 7 d']);
});

test('formatPlayers lists escaped names in an embed', () => {
  assert.equal(first(formatPlayers([])).title, 'Nobody online');
  const e = first(formatPlayers(['Steve', 'a_b']));
  assert.equal(e.title, 'Online (2)');
  assert.equal(e.description, 'Steve, a\\_b');
});

test('formatPlaytime and formatLastSeen', () => {
  const now = 10 * 3600_000;
  assert.equal(formatLastSeen(null, now), 'never');
  assert.equal(formatLastSeen({ online: true }, now), 'online now');
  assert.equal(formatLastSeen(now - 3 * 3600_000, now), '3 h ago');
  const e = first(formatPlaytime('Steve', 5 * 3600_000 + 12 * 60_000, 3600_000, { online: true }, now));
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['Player', 'Steve'],
      ['Total', '5 h 12 m'],
      ['Last 7 days', '1 h'],
      ['Last seen', 'online now'],
    ],
  );
});

test('formatTop numbers players and handles an empty period', () => {
  const e = first(formatTop('week', [{ player: 'a_b', ms: 7200_000 }, { player: 'C', ms: 60_000 }]));
  assert.equal(e.title, 'Top players (last 7 days)');
  assert.equal(e.description, '1. **a\\_b**: 2 h\n2. **C**: 1 m');
  assert.equal(first(formatTop('day', [])).description, 'No playtime recorded.');
});

test('formatBackupStatus and formatBackupList show count and total size', () => {
  const now = 1_000_000_000_000;
  const backups = [
    { name: '2026-09-24-06-00-00.zip', size: 2 * 1024 ** 3, mtimeMs: now - 2 * 3600_000 },
    { name: '2026-09-23-06-00-00.zip', size: 1024 ** 3, mtimeMs: now - 26 * 3600_000 },
  ];
  const status = first(formatBackupStatus(backups, now));
  assert.deepEqual(
    status.fields!.map((f) => [f.name, f.value]),
    [
      ['Newest', '2026-09-24-06-00-00.zip'],
      ['Age', '2 h'],
      ['Size', '2.0 GB'],
      ['Count', '2'],
      ['Total size', '3.0 GB'],
    ],
  );
  const list = first(formatBackupList(backups));
  assert.equal(list.title, 'Backups: 2, 3.0 GB total');
  assert.equal(list.description, '`2026-09-24-06-00-00.zip` 2.0 GB\n`2026-09-23-06-00-00.zip` 1.0 GB');
  assert.equal(first(formatBackupStatus([], now)).description, 'No backups found.');
});

test('formatSummary lays out the daily stats', () => {
  const e = first(
    formatSummary('GTNH', {
      day: '2026-09-23',
      uptime: 0.75,
      peak: 3,
      unique: 4,
      totalMs: 6.5 * 3600_000,
      top: [{ player: 'A', ms: 3 * 3600_000 }],
      starts: 2,
      crashes: 1,
    }),
  );
  assert.equal(e.title, '📊 GTNH: 2026-09-23');
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['Uptime', '75.0%'],
      ['Peak players', '3'],
      ['Unique players', '4'],
      ['Total playtime', '6 h 30 m'],
      ['Starts', '2'],
      ['Crashes', '1'],
      ['Top players', '1. **A**: 3 h'],
    ],
  );
});

test('formatOutput truncates long emoji output without splitting an emoji', () => {
  const out = formatOutput(['😀'.repeat(2000)]);
  assert.ok(out.length <= 2000, `length ${out.length}`);
  assert.ok(out.endsWith('😀\n… (truncated)\n```'));
});

const online: ServerState = { id: 'gtnh', name: 'GTNH', online: true, hung: false, tps: 19.7, players: ['Steve', 'Alex'], dims: [] };

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

test('formatTps shows now, averages, a trend and the slowest dimensions', () => {
  const s: ServerState = {
    id: 's',
    name: 'GTNH',
    online: true,
    hung: false,
    tps: 13.4,
    players: [],
    dims: [{ id: -1, name: 'Nether', ms: 72.4 }],
  };
  const e = first(formatTps(s, [{ ts: 1, tps: 20 }, { ts: 2, tps: 10 }], { avg: 15, min: 10 }, { avg: 18.25, min: 9 }));
  assert.equal(e.title, 'GTNH: 13.4 TPS');
  assert.equal(e.color, COLORS.orange);
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['Last hour', '15.0 (min 10.0)'],
      ['Last 24 h', '18.3'],
      ['Trend (1 sample/min)', '█▅'],
      ['Slowest dimensions', 'Nether (DIM -1): 72 ms/tick'],
    ],
  );
  assert.equal(first(formatTps({ ...s, online: false, tps: null }, [], null, null)).title, 'GTNH: offline');
});

test('formatQuests: at-once lists up to 5 names; a roll-up shows the count and latest', () => {
  const q = (name: string, main = false) => ({ name, main });
  assert.deepEqual(formatQuests({ serverId: 's', player: 'a_b', quests: [q('Stone Age', true)], count: 1 }), {
    content: '📜 **a\\_b** completed **Stone Age**',
  });
  const seven = ['1', '2', '3', '4', '5', '6', '7'].map((n) => q(n));
  assert.deepEqual(formatQuests({ serverId: 's', player: 'S', quests: seven, count: 7 }), {
    content: '📜 **S** completed **1**, **2**, **3**, **4**, **5** and 2 more',
  });
  assert.deepEqual(formatQuests({ serverId: 's', player: 'S', quests: [q('Bronze')], count: 7 }), {
    content: '📜 **S** completed 7 quests (latest: **Bronze**)',
  });
});

test('formatLinked mentions without escaping the id', () => {
  assert.deepEqual(formatLinked('Steve', '123'), { content: '🔗 **Steve** linked to <@123>' });
});
````

`hub/test/discord.test.ts`, the full file:

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
  assert.equal(perms.backup, '0');
  for (const name of ['status', 'list', 'playtime', 'top', 'tps', 'link', 'unlink']) assert.ok(!perms[name], name);
});

test('the command set includes stats and backup subcommands', () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ['backup', 'cmd', 'link', 'list', 'playtime', 'restart', 'status', 'top', 'tps', 'unlink']);
  assert.deepEqual(byName.playtime.options?.map((o) => [o.name, o.required ?? false]), [
    ['player', false],
    ['user', false],
  ]);
  assert.deepEqual(byName.backup.options?.map((o) => o.name), ['start', 'status', 'list']);
  assert.deepEqual(
    (byName.top.options?.[0] as { choices?: { value: string }[] }).choices?.map((c) => c.value),
    ['day', 'week', 'all'],
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd hub && npm test`
Expected: FAIL. `backups.test.ts` errors with `does not provide an export named 'backupNotice'`, `format.test.ts` with no export named `formatLinked`, and `discord.test.ts` fails the command-set tests.

- [ ] **Step 3: Implement**

`hub/src/backups.ts`:

```ts
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type Backup = { name: string; size: number; mtimeMs: number };

/** ServerUtilities' backup names: "<YYYY-MM-DD-HH-MM-SS>.zip", moved into place atomically when finished. */
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}.*\.zip$/;
const WATCHDOG_MS = 10 * 60_000;
const HOUR = 60 * 60_000;

/** Finished backups in a folder, newest first. Skips staging files, folders and symlinks; never throws. */
export async function listBackups(dir: string): Promise<Backup[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found: Backup[] = [];
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue;
    try {
      const st = await lstat(join(dir, name));
      if (st.isFile()) found.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // deleted between readdir and lstat (e.g. old backups being pruned)
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The notice for a backup event from the mod (ServerUtilities' own "done"/"failed" log lines). */
export function backupNotice(ok: boolean, detail: string): string {
  return ok ? `✅ Backup finished (${detail})` : `❌ Backup failed: ${detail}`;
}

/**
 * Warns when backups stop appearing in a backup folder. (Finish and failure notices come from the mod's backup
 * events.) Hub core (plain-text notices); `list` is injected so tests needn't touch disk.
 */
export class BackupWatcher {
  #list: (serverId: string) => Promise<Backup[]>;
  #notify: (serverId: string, text: string) => void;
  #watchdogs = new Map<string, NodeJS.Timeout>();
  #overdue = new Set<string>();

  constructor(list: (serverId: string) => Promise<Backup[]>, notify: (serverId: string, text: string) => void) {
    this.#list = list;
    this.#notify = notify;
  }

  /** Every 10 minutes, warn once if the newest backup is older than `maxAgeHours`; re-arms after a new one. */
  watchdog(serverId: string, maxAgeHours: number): void {
    clearInterval(this.#watchdogs.get(serverId));
    const check = async () => {
      const newest = (await this.#list(serverId))[0];
      const age = newest ? Date.now() - newest.mtimeMs : Infinity;
      if (age <= maxAgeHours * HOUR) {
        this.#overdue.delete(serverId);
      } else if (!this.#overdue.has(serverId)) {
        this.#overdue.add(serverId);
        this.#notify(
          serverId,
          newest ? `⚠️ No new backup for ${Math.floor(age / HOUR)} h (newest: ${newest.name})` : '⚠️ No backups found',
        );
      }
    };
    this.#watchdogs.set(serverId, setInterval(() => void check(), WATCHDOG_MS));
  }

  /** Clears every timer (hub shutdown). */
  stop(): void {
    for (const timer of this.#watchdogs.values()) clearInterval(timer);
    this.#watchdogs.clear();
  }
}
```

`hub/src/format.ts`:

````ts
import { escapeMarkdown, type APIEmbed } from 'discord.js';
import type { Backup } from './backups.ts';
import { sparkline } from './lag.ts';
import type { QuestBatch } from './quests.ts';
import { stripCodes, truncate, type HubEvent, type ServerState } from './servers.ts';
import type { Summary } from './summary.ts';
import { formatBytes, formatDuration } from './units.ts';

/** What the bot posts: plain text (chat-like messages) or an embed (everything else). */
export type Post = { content: string } | { embeds: APIEmbed[] };

export const COLORS = { green: 0x2ecc71, grey: 0x95a5a6, red: 0xe74c3c, orange: 0xe67e22, blue: 0x3498db } as const;

// Discord embed limits.
const TITLE = 256;
const FIELD = 1024;
const DESCRIPTION = 4096;

/** Escapes Minecraft text for Discord: no § codes, no markdown, headings, lists or masked links. */
export function md(s: string): string {
  return escapeMarkdown(stripCodes(s), { heading: true, maskedLink: true, bulletedList: true, numberedList: true });
}

/** Embed titles render less markdown than descriptions, so they only get § codes stripped. */
function title(s: string): string {
  return truncate(stripCodes(s), TITLE);
}

const embed = (e: APIEmbed): Post => ({ embeds: [e] });

/** The Discord post for a hub event, or null for events that aren't announced. */
export function formatEvent(e: HubEvent): Post | null {
  switch (e.type) {
    case 'chat':
      return { content: `**${md(e.player)}**: ${md(e.message)}` };
    case 'join':
      return { content: `➡️ **${md(e.player)}** joined` };
    case 'leave':
      return { content: `⬅️ **${md(e.player)}** left` };
    case 'death':
      return { content: `💀 ${md(e.message)}` };
    case 'achievement':
      return { content: `🏆 **${md(e.player)}** earned **${md(e.achievement)}**` };
    case 'started':
      return embed({ title: '✅ Server started', color: COLORS.green });
    case 'stopped':
      return embed({ title: '🛑 Server stopped', color: COLORS.grey });
    case 'crashed':
      return embed({ title: '💥 Server went down unexpectedly', color: COLORS.red });
    case 'hung':
      return embed({ title: '⚠️ Server not responding', color: COLORS.orange });
    case 'recovered':
      return embed({ title: '✅ Server responding again', color: COLORS.green });
    case 'connected': // may just be a reconnect after a hub restart
    case 'offline': // hub-start bookkeeping for uptime, not news
    case 'quest': // batched by the QuestAnnouncer
    case 'link': // answered by Links
    case 'unlink':
    case 'backup': // posted as a notice
      return null;
  }
}

/** A hub-core notice (restarts, backups) as an embed, coloured by its leading emoji. */
export function formatNotice(text: string): Post {
  const color = text.startsWith('❌')
    ? COLORS.red
    : text.startsWith('⚠️')
      ? COLORS.orange
      : text.startsWith('✅')
        ? COLORS.green
        : COLORS.blue;
  return embed({ title: title(text), color });
}

const pct = (u: number | null) => (u === null ? 'n/a' : `${(u * 100).toFixed(1)}%`);

export function formatStatus(s: ServerState, day: number | null, week: number | null): Post {
  const [state, color] = !s.online
    ? ['🔴 Offline', COLORS.red]
    : s.hung
      ? ['🟠 Not responding', COLORS.orange]
      : ['🟢 Online', COLORS.green];
  const fields = [
    ...(s.online
      ? [
          { name: 'TPS', value: s.tps === null ? 'n/a' : s.tps.toFixed(1), inline: true },
          { name: 'Players', value: String(s.players.length), inline: true },
        ]
      : []),
    { name: 'Uptime 24 h', value: pct(day), inline: true },
    { name: 'Uptime 7 d', value: pct(week), inline: true },
  ];
  if (s.online && s.players.length) fields.push({ name: 'Online now', value: truncate(s.players.map(md).join(', '), FIELD), inline: false });
  return embed({ title: title(`${s.name} — ${state}`), color, fields });
}

export function formatPlayers(players: string[]): Post {
  if (!players.length) return embed({ title: 'Nobody online', color: COLORS.blue });
  return embed({
    title: `Online (${players.length})`,
    description: truncate(players.map(md).join(', '), DESCRIPTION),
    color: COLORS.blue,
  });
}

/** Command output as a code block that always fits in one Discord message. */
export function formatOutput(lines: string[]): string {
  const max = 1900;
  let text = stripCodes(lines.join('\n')).replaceAll('```', "'''") || '(no output)';
  if (text.length > max) text = truncate(text, max) + '\n… (truncated)';
  return '```\n' + text + '\n```';
}

export function formatLastSeen(seen: { online: true } | number | null, now: number): string {
  if (seen === null) return 'never';
  if (typeof seen === 'object') return 'online now';
  return `${formatDuration(now - seen)} ago`;
}

export function formatPlaytime(player: string, totalMs: number, weekMs: number, seen: { online: true } | number | null, now: number): Post {
  return embed({
    title: 'Playtime',
    color: COLORS.blue,
    fields: [
      { name: 'Player', value: md(player), inline: false },
      { name: 'Total', value: formatDuration(totalMs), inline: true },
      { name: 'Last 7 days', value: formatDuration(weekMs), inline: true },
      { name: 'Last seen', value: formatLastSeen(seen, now), inline: true },
    ],
  });
}

export const TOP_PERIODS = { day: 'last 24 hours', week: 'last 7 days', all: 'all time' } as const;

export function formatTop(period: keyof typeof TOP_PERIODS, rows: { player: string; ms: number }[]): Post {
  const lines = rows.map((r, i) => `${i + 1}. **${md(r.player)}**: ${formatDuration(r.ms)}`);
  return embed({
    title: `Top players (${TOP_PERIODS[period]})`,
    description: truncate(lines.join('\n'), DESCRIPTION) || 'No playtime recorded.',
    color: COLORS.blue,
  });
}

const totalSize = (backups: Backup[]) => formatBytes(backups.reduce((sum, b) => sum + b.size, 0));

export function formatBackupStatus(backups: Backup[], now: number): Post {
  const newest = backups[0];
  if (!newest) return embed({ title: 'Backups', description: 'No backups found.', color: COLORS.orange });
  return embed({
    title: 'Backups',
    color: COLORS.blue,
    fields: [
      { name: 'Newest', value: truncate(newest.name, FIELD), inline: false },
      { name: 'Age', value: `${formatDuration(now - newest.mtimeMs)}`, inline: true },
      { name: 'Size', value: formatBytes(newest.size), inline: true },
      { name: 'Count', value: String(backups.length), inline: true },
      { name: 'Total size', value: totalSize(backups), inline: true },
    ],
  });
}

export function formatBackupList(backups: Backup[]): Post {
  if (!backups.length) return embed({ title: 'Backups', description: 'No backups found.', color: COLORS.orange });
  const lines = backups.slice(0, 10).map((b) => `\`${b.name}\` ${formatBytes(b.size)}`);
  return embed({
    title: `Backups: ${backups.length}, ${totalSize(backups)} total`,
    description: truncate(lines.join('\n'), DESCRIPTION),
    color: COLORS.blue,
  });
}

export function formatSummary(serverName: string, s: Summary): Post {
  const top = s.top.map((p, i) => `${i + 1}. **${md(p.player)}**: ${formatDuration(p.ms)}`).join('\n') || 'Nobody played.';
  return embed({
    title: title(`📊 ${serverName}: ${s.day}`),
    color: COLORS.blue,
    fields: [
      { name: 'Uptime', value: pct(s.uptime), inline: true },
      { name: 'Peak players', value: s.peak === null ? 'n/a' : String(s.peak), inline: true },
      { name: 'Unique players', value: String(s.unique), inline: true },
      { name: 'Total playtime', value: formatDuration(s.totalMs), inline: true },
      { name: 'Starts', value: String(s.starts), inline: true },
      { name: 'Crashes', value: String(s.crashes), inline: true },
      { name: 'Top players', value: truncate(top, FIELD), inline: false },
    ],
  });
}

export function formatTps(
  s: ServerState,
  lastHour: { ts: number; tps: number }[],
  hour: { avg: number; min: number } | null,
  day: { avg: number; min: number } | null,
): Post {
  if (!s.online || s.tps === null) return embed({ title: title(`${s.name}: offline`), color: COLORS.red });
  const color = s.tps >= 18 ? COLORS.green : s.tps >= 12 ? COLORS.orange : COLORS.red;
  const stat = (x: { avg: number; min: number } | null, withMin: boolean) =>
    x === null ? 'n/a' : withMin ? `${x.avg.toFixed(1)} (min ${x.min.toFixed(1)})` : x.avg.toFixed(1);
  const fields = [
    { name: 'Last hour', value: stat(hour, true), inline: true },
    { name: 'Last 24 h', value: stat(day, false), inline: true },
  ];
  if (lastHour.length) fields.push({ name: 'Trend (1 sample/min)', value: sparkline(lastHour.slice(-60).map((x) => x.tps)), inline: false });
  if (s.dims.length) {
    const dims = s.dims.map((d) => `${md(d.name)} (DIM ${d.id}): ${Math.round(d.ms)} ms/tick`).join('\n');
    fields.push({ name: 'Slowest dimensions', value: truncate(dims, FIELD), inline: false });
  }
  return embed({ title: title(`${s.name}: ${s.tps.toFixed(1)} TPS`), color, fields });
}

/** A quest post: the quests completed at once, or a batched roll-up (`count` > quests shown). */
export function formatQuests(b: QuestBatch): Post {
  const who = `📜 **${md(b.player)}** completed`;
  if (b.count > b.quests.length) return { content: `${who} ${b.count} quests (latest: **${md(b.quests[0].name)}**)` };
  const names = b.quests.slice(0, 5).map((q) => `**${md(q.name)}**`);
  const more = b.quests.length > 5 ? ` and ${b.quests.length - 5} more` : '';
  return { content: truncate(`${who} ${names.join(', ')}${more}`, 2000) };
}

/** The mention renders as a name but doesn't ping (allowedMentions is off for everything the bot posts). */
export function formatLinked(player: string, discordId: string): Post {
  return { content: `🔗 **${md(player)}** linked to <@${discordId}>` };
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
import { basename } from 'node:path';
import { listBackups } from './backups.ts';
import { findCrashLogs } from './crashlogs.ts';
import type { Db } from './db.ts';
import {
  formatBackupList,
  formatBackupStatus,
  formatEvent,
  formatLinked,
  formatNotice,
  formatOutput,
  formatPlayers,
  formatPlaytime,
  formatPresence,
  formatQuests,
  formatStatus,
  formatSummary,
  formatTop,
  formatTopic,
  formatTps,
  md,
  TOP_PERIODS,
  topicDue,
  type Post,
  type TopicEdit,
} from './format.ts';
import type { Links } from './links.ts';
import type { QuestBatch } from './quests.ts';
import type { RestartScheduler } from './restarts.ts';
import type { HubEvent, ServerHub } from './servers.ts';
import type { Summary } from './summary.ts';

export type DiscordConfig = {
  guildId: string;
  adminRoleId: string;
  /** serverId -> channelId */
  channels: Record<string, string>;
  /** serverId -> server folder, for crash-log uploads */
  dirs: Record<string, string>;
  /** serverId -> ServerUtilities backup folder */
  backupDirs: Record<string, string>;
};

export type DiscordFrontend = {
  client: Client;
  /** Posts a hub-core notice (restarts, backups) to the server's channel. */
  notice: (serverId: string, text: string) => void;
  summary: (serverId: string, s: Summary) => void;
  quests: (batch: QuestBatch) => void;
  linked: (serverId: string, player: string, discordId: string) => void;
};

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const WEBHOOK_NAME = 'GTNH Relay';
const CRASH_LOG_WINDOW_MS = 10 * 60_000;
// Discord API error codes.
const UNKNOWN_WEBHOOK = 10015;
const MISSING_PERMISSIONS = 50013;
const INVALID_FORM_BODY = 50035; // e.g. a webhook username containing "discord"

const ADMIN_COMMANDS = new Set(['cmd', 'restart', 'backup']);

// Admin commands are hidden (default_member_permissions "0") until the admin role is allowed under
// Server Settings → Integrations; the adminRoleId check below still applies either way.
export const COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Server status, TPS and uptime'),
  new SlashCommandBuilder().setName('list').setDescription('Players online'),
  new SlashCommandBuilder().setName('tps').setDescription('TPS now, over the last hour and day, and the slowest dimensions'),
  new SlashCommandBuilder()
    .setName('playtime')
    .setDescription("A player's playtime and when they were last seen")
    .addStringOption((o) => o.setName('player').setDescription('Minecraft name'))
    .addUserOption((o) => o.setName('user').setDescription('Or a Discord member who has linked their account')),
  new SlashCommandBuilder().setName('link').setDescription('Link your Discord account to your Minecraft name'),
  new SlashCommandBuilder().setName('unlink').setDescription('Remove the link to your Minecraft name'),
  new SlashCommandBuilder()
    .setName('top')
    .setDescription('Top players by playtime')
    .addStringOption((o) =>
      o
        .setName('period')
        .setDescription('Default: last 7 days')
        .addChoices(
          { name: 'last 24 hours', value: 'day' },
          { name: 'last 7 days', value: 'week' },
          { name: 'all time', value: 'all' },
        ),
    ),
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
  new SlashCommandBuilder()
    .setName('backup')
    .setDescription('ServerUtilities backups (admin role only)')
    .setDefaultMemberPermissions(0)
    .addSubcommand((s) => s.setName('start').setDescription('Start a backup now and report when it finishes'))
    .addSubcommand((s) => s.setName('status').setDescription('Newest backup, count and total size'))
    .addSubcommand((s) => s.setName('list').setDescription('The 10 newest backups with sizes')),
].map((c) => c.toJSON());

/** Only people's own messages go into the game: not bots, webhooks (including our relay), or system notices. */
export function shouldRelay(m: Pick<Message, 'author' | 'webhookId' | 'system'>): boolean {
  return !m.author.bot && !m.webhookId && !m.system;
}

const errorCode = (err: unknown) => (err as { code?: number }).code;

export async function startDiscord(
  hub: ServerHub,
  db: Db,
  restarts: RestartScheduler,
  links: Links,
  cfg: DiscordConfig,
  token: string,
): Promise<DiscordFrontend> {
  const serverByChannel = new Map(Object.entries(cfg.channels).map(([serverId, channelId]) => [channelId, serverId]));
  const webhooks = new Map<string, Webhook>(); // serverId -> relay webhook
  const refusedNames = new Set<string>(); // player names Discord won't accept as a webhook username
  const topics = new Map<string, TopicEdit>(); // channelId -> last edit
  let presence = '';
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [] }, // nothing the bot posts can ping anyone
  });

  async function post(serverId: string, message: Post, files: string[] = []): Promise<void> {
    const channelId = cfg.channels[serverId];
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId);
    if (channel?.isSendable()) await channel.send({ ...message, files });
  }

  const postSafe = (serverId: string, message: Post): void => {
    post(serverId, message).catch((err) => console.error(`[discord] post for ${serverId} failed:`, err));
  };

  // Game chat goes through the channel's webhook, with the player's name and skin; falls back to the bot.
  async function relayChat(e: Extract<HubEvent, { type: 'chat' }>): Promise<void> {
    const hook = webhooks.get(e.serverId);
    if (hook && !refusedNames.has(e.player)) {
      try {
        await hook.send({
          username: e.player,
          avatarURL: `https://mc-heads.net/avatar/${encodeURIComponent(e.player)}/64`,
          content: md(e.message),
          allowedMentions: { parse: [] },
        });
        return;
      } catch (err) {
        // A deleted webhook is forgotten; a refused name is remembered, so neither is retried per message.
        if (errorCode(err) === UNKNOWN_WEBHOOK) webhooks.delete(e.serverId);
        if (errorCode(err) === INVALID_FORM_BODY) refusedNames.add(e.player);
        console.warn(`[discord] webhook send failed, posting as the bot: ${(err as Error).message}`);
      }
    }
    await post(e.serverId, formatEvent(e)!);
  }

  async function postCrash(serverId: string, message: Post): Promise<void> {
    const files = cfg.dirs[serverId] ? await findCrashLogs(cfg.dirs[serverId], Date.now() - CRASH_LOG_WINDOW_MS) : [];
    const withNote: Post =
      files.length && 'embeds' in message
        ? { embeds: [{ ...message.embeds[0], description: `Crash logs attached: ${files.map((f) => basename(f)).join(', ')}` }] }
        : message;
    try {
      await post(serverId, withNote, files);
    } catch (err) {
      if (!files.length) throw err;
      console.warn(`[discord] crash log upload failed, posting without it: ${(err as Error).message}`);
      await post(serverId, message);
    }
  }

  hub.on('event', (e) => {
    if (e.type === 'chat') {
      relayChat(e).catch((err) => console.error('[discord] chat relay failed:', err));
      return;
    }
    const message = formatEvent(e);
    if (!message) return;
    if (e.type === 'crashed') postCrash(e.serverId, message).catch((err) => console.error('[discord] crash post failed:', err));
    else postSafe(e.serverId, message);
  });

  client.on(Events.MessageCreate, (m) => {
    const serverId = serverByChannel.get(m.channelId);
    if (!serverId || !shouldRelay(m)) return;
    const text = [m.cleanContent, ...m.attachments.map((a) => a.url)].join(' ');
    // Linked people appear in game under their Minecraft name.
    hub.say(serverId, db.linkByDiscord(m.author.id)?.player ?? m.member?.displayName ?? m.author.username, text);
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
    const now = Date.now();
    if (i.commandName === 'status') {
      await i.reply(formatStatus(state, db.uptime(serverId, now - DAY, now), db.uptime(serverId, now - 7 * DAY, now)));
      return;
    }
    if (i.commandName === 'list') {
      await i.reply(state.online ? formatPlayers(state.players) : formatNotice(`🔴 ${state.name} is offline`));
      return;
    }
    if (i.commandName === 'tps') {
      await i.reply(
        formatTps(state, db.tpsSince(serverId, now - HOUR), db.tpsStats(serverId, now - HOUR, now), db.tpsStats(serverId, now - DAY, now)),
      );
      return;
    }
    if (i.commandName === 'link') {
      const code = links.issue(i.user.id, i.user.username);
      await i.reply({ content: `In game, type \`/discord link ${code}\` within 10 minutes.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.commandName === 'unlink') {
      const removed = links.unlinkDiscord(i.user.id);
      await i.reply({ content: removed ? 'Unlinked.' : "You weren't linked.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.commandName === 'playtime') {
      const user = i.options.getUser('user');
      const player = user ? db.linkByDiscord(user.id)?.player : (i.options.getString('player') ?? undefined);
      if (!player) {
        const content = user ? `${user.username} hasn't linked a Minecraft account (use /link).` : 'Give a player name or a Discord user.';
        await i.reply({ content, flags: MessageFlags.Ephemeral });
        return;
      }
      await i.reply(
        formatPlaytime(
          player,
          db.playtime(serverId, player, 0, now),
          db.playtime(serverId, player, now - 7 * DAY, now),
          db.lastSeen(serverId, player),
          now,
        ),
      );
      return;
    }
    if (i.commandName === 'top') {
      const period = (i.options.getString('period') ?? 'week') as keyof typeof TOP_PERIODS;
      const from = period === 'day' ? now - DAY : period === 'week' ? now - 7 * DAY : 0;
      await i.reply(formatTop(period, db.top(serverId, from, now, 10)));
      return;
    }
    if (!ADMIN_COMMANDS.has(i.commandName)) return;
    if (!i.inCachedGuild() || !i.member.roles.cache.has(cfg.adminRoleId)) {
      await i.reply({ content: 'You need the admin role for this.', flags: MessageFlags.Ephemeral });
      return;
    }
    const audit = `discord:${i.user.username} (${i.user.id})`;
    if (i.commandName === 'cmd') {
      await i.deferReply(); // commands can take longer than Discord's 3 s reply window
      try {
        // Replies that arrive later (e.g. spark's profiler link) are posted as follow-ups.
        const onLate = (lines: string[]) => {
          i.followUp(formatOutput(lines)).catch((err) => console.error('[discord] late output follow-up failed:', err));
        };
        await i.editReply(formatOutput(await hub.runCommand(serverId, i.options.getString('command', true), audit, onLate)));
      } catch (err) {
        await i.editReply(`❌ ${(err as Error).message}`);
      }
    } else if (i.commandName === 'restart') {
      // The public announcement comes from the scheduler's notice; the reply is just for the admin.
      let reply: string;
      if (i.options.getSubcommand() === 'cancel') {
        reply = restarts.cancel(serverId, i.user.username) ? 'Restart cancelled.' : 'No restart is scheduled.';
      } else {
        try {
          restarts.schedule(serverId, i.options.getInteger('minutes', true), audit, i.user.username);
          reply = 'Restart scheduled.';
        } catch (err) {
          reply = `❌ ${(err as Error).message}`;
        }
      }
      await i.reply({ content: reply, flags: MessageFlags.Ephemeral });
    } else if (i.commandName === 'backup') {
      const dir = cfg.backupDirs[serverId];
      if (!dir) {
        await i.reply({ content: 'Set "dir" (or "backupDir") for this server in config.json.', flags: MessageFlags.Ephemeral });
        return;
      }
      const sub = i.options.getSubcommand();
      if (sub === 'status') {
        await i.reply(formatBackupStatus(await listBackups(dir), Date.now()));
      } else if (sub === 'list') {
        await i.reply(formatBackupList(await listBackups(dir)));
      } else {
        await i.deferReply();
        try {
          // The "finished"/"failed" notice follows in the channel, from the mod's backup event.
          await i.editReply(formatOutput(await hub.runCommand(serverId, 'backup start', audit)));
        } catch (err) {
          await i.editReply(`❌ ${(err as Error).message}`);
        }
      }
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
        const hint = errorCode(err) === MISSING_PERMISSIONS ? ' (the bot needs Manage Channels)' : '';
        console.warn(`[discord] topic update for ${s.id} failed${hint}: ${(err as Error).message}`);
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
  return {
    client,
    notice: (serverId, text) => postSafe(serverId, formatNotice(text)),
    summary: (serverId, s) => postSafe(serverId, formatSummary(hub.get(serverId)?.name ?? serverId, s)),
    quests: (batch) => postSafe(batch.serverId, formatQuests(batch)),
    linked: (serverId, player, discordId) => postSafe(serverId, formatLinked(player, discordId)),
  };
}
```

`hub/src/index.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupNotice, BackupWatcher, listBackups } from './backups.ts';
import { everyDay, parseDaily } from './daily.ts';
import { Db, type State } from './db.ts';
import { startDiscord } from './discord.ts';
import { DEFAULT_LAG, LagMonitor, type LagConfig } from './lag.ts';
import { Links } from './links.ts';
import { PlaytimeTracker } from './playtime.ts';
import { QUEST_MODES, QuestAnnouncer, type QuestBatch, type QuestMode } from './quests.ts';
import { RestartScheduler } from './restarts.ts';
import { ServerHub, type Lifecycle, type ServerConfig } from './servers.ts';
import { buildSummary } from './summary.ts';

type Config = {
  listenPort: number;
  dbPath: string;
  guildId: string;
  adminRoleId: string;
  servers: (ServerConfig & {
    channelId: string;
    dir?: string;
    dailyRestart?: string;
    dailySummary?: string;
    backupDir?: string;
    backupMaxAgeHours?: number;
    lagTps?: number;
    lagMinutes?: number;
    lagAlerts?: boolean;
    quests?: QuestMode;
  })[];
};

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is not set');
const config = JSON.parse(readFileSync(process.argv[2] ?? 'config.json', 'utf8')) as Config;
for (const s of config.servers) {
  if (s.dailySummary !== undefined && !parseDaily(s.dailySummary)) {
    throw new Error(`server "${s.id}": dailySummary must be HH:MM (24-hour), got "${s.dailySummary}"`);
  }
  if (s.quests !== undefined && !QUEST_MODES.includes(s.quests)) {
    throw new Error(`server "${s.id}": quests must be one of ${QUEST_MODES.join(', ')}, got "${s.quests}"`);
  }
  if (s.lagTps !== undefined && !(s.lagTps > 0 && s.lagTps <= 20)) throw new Error(`server "${s.id}": lagTps must be 1–20`);
  if (s.lagMinutes !== undefined && !(Number.isInteger(s.lagMinutes) && s.lagMinutes >= 1)) {
    throw new Error(`server "${s.id}": lagMinutes must be a whole number of at least 1`);
  }
}
const lagConfigs: Record<string, LagConfig> = Object.fromEntries(
  config.servers.map((s) => [
    s.id,
    { tps: s.lagTps ?? DEFAULT_LAG.tps, minutes: s.lagMinutes ?? DEFAULT_LAG.minutes, enabled: s.lagAlerts ?? true },
  ]),
);
const backupDirs: Record<string, string> = Object.fromEntries(
  config.servers.flatMap((s) => {
    const dir = s.backupDir ?? (s.dir ? join(s.dir, 'backups') : undefined);
    return dir ? [[s.id, dir]] : [];
  }),
);

const db = new Db(config.dbPath);
db.markHubRestart(config.servers.map((s) => s.id)); // also ends sessions left open when the hub last stopped
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

// Hub-core output goes to Discord, which is connected below; until then it goes nowhere.
let notice: (serverId: string, text: string) => void = () => {};
let postQuests: (batch: QuestBatch) => void = () => {};
let postLinked: (serverId: string, player: string, discordId: string) => void = () => {};
const notify = (serverId: string, text: string) => notice(serverId, text);
const restarts = new RestartScheduler(hub, notify);
for (const s of config.servers) if (s.dailyRestart) restarts.daily(s.id, s.dailyRestart); // throws on a bad time
const backups = new BackupWatcher((serverId) => listBackups(backupDirs[serverId] ?? ''), notify);
for (const s of config.servers) {
  if (s.backupMaxAgeHours && backupDirs[s.id]) backups.watchdog(s.id, s.backupMaxAgeHours);
}
const playtime = new PlaytimeTracker(hub, db);
const lag = new LagMonitor(hub, db, lagConfigs, notify);
const quests = new QuestAnnouncer(
  Object.fromEntries(config.servers.map((s) => [s.id, s.quests ?? 'batched'])),
  (batch) => postQuests(batch),
);
const links = new Links(db, hub, (serverId, player, discordId) => postLinked(serverId, player, discordId));
hub.on('event', (e) => {
  if (e.type === 'quest') quests.add(e.serverId, e.player, e.quests);
  else if (e.type === 'backup') notify(e.serverId, backupNotice(e.ok, e.detail));
});

const port = await hub.listen(config.listenPort);
console.log(`[hub] listening on 127.0.0.1:${port}`);
playtime.start();
lag.start();
quests.start();

const discord = await startDiscord(
  hub,
  db,
  restarts,
  links,
  {
    guildId: config.guildId,
    adminRoleId: config.adminRoleId,
    channels: Object.fromEntries(config.servers.map((s) => [s.id, s.channelId])),
    dirs: Object.fromEntries(config.servers.flatMap((s) => (s.dir ? [[s.id, s.dir]] : []))),
    backupDirs,
  },
  token,
);
notice = discord.notice;
postQuests = discord.quests;
postLinked = discord.linked;
const summaries = config.servers.flatMap((s) =>
  s.dailySummary ? [everyDay(s.dailySummary, 0, (target) => discord.summary(s.id, buildSummary(db, s.id, target)))] : [],
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    restarts.stop();
    backups.stop();
    playtime.stop();
    lag.stop();
    quests.flush(); // don't lose a pending roll-up
    quests.stop();
    for (const cancel of summaries) cancel();
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
      "dailyRestart": "06:00",
      "dailySummary": "09:00",
      "backupMaxAgeHours": 26,
      "lagTps": 15,
      "lagMinutes": 2,
      "quests": "batched"
    }
  ]
}
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 107`, `ℹ fail 0`, and `tsc` prints nothing.

Smoke check:
```bash
cd hub && cp config.example.json config.json
DISCORD_TOKEN=bogus timeout 10 node src/index.ts           # "[hub] listening …", then TokenInvalid
sed 's/"batched"/"loud"/' config.example.json > bad.json
DISCORD_TOKEN=bogus timeout 10 node src/index.ts bad.json  # quests must be one of …, and no "listening"
node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('hub.db').prepare(\"select name from sqlite_master where type='table'\").all().map(r=>r.name).join(','))"
                                                          # events,meta,sessions,peaks,tps,links
rm -f config.json bad.json hub.db
```

- [ ] **Step 5: Commit**

```bash
git add hub/src/backups.ts hub/src/format.ts hub/src/discord.ts hub/src/index.ts hub/config.example.json hub/test/backups.test.ts hub/test/format.test.ts hub/test/discord.test.ts
git commit -m "feat(hub): /tps, /link, /unlink, quest and backup posts, late /cmd follow-ups"
```

---

### Task 6: Mod — dims, quests, linking, backup events, late output

**Files:**
- Modify: `mod/dependencies.gradle` (BetterQuesting, `compileOnly`)
- Create: `mod/src/main/java/io/github/edwardpratt/gtnhdiscord/QuestNames.java`, `QuestEvents.java`, `BackupLogWatcher.java`, `DiscordCommand.java`
- Modify: `mod/src/main/java/io/github/edwardpratt/gtnhdiscord/CommandOutput.java` (late phase), `GameEvents.java` (late list, `dims`, `linkResult`), `GtnhDiscord.java` (appender, command, quest listener)
- Test: `mod/src/test/java/io/github/edwardpratt/gtnhdiscord/CommandOutputTest.java`, `QuestNamesTest.java`, `BackupLogWatcherTest.java`

**Interfaces:**
- Produces:
  - `CommandOutput.lateReady(now)`, `expired(now)`, `hasUnsent()`, `takeUnsent()`, and `LATE_MS = 5 min`
  - `QuestNames.resolve(langKey, nameProperty, canTranslate, translate)`
  - `BackupLogWatcher.toMessage(text, thrown)` and `attach(send)`
  - `DiscordCommand.tell(player, ok, message)`

- [ ] **Step 1: Add the dependency and write the failing tests**

`mod/dependencies.gradle`:

```groovy
dependencies {
    // Optional integration: compiled against, never bundled. QuestEvents only loads if BetterQuesting is installed.
    compileOnly("com.github.GTNewHorizons:BetterQuesting:3.8.87-GTNH:dev") { transitive = false }

    testImplementation(platform("org.junit:junit-bom:5.13.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.named("test", Test) { useJUnitPlatform() }
```

`mod/src/test/java/io/github/edwardpratt/gtnhdiscord/CommandOutputTest.java`, the full file (the late-phase test is at the end):

```java
package io.github.edwardpratt.gtnhdiscord;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;

import org.junit.jupiter.api.Test;

class CommandOutputTest {

    @Test
    void readyAfterAQuietWindowEvenWithNoOutput() {
        CommandOutput out = new CommandOutput("1", 0);
        assertFalse(out.ready(CommandOutput.QUIET_MS - 1));
        assertTrue(out.ready(CommandOutput.QUIET_MS));
        assertEquals(
            0,
            out.lines()
                .size());
    }

    @Test
    void eachNewLineRestartsTheQuietWindow() {
        CommandOutput out = new CommandOutput("1", 0);
        out.add("a", 1000);
        assertFalse(out.ready(2000));
        out.add("b", 2000);
        assertFalse(out.ready(3000));
        assertTrue(out.ready(2000 + CommandOutput.QUIET_MS));
        assertEquals(Arrays.asList("a", "b"), out.lines());
    }

    @Test
    void alwaysReadyByTheMaxWindow() {
        CommandOutput out = new CommandOutput("1", 0);
        for (long t = 0; t < CommandOutput.MAX_MS; t += 500) out.add("line", t);
        assertFalse(out.ready(CommandOutput.MAX_MS - 1));
        assertTrue(out.ready(CommandOutput.MAX_MS));
    }

    @Test
    void acceptsLinesFromAnotherThread() throws InterruptedException {
        // Like spark: the reply comes from a worker thread after the command call returned.
        final CommandOutput out = new CommandOutput("1", System.currentTimeMillis());
        Thread worker = new Thread(
            () -> { for (int i = 0; i < 1000; i++) out.add("line " + i, System.currentTimeMillis()); });
        worker.start();
        worker.join();
        assertEquals(
            1000,
            out.lines()
                .size());
        assertEquals(
            "line 999",
            out.lines()
                .get(999));
    }

    @Test
    void lateLinesComeOutInQuietBatchesUntilExpiry() {
        CommandOutput out = new CommandOutput("1", 0);
        out.add("Profiler started", 100);
        assertEquals(Arrays.asList("Profiler started"), out.takeUnsent()); // the first result
        assertFalse(out.lateReady(5000)); // nothing new
        out.add("Uploading…", 30_000);
        out.add("https://spark.lucko.me/abc", 30_500);
        assertFalse(out.lateReady(31_000)); // not quiet yet
        assertTrue(out.lateReady(30_500 + CommandOutput.QUIET_MS));
        assertEquals(Arrays.asList("Uploading…", "https://spark.lucko.me/abc"), out.takeUnsent());
        assertFalse(out.hasUnsent());
        assertFalse(out.expired(CommandOutput.LATE_MS - 1));
        assertTrue(out.expired(CommandOutput.LATE_MS));
    }
}
```

`mod/src/test/java/io/github/edwardpratt/gtnhdiscord/QuestNamesTest.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;

class QuestNamesTest {

    static final Map<String, String> LANG = new HashMap<>();
    static {
        LANG.put("betterquesting.quest.AAA.name", "Stone Age");
        LANG.put("gtnh.quest.bronze", "Bronze Age");
    }

    static String resolve(String key, String property) {
        return QuestNames.resolve(key, property, LANG::containsKey, LANG::get);
    }

    @Test
    void prefersTheQuestLangKey() {
        assertEquals("Stone Age", resolve("betterquesting.quest.AAA.name", "Something else"));
    }

    @Test
    void thenTheTranslatedOrLiteralNameProperty() {
        assertEquals("Bronze Age", resolve("betterquesting.quest.BBB.name", "gtnh.quest.bronze"));
        assertEquals("Get some wood", resolve("betterquesting.quest.BBB.name", "Get some wood"));
    }

    @Test
    void fallsBackWhenOnlyUntranslatedKeysAreLeft() {
        assertEquals(QuestNames.FALLBACK, resolve("betterquesting.quest.BBB.name", "untitled.name"));
        assertEquals(QuestNames.FALLBACK, resolve("betterquesting.quest.BBB.name", ""));
        assertEquals(QuestNames.FALLBACK, resolve("betterquesting.quest.BBB.name", null));
    }

    @Test
    void recognisesKeys() {
        assertTrue(QuestNames.looksLikeKey("untitled.name"));
        assertFalse(QuestNames.looksLikeKey("Stone Age. Part 2"));
        assertFalse(QuestNames.looksLikeKey("Wood"));
    }
}
```

`mod/src/test/java/io/github/edwardpratt/gtnhdiscord/BackupLogWatcherTest.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.io.IOException;

import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;

class BackupLogWatcherTest {

    @Test
    void doneLinesBecomeSuccessWithServerUtilitiesDetail() {
        JsonObject msg = BackupLogWatcher.toMessage("Backup done in 12.3 seconds (1.2GB)!", null);
        assertEquals("backup", HubClient.str(msg, "type"));
        assertEquals(
            true,
            msg.get("ok")
                .getAsBoolean());
        assertEquals("12.3 seconds (1.2GB)", HubClient.str(msg, "detail"));
    }

    @Test
    void errorLinesBecomeFailureWithTheExceptionMessage() {
        JsonObject msg = BackupLogWatcher
            .toMessage("Error while backing up", new IOException("No space left on device"));
        assertEquals(
            false,
            msg.get("ok")
                .getAsBoolean());
        assertEquals("No space left on device", HubClient.str(msg, "detail"));
        assertEquals(
            "unknown error",
            HubClient.str(BackupLogWatcher.toMessage("Error while backing up", null), "detail"));
    }

    @Test
    void otherLinesAreIgnored() {
        assertNull(BackupLogWatcher.toMessage("Backups folder - /home/opc/GTNH/backups", null));
        assertNull(BackupLogWatcher.toMessage(null, null));
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd mod && ./gradlew --console=plain test`
Expected: FAIL at `compileTestJava`, with `cannot find symbol` for `QuestNames`, `BackupLogWatcher` and `takeUnsent`.

- [ ] **Step 3: Implement**

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/CommandOutput.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import java.util.ArrayList;
import java.util.List;

/**
 * The replies to one {@code /cmd}. Some mods (spark) answer from a worker thread after the command has returned,
 * so lines can arrive from any thread. The first result is sent once replies go quiet or a hard limit passes;
 * lines after that are sent as "late" batches for a while longer. No Minecraft classes, so it is unit-testable.
 */
final class CommandOutput {

    /** Send once this long passes without a new line (counted from the start if there are none yet). */
    static final long QUIET_MS = 1500;
    /** Always send the first result by now: below the hub's 10 s command timeout. */
    static final long MAX_MS = 8000;
    /** Keep collecting late lines (e.g. spark's profiler link) this long after the start. */
    static final long LATE_MS = 5 * 60_000;

    final String id;
    private final long startedAt;
    private final List<String> lines = new ArrayList<>();
    private long lastLineAt;
    private int sent; // lines already sent

    CommandOutput(String id, long now) {
        this.id = id;
        this.startedAt = now;
        this.lastLineAt = now;
    }

    synchronized void add(String line, long now) {
        lines.add(line);
        lastLineAt = now;
    }

    /** First phase: time to send the result. */
    synchronized boolean ready(long now) {
        return now - lastLineAt >= QUIET_MS || now - startedAt >= MAX_MS;
    }

    /** Late phase: unsent lines have gone quiet. */
    synchronized boolean lateReady(long now) {
        return sent < lines.size() && now - lastLineAt >= QUIET_MS;
    }

    synchronized boolean expired(long now) {
        return now - startedAt >= LATE_MS;
    }

    synchronized boolean hasUnsent() {
        return sent < lines.size();
    }

    /** The lines not sent yet, marking them sent. */
    synchronized List<String> takeUnsent() {
        List<String> out = new ArrayList<>(lines.subList(sent, lines.size()));
        sent = lines.size();
        return out;
    }

    /** Every line so far. */
    synchronized List<String> lines() {
        return new ArrayList<>(lines);
    }
}
```

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/QuestNames.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import java.util.function.Predicate;
import java.util.function.UnaryOperator;

/**
 * Server-side quest names. BetterQuesting's own QuestTranslation uses the client-only I18n, so on a dedicated
 * server we go through the server's translation table instead. Pure (lookups are passed in) so it's unit-testable.
 */
final class QuestNames {

    static final String FALLBACK = "a quest";

    private QuestNames() {}

    /** The quest's lang key, then its name property (translated, or as-is if it isn't a key), then "a quest". */
    static String resolve(String langKey, String nameProperty, Predicate<String> canTranslate,
        UnaryOperator<String> translate) {
        if (canTranslate.test(langKey)) return translate.apply(langKey);
        if (nameProperty != null && !nameProperty.trim()
            .isEmpty()) {
            if (canTranslate.test(nameProperty)) return translate.apply(nameProperty);
            if (!looksLikeKey(nameProperty)) return nameProperty;
        }
        return FALLBACK;
    }

    /** e.g. "untitled.name" or "betterquesting.quest.abc.name": an untranslated key, not a real name. */
    static boolean looksLikeKey(String s) {
        return s.indexOf('.') > 0 && s.matches("[A-Za-z0-9_.\\-]+");
    }
}
```

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/QuestEvents.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import java.util.UUID;
import java.util.function.Supplier;

import net.minecraft.util.StatCollector;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import betterquesting.api.api.ApiReference;
import betterquesting.api.api.QuestingAPI;
import betterquesting.api.events.QuestEvent;
import betterquesting.api.properties.NativeProps;
import betterquesting.api.questing.IQuest;
import betterquesting.api.utils.UuidConverter;
import betterquesting.questing.QuestDatabase;
import cpw.mods.fml.common.eventhandler.EventPriority;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;

/**
 * BetterQuesting completions → {@code quest} messages. The only class that touches BetterQuesting types, and it is
 * only loaded when BetterQuesting is installed (see GtnhDiscord.serverStarting). Public because Forge's event bus
 * generates its caller in another package.
 */
public final class QuestEvents {

    private static final int MAX_QUESTS = 50; // the hub rejects larger messages

    private final Supplier<HubClient> client;

    QuestEvents(Supplier<HubClient> client) {
        this.client = client;
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onQuest(QuestEvent e) {
        try {
            // BetterQuesting also posts COMPLETED with an empty set on every check.
            if (e.getType() != QuestEvent.Type.COMPLETED || e.getQuestIDs()
                .isEmpty()) return;
            HubClient c = client.get();
            if (c == null) return;
            JsonArray quests = new JsonArray();
            for (UUID id : e.getQuestIDs()) {
                IQuest quest = QuestDatabase.INSTANCE.get(id);
                if (quest == null || Boolean.TRUE.equals(quest.getProperty(NativeProps.SILENT))) continue;
                String key = "betterquesting.quest." + UuidConverter.encodeUuidStripPadding(id) + ".name";
                JsonObject q = new JsonObject();
                q.addProperty(
                    "name",
                    QuestNames.resolve(
                        key,
                        quest.getProperty(NativeProps.NAME),
                        StatCollector::canTranslate,
                        StatCollector::translateToLocal));
                q.addProperty("main", Boolean.TRUE.equals(quest.getProperty(NativeProps.MAIN)));
                quests.add(q);
                if (quests.size() == MAX_QUESTS) break;
            }
            if (quests.size() == 0) return;
            String player = QuestingAPI.getAPI(ApiReference.NAME_CACHE)
                .getName(e.getPlayerID());
            if (player == null || player.isEmpty()) return;
            JsonObject msg = GameEvents.msg("quest", "player", player);
            msg.add("quests", quests);
            c.send(msg);
        } catch (RuntimeException ex) {
            GtnhDiscord.LOG.error("Discord bridge quest handler failed", ex);
        }
    }
}
```

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/BackupLogWatcher.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import java.util.function.Consumer;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.Logger;
import org.apache.logging.log4j.core.appender.AbstractAppender;

import com.google.gson.JsonObject;

/**
 * Turns ServerUtilities' own backup log lines into {@code backup} messages: it logs "Backup done in …" and
 * "Error while backing up" on its "Server Utilities" logger, but reports them to players only as chat.
 */
final class BackupLogWatcher extends AbstractAppender {

    static final String LOGGER = "Server Utilities";
    private static final String DONE = "Backup done in ";
    private static final String FAILED = "Error while backing up";

    private final Consumer<JsonObject> send;

    private BackupLogWatcher(Consumer<JsonObject> send) {
        super("GTNHDiscord-backups", null, null);
        this.send = send;
    }

    /** Attaches to ServerUtilities' logger. Harmless without ServerUtilities: that logger then never logs these. */
    static void attach(Consumer<JsonObject> send) {
        BackupLogWatcher appender = new BackupLogWatcher(send);
        appender.start();
        ((Logger) LogManager.getLogger(LOGGER)).addAppender(appender);
    }

    @Override
    public void append(LogEvent event) {
        try {
            JsonObject msg = toMessage(
                event.getMessage()
                    .getFormattedMessage(),
                event.getThrown());
            if (msg != null) send.accept(msg);
        } catch (RuntimeException ignored) {
            // never break logging
        }
    }

    /** The backup message for a log line, or null if it isn't one. */
    static JsonObject toMessage(String text, Throwable thrown) {
        if (text == null) return null;
        if (text.startsWith(DONE)) {
            String detail = text.substring(DONE.length())
                .trim();
            if (detail.endsWith("!")) detail = detail.substring(0, detail.length() - 1);
            return backup(true, detail);
        }
        if (text.startsWith(FAILED)) {
            String detail = thrown != null && thrown.getMessage() != null ? thrown.getMessage() : "unknown error";
            return backup(false, detail);
        }
        return null;
    }

    private static JsonObject backup(boolean ok, String detail) {
        JsonObject o = GameEvents.msg("backup", "detail", detail);
        o.addProperty("ok", ok);
        return o;
    }
}
```

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/DiscordCommand.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import java.util.function.Supplier;

import net.minecraft.command.CommandBase;
import net.minecraft.command.ICommandSender;
import net.minecraft.command.WrongUsageException;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.ChatComponentText;
import net.minecraft.util.ChatStyle;
import net.minecraft.util.EnumChatFormatting;

/** {@code /discord link <code>} and {@code /discord unlink}, for players. The hub answers with linkResult. */
final class DiscordCommand extends CommandBase {

    private final Supplier<HubClient> client;

    DiscordCommand(Supplier<HubClient> client) {
        this.client = client;
    }

    @Override
    public String getCommandName() {
        return "discord";
    }

    @Override
    public String getCommandUsage(ICommandSender sender) {
        return "/discord link <code> | /discord unlink";
    }

    @Override
    public int getRequiredPermissionLevel() {
        return 0;
    }

    @Override
    public boolean canCommandSenderUseCommand(ICommandSender sender) {
        return sender instanceof EntityPlayerMP;
    }

    @Override
    public void processCommand(ICommandSender sender, String[] args) {
        EntityPlayerMP player = getCommandSenderAsPlayer(sender);
        boolean link = args.length == 2 && args[0].equalsIgnoreCase("link");
        boolean unlink = args.length == 1 && args[0].equalsIgnoreCase("unlink");
        if (!link && !unlink) throw new WrongUsageException(getCommandUsage(sender));
        HubClient c = client.get();
        if (c == null || !c.isConnected()) {
            tell(player, false, "Discord bridge offline, try again later.");
            return;
        }
        String name = player.getCommandSenderName();
        if (link) {
            c.send(
                GameEvents.msg(
                    "link",
                    "player",
                    name,
                    "uuid",
                    player.getGameProfile()
                        .getId()
                        .toString(),
                    "code",
                    args[1]));
            tell(player, true, "Linking…");
        } else {
            c.send(GameEvents.msg("unlink", "player", name));
        }
    }

    static void tell(EntityPlayerMP player, boolean ok, String message) {
        ChatComponentText text = new ChatComponentText("[Discord] " + message);
        text.setChatStyle(new ChatStyle().setColor(ok ? EnumChatFormatting.GREEN : EnumChatFormatting.RED));
        player.addChatMessage(text);
    }
}
```

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/GameEvents.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.network.rcon.RConConsoleSource;
import net.minecraft.server.MinecraftServer;
import net.minecraft.stats.StatisticsFile;
import net.minecraft.util.ChatComponentText;
import net.minecraft.util.ChatStyle;
import net.minecraft.util.EnumChatFormatting;
import net.minecraft.util.IChatComponent;
import net.minecraft.util.MathHelper;
import net.minecraft.world.WorldServer;
import net.minecraftforge.common.DimensionManager;
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
    /** Commands still collecting replies. Server thread only (the replies themselves may come from any thread). */
    private final List<CommandOutput> pending = new ArrayList<>();
    /** Commands whose result was sent, still collecting late replies. Server thread only. */
    private final List<CommandOutput> late = new ArrayList<>();

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
            long now = System.currentTimeMillis();
            for (Iterator<CommandOutput> it = pending.iterator(); it.hasNext();) {
                CommandOutput out = it.next();
                if (out.ready(now)) {
                    send("cmdResult", out);
                    it.remove();
                    late.add(out);
                }
            }
            for (Iterator<CommandOutput> it = late.iterator(); it.hasNext();) {
                CommandOutput out = it.next();
                if (out.lateReady(now)) send("cmdLate", out);
                if (out.expired(now)) it.remove();
            }
            // Sent from the tick so that a frozen tick loop stops heartbeats (that is how the hub spots a hang).
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
            final CommandOutput output = new CommandOutput(HubClient.str(in, "id"), System.currentTimeMillis());
            // Vanilla's RCON sender: op-level, real world and coordinates. We only capture its replies per line,
            // including ones that arrive later from another thread (the result waits for them; see CommandOutput).
            RConConsoleSource sender = new RConConsoleSource() {

                @Override
                public String getCommandSenderName() {
                    return "Discord";
                }

                @Override
                public void addChatMessage(IChatComponent message) {
                    output.add(message.getUnformattedText(), System.currentTimeMillis());
                }
            };
            server.getCommandManager()
                .executeCommand(sender, HubClient.str(in, "command"));
            pending.add(output);
        } else if (type.equals("linkResult")) {
            EntityPlayerMP player = server.getConfigurationManager()
                .func_152612_a(HubClient.str(in, "player")); // getPlayerByUsername
            if (player != null) DiscordCommand.tell(
                player,
                in.has("ok") && in.get("ok")
                    .getAsBoolean(),
                HubClient.str(in, "message"));
        }
    }

    /** Sends every pending command result and late line now: on shutdown ticks stop, so they'd never go. */
    void flushPending() {
        for (CommandOutput out : pending) send("cmdResult", out);
        for (CommandOutput out : late) if (out.hasUnsent()) send("cmdLate", out);
        pending.clear();
        late.clear();
    }

    /** cmdResult or cmdLate with the lines not sent yet. */
    private void send(String type, CommandOutput out) {
        JsonObject result = msg(type, "id", out.id);
        JsonArray lines = new JsonArray();
        for (String s : out.takeUnsent()) lines.add(new JsonPrimitive(s));
        result.add("output", lines);
        client.send(result);
    }

    private static JsonObject heartbeat(MinecraftServer server) {
        double msPerTick = MathHelper.average(server.tickTimeArray) * 1.0E-6D; // tickTimeArray is nanoseconds
        JsonObject o = msg("heartbeat");
        o.addProperty("tps", Math.min(20.0, 1000.0 / Math.max(msPerTick, 0.001)));
        JsonArray players = new JsonArray();
        for (String name : server.getAllUsernames()) players.add(new JsonPrimitive(name));
        o.add("players", players);
        o.add("dims", slowestDims(server));
        return o;
    }

    /** The 5 slowest dimensions by mean tick time (Forge's per-dimension worldTickTimes, nanoseconds). */
    private static JsonArray slowestDims(MinecraftServer server) {
        List<Map.Entry<Integer, long[]>> dims = new ArrayList<>(server.worldTickTimes.entrySet());
        dims.sort((a, b) -> Double.compare(MathHelper.average(b.getValue()), MathHelper.average(a.getValue())));
        JsonArray out = new JsonArray();
        for (Map.Entry<Integer, long[]> d : dims.subList(0, Math.min(5, dims.size()))) {
            WorldServer world = DimensionManager.getWorld(d.getKey());
            String name = world != null ? world.provider.getDimensionName() : "DIM " + d.getKey();
            JsonObject dim = new JsonObject();
            dim.addProperty("id", d.getKey());
            dim.addProperty("name", name == null || name.isEmpty() ? "DIM " + d.getKey() : name);
            dim.addProperty("ms", MathHelper.average(d.getValue()) * 1.0E-6D);
            out.add(dim);
        }
        return out;
    }
}
```

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/GtnhDiscord.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.common.config.Configuration;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.Loader;
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
    private volatile HubClient client; // read from the log appender and command threads
    private GameEvents events;
    private Object questEvents; // a QuestEvents, typed Object so BetterQuesting classes load only when installed

    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        Configuration config = new Configuration(event.getSuggestedConfigurationFile());
        String general = Configuration.CATEGORY_GENERAL;
        hubHost = config.getString("hubHost", general, "127.0.0.1", "Address of the gtnh-discord hub");
        hubPort = config.getInt("hubPort", general, 25580, 1, 65535, "TCP port of the hub");
        serverId = config.getString("serverId", general, "gtnh", "This server's id in the hub's config.json");
        token = config.getString("token", general, "", "This server's token from the hub's config.json");
        if (config.hasChanged()) config.save();
        // ServerUtilities logs backup results but only tells players; forward them to the hub.
        BackupLogWatcher.attach(msg -> {
            HubClient c = client;
            if (c != null) c.send(msg);
        });
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
        event.registerServerCommand(new DiscordCommand(() -> client));
        if (Loader.isModLoaded("betterquesting")) {
            questEvents = new QuestEvents(() -> client);
            MinecraftForge.EVENT_BUS.register(questEvents);
        }
        client.start();
        // SIGTERM (systemctl stop, Ctrl+C): vanilla's shutdown hook calls stopServer() directly, so
        // FMLServerStoppingEvent never fires. Announce the stop here too. Harmless after a clean /stop or a crash:
        // the client is already stopped, so this send is never delivered.
        final HubClient c = client;
        Runtime.getRuntime()
            .addShutdownHook(new Thread(() -> announceStop(c), "GTNHDiscord-shutdown"));
    }

    @Mod.EventHandler
    public void serverStarted(FMLServerStartedEvent event) {
        if (client != null) client.send(GameEvents.msg("started"));
    }

    @Mod.EventHandler
    public void serverStopping(FMLServerStoppingEvent event) {
        if (client == null) return;
        events.flushPending(); // e.g. `/cmd stop` gets its output before the connection closes
        announceStop(client);
    }

    /** Queues `stopping` and flushes it before the JVM can exit, so a clean stop never looks like a crash. */
    private static void announceStop(HubClient c) {
        c.send(GameEvents.msg("stopping"));
        c.stop(2000);
    }

    @Mod.EventHandler
    public void serverStopped(FMLServerStoppedEvent event) {
        if (client == null) return;
        client.stop(0); // no-op after a clean stop; after a crash, drops the connection right away
        MinecraftForge.EVENT_BUS.unregister(events);
        FMLCommonHandler.instance()
            .bus()
            .unregister(events);
        if (questEvents != null) MinecraftForge.EVENT_BUS.unregister(questEvents);
        questEvents = null;
        client = null;
        events = null;
    }
}
```

- [ ] **Step 4: Verify**

Run:
```bash
cd mod && ./gradlew --console=plain spotlessApply build
grep -ho 'testsuite name="[^"]*" tests="[0-9]*" skipped="[0-9]*" failures="[0-9]*" errors="[0-9]*"' build/test-results/test/*.xml
jar=$(ls -t build/libs/gtnhdiscord-*.jar | grep -v -e '-dev' -e '-sources' | head -1)
unzip -l "$jar" | awk '{print $4}' | grep -E "\.class$|betterquesting"
javap -cp "$jar" io.github.edwardpratt.gtnhdiscord.DiscordCommand | grep func_
javap -cp "$jar" io.github.edwardpratt.gtnhdiscord.QuestEvents | head -2
```
Expected:
- `BUILD SUCCESSFUL`.
- Test suites: CommandOutputTest 5, QuestNamesTest 4, BackupLogWatcherTest 3, HubClientTest 9, all with 0 failures and 0 errors.
- The jar lists our 10 classes and **nothing** under `betterquesting/`.
- `DiscordCommand` shows `func_71517_b`, `func_71518_a`, `func_82362_a`, `func_71519_b` and `func_71515_b`.
- `QuestEvents` is `public final class`.

- [ ] **Step 5: Commit**

```bash
git add mod/dependencies.gradle mod/src
git commit -m "feat(mod): dimension tick times, quest completions, /discord link, backup events, late /cmd output"
```

---

### Task 7: Docs, Node 24 check and manual smoke test

**Files:**
- Modify: `README.md`, `hub/CLAUDE.md`, `mod/CLAUDE.md`, `docs/ROADMAP.md`

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
  Alerts, status, stats and backups post as embeds; chat stays plain text.
- `/list` shows online players.
- `/playtime <player>` (or `user:@someone` who has linked) shows total
  playtime, the last 7 days and when they were last seen; `/top [day|week|all]`
  ranks players by playtime.
- `/tps` shows TPS now, the last hour and day, a trend line and the slowest
  dimensions. The channel gets `🐢 Lag` when TPS stays below 15 for 2 minutes
  (per server: `"lagTps"`, `"lagMinutes"`, `"lagAlerts": false`) and
  `✅ TPS back to normal` after.
- Quest completions (BetterQuesting): main quests post straight away; the rest
  are rolled up per player every 10 minutes. `"quests"` per server: `batched`
  (default), `main`, `all` or `off`.
- Account linking: `/link` gives you a code; type `/discord link <code>` in
  game within 10 minutes. Your Discord messages then show in game under your
  Minecraft name. `/unlink` (Discord) or `/discord unlink` (game) removes it.
- `/cmd` output that arrives later (e.g. `spark profiler` results) is posted as
  a follow-up, for up to 15 minutes.
- `/cmd <command>` runs a console command and shows its output. Admin role only.
  Every command is logged by the hub. The reply takes about 1.5 s: it waits for
  mods such as spark that answer a moment later.
- `/restart in <minutes>` restarts with in-game warnings at 10 / 5 / 1 min,
  30 s and 10 s; `/restart cancel` calls it off. Admin role only. Add
  `"dailyRestart": "06:00"` to a server in `config.json` for a daily restart
  at that local time (the countdown starts 10 minutes before).
- Alerts: started, stopped, went down unexpectedly (crash or kill), not
  responding (no heartbeat for 30 s), responding again. With `"dir"` set to
  the server's folder in `config.json`, a crash alert comes with the crash
  report and JVM error log (`hs_err_pid*.log`) attached.
- Every ServerUtilities backup, scheduled or not, posts `✅ Backup finished` or
  `❌ Backup failed`. `/backup start` starts one now; `/backup status` shows the newest backup, the count and the total
  size; `/backup list` shows the 10 newest. Admin role only. Backups are read
  from `"backupDir"`, or `<dir>/backups` if that isn't set. With
  `"backupMaxAgeHours": 26`, the bot warns once if no new backup appears for
  that long.
- `"dailySummary": "09:00"` posts yesterday's stats every day at that time:
  uptime, peak and unique players, total playtime, top players, starts and
  crashes.

Adding another game server: add an entry to `servers` in `config.json`,
restart the hub, and install the mod with that entry's `serverId` and token.

## Development

```bash
cd hub && npm test && npm run typecheck
cd mod && ./gradlew spotlessApply build   # build runs the JUnit tests
```

The wire protocol and design are in
`docs/superpowers/specs/2026-09-24-gtnh-discord-design.md`. What's planned next is in `docs/ROADMAP.md`.
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
| `src/db.ts` | SQLite (`node:sqlite`): up/down/unknown log and uptime math; player sessions, daily peaks and stats queries. Writes never throw. |
| `src/daily.ts` | `everyDay(time, leadMs, fn(target))`: DST-safe daily timers (used by restarts and the summary). Hub core. |
| `src/units.ts` | `formatDuration`, `formatBytes`, `localDay` (local calendar, not UTC). Hub core. |
| `src/playtime.ts` | `PlaytimeTracker`: syncs sessions with each server's live player list every 10 s. Hub core. |
| `src/summary.ts` | `buildSummary`: yesterday's stats, from the scheduled time. Hub core. |
| `src/backups.ts` | `listBackups`, `backupNotice` (from the mod's backup events), `BackupWatcher` (missing-backup watchdog). Hub core. |
| `src/lag.ts` | `LagMonitor`: 1/min TPS samples into the `tps` table, lag and recovery notices; `sparkline`. Hub core. |
| `src/quests.ts` | `QuestAnnouncer`: main quests at once, others per mode (`batched` rolls up every 10 min). Hub core. |
| `src/links.ts` | `Links`: link codes (6 chars, 10 min, guess cap), answers the mod's `link`/`unlink`. Hub core. |
| `src/restarts.ts` | `RestartScheduler`: countdown restarts (in-game `say` warnings, then `stop`) and daily restarts. Hub core. |
| `src/crashlogs.ts` | `findCrashLogs`: newest crash report / `hs_err_pid*.log` in a server folder. Hub core. |
| `src/format.ts` | Pure Discord output: `Post` = plain text or embeds; `md`, `format*`, `topicDue`. Unit-tested. |
| `src/discord.ts` | Discord frontend: webhook chat, alerts (+ crash-log uploads), presence, topics, notices as embeds, `/status` `/list` `/tps` `/playtime` `/top` `/link` `/unlink` `/cmd` `/restart` `/backup`; late `/cmd` output as follow-ups. |
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

`mod/CLAUDE.md`, the full file:

````markdown
# mod (gtnhdiscord)

Server-side-only Forge 1.7.10 mod, built from the GTNewHorizons ExampleMod1.7.10 template
(RetroFuturaGradle, Gradle 9.3.1). Package `io.github.edwardpratt.gtnhdiscord`, modid `gtnhdiscord`.

```bash
./gradlew spotlessApply build   # spotless is enforced; build also runs the JUnit 5 tests
./gradlew test
```

- Needs a full JDK 25 (`javac`). The jar to deploy is the newest `build/libs/gtnhdiscord-<version>.jar`
  (not `-dev`/`-sources`); version comes from `git describe`.
- Don't edit `build.gradle.kts`; project settings go in `gradle.properties` / `dependencies.gradle`.
- Checkstyle rejects wildcard imports.

## Java 8 runtime

`enableModernJavaSyntax = jabel`: modern *syntax* compiles to Java 8 bytecode, but Java 9+ *APIs*
(`List.of`, `String.isBlank`, …) will crash on Java 8 servers. Gson is 2.2.4: use `new JsonParser().parse(...)`
and `JsonArray.add(JsonElement)`.

## Minecraft names

MCP stable-12 mappings. Some methods have no readable name and must be called by SRG name, e.g.
`func_110142_aN()` (combat tracker), `func_151521_b()` (death message), `func_147099_x()` (stats file),
`func_150951_e()` (achievement name). Check signatures in the decompiled sources at
`build/rfg/minecraft-src/java/` (present after the first build) instead of guessing.

## Rules

- `HubClient` must not touch Minecraft classes (keeps it unit-testable; it runs on its own threads).
- Game state is only touched on the server thread: inbound `say`/`cmd` are drained in
  `ServerTickEvent` (phase END), which also emits the heartbeat. Never block the tick on I/O.
- Event buses: `ServerChatEvent`, `LivingDeathEvent`, `AchievementEvent` → `MinecraftForge.EVENT_BUS`;
  `PlayerLoggedIn/Out`, `TickEvent` → `FMLCommonHandler.instance().bus()`. `GameEvents` is registered on both.
- `HubClient.stop(0)` must return immediately (crash path); `stop(2000)` flushes `stopping` on clean shutdown.
- A clean stop is announced from two places: `FMLServerStoppingEvent` (`/stop`) and a JVM shutdown hook
  (SIGTERM — vanilla's hook bypasses the FML event). Both go through `announceStop`.
- `/cmd` output is collected in a `CommandOutput` until replies go quiet (1.5 s) or 8 s pass, because some mods
  (spark) reply from a worker thread after the command returns. `serverStopping` calls `flushPending()` first.
- The outbox holds `JsonObject`s; when a connection ends, `dropNonLifecycle` keeps only `started`/`stopping`.
- After the first result, a `/cmd` keeps collecting for 5 min and sends `cmdLate` batches (spark profiler links).
- **Event-listener classes must be `public`**: FML's event bus generates the caller in another package, so a
  package-private listener throws `IllegalAccessError` when the event first fires.
- BetterQuesting is `compileOnly` (never bundled). Only `QuestEvents` touches its classes, and it's created only when
  `Loader.isModLoaded("betterquesting")`; keep it that way so servers without BetterQuesting still load.
  Quest names resolve server-side via `QuestNames` (BetterQuesting's own translation is client-only).
- `BackupLogWatcher` is a log4j appender on the `Server Utilities` logger (attached in `preInit`); it only enqueues.
- `/discord link|unlink` is `DiscordCommand`; the hub answers with `linkResult`.

## Tests

`HubClientTest` plays the hub over a real `ServerSocket`. `GameEvents`/`GtnhDiscord` can only be verified by
the manual smoke test on a real GTNH server (see the plan's final task).
````

In `docs/ROADMAP.md`:
- change `## v1.2b — in progress (ships together with v1.2a; additive messages, protocol stays v1)` to `## v1.2b — done (shipped with v1.2a; additive messages, protocol stays v1)`;
- move the "Long-running command output" row's status to done, by leaving the table as it is under that done heading.

- [ ] **Step 2: Run the suite on Node 24 too**

```bash
cd hub && npm test && npm run typecheck
V=v24.21.0; T=$(mktemp -d)
curl -fsSL https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz | tar -xJ -C "$T"
"$T/node-$V-linux-x64/bin/node" --test "test/*.test.ts"; rm -rf "$T"
```
Expected: `ℹ pass 107`, `ℹ fail 0` on both.

- [ ] **Step 3: Commit and push**

```bash
git add README.md hub/CLAUDE.md mod/CLAUDE.md docs/ROADMAP.md
git commit -m "docs: v1.2b commands, config and module notes"
git push
```

- [ ] **Step 4: Manual smoke test on the real server (with the user)**

This covers both v1.2a and v1.2b. Deploy as described in the v1.2a plan (Task 6 Step 4), with the new jar and the new config fields. Run the v1.2a checks first, then these:

1. `/tps` shows the current TPS and the slowest dimensions. Within a few minutes, the 1 h stats and trend line fill in.
2. Complete a quest in game. A main quest posts straight away as "📜 … completed **…**" with a readable name. Other quests post as a roll-up within 10 minutes.
3. `/link`, then `/discord link <code>` in game → a green "[Discord] Linked to …". The channel shows "🔗 … linked to @you" (no ping), and your Discord chat appears in game under your Minecraft name. `/playtime user:@you` works. `/unlink` works.
4. The next scheduled backup posts "✅ Backup finished (…)".
5. `/cmd spark profiler --timeout 30` → the first reply, then a follow-up with the profiler link about 30–40 s later.
6. Check `journalctl -u gtnh --since -10min | grep -i gtnhdiscord` for errors (e.g. `NoSuchFieldError` from `QuestEvents`: see Review Focus 2).

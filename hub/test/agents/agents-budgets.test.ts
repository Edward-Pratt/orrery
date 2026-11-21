// The Agent port's budgets (`budgets.ts`): the line rate and its close, each type's budget (game events, pushes
// skipped when like the last, backups, heartbeats, new players), drop logs once a minute, and reconnecting never
// refilling a budget.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { everyMinute, type DropLogs } from '../../src/agents/agents.ts';
import { LiveFeed } from '../../src/stats/live.ts';
import { PlaytimeTracker } from '../../src/servers/playtime.ts';
import { LIMITS } from '../../src/protocol.ts';
import { agentUp, gameUp, hubSides, readAll, setup, waitFor } from './agent-port.ts';

test('a chat flood is cut to the line rate, its chat to the game events budget, then closes its connection; the hub stays up', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { hub, port, events } = await setup(t, { agents: { rate: { perSecond: 50, burst: 200, overMs: 300 } } });
  const agent = await agentUp(port);
  const game = await gameUp(port);
  const started = Date.now();
  const flood = setInterval(() => {
    for (let i = 0; i < 50; i++) game.send({ type: 'chat', player: 'Ann', message: 'spam' });
  }, 5);
  await game.closed;
  clearInterval(flood);
  const seconds = (Date.now() - started) / 1000;
  const chats = events.filter((e) => e.type === 'chat').length;
  assert.ok(chats >= 30 && chats <= 30 + 2 * seconds + 1, `${chats} chat lines in ${seconds} s`); // the game events' burst, then 2/s
  const said = errors.mock.calls.map((c) => String(c.arguments[0]));
  assert.equal(said.filter((s) => /over 50 lines\/s, dropping lines/.test(s)).length, 1); // logged once
  assert.equal(said.filter((s) => /over the line rate for 0.3 s, closing/.test(s)).length, 1);

  agent.send({ type: 'ping' }); // the Agent connection has its own budget
  await gameUp(port);
  assert.equal(hub.get('space')?.online, true);
});

test('a chat flood at 15 lines/s for 20 s: chat over its budget is dropped, the connection stays open, the feed gains at most the budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const errors = t.mock.method(console, 'error', () => {});
  const { hub, db, port, events } = await setup(t);
  new LiveFeed(hub, db);
  const sides = hubSides(t, port);
  await agentUp(port);
  const game = await gameUp(port);
  for (let second = 0; second < 20; second++) {
    for (let i = 0; i < 15; i++) game.send({ type: 'chat', player: 'Ann', message: `spam ${second}.${i}` });
    await readAll(sides.at(-1)!, game.socket);
    t.mock.timers.tick(1000);
  }
  const chats = events.filter((e) => e.type === 'chat').length;
  assert.equal(chats, 30 + 2 * 19); // its burst, then 2 a second: under the line rate, nothing else is dropped
  assert.equal(db.feed.newest('space', 1000).length, chats);
  assert.equal(game.socket.destroyed, false);
  assert.equal(hub.get('space')?.online, true);
  const said = errors.mock.calls.map((c) => String(c.arguments[0]));
  assert.deepEqual(said, ['[agents] game space: over the game events budget, dropped 1']); // once a minute at most
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 40; i++) game.send({ type: 'join', player: `p${i}` }); // join shares the budget: 30 fit
  await readAll(sides.at(-1)!, game.socket);
  // 300 chat lines, 68 passed on: 232 dropped, the first logged at once, so the next log counts 231 and its own.
  assert.equal(errors.mock.calls.at(-1)!.arguments[0], '[agents] game space: over the game events budget, dropped 232');
  assert.equal(events.filter((e) => e.type === 'join').length, 30);
});

test('drop logs: the first at once, the rest summed when the minute is up, by a timer once drops stop; none after close', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const errors = t.mock.method(console, 'error', () => {});
  const said = () => errors.mock.calls.map((c) => String(c.arguments[0]));
  const logs: DropLogs = { timers: new Set(), closed: false };
  const drop = everyMinute((n) => `dropped ${n}`, logs);
  drop(); // logged at once
  t.mock.timers.tick(10_000);
  drop();
  drop();
  t.mock.timers.tick(49_999);
  assert.deepEqual(said(), ['dropped 1']);
  t.mock.timers.tick(1); // the minute is up: the two since, though no drop came
  assert.deepEqual(said(), ['dropped 1', 'dropped 2']);
  assert.equal(logs.timers.size, 0);
  t.mock.timers.tick(30_000);
  drop(); // within a minute of the last line: waits
  t.mock.timers.tick(29_999);
  drop();
  assert.deepEqual(said(), ['dropped 1', 'dropped 2']);
  t.mock.timers.tick(1); // a minute after the last line: both
  assert.deepEqual(said(), ['dropped 1', 'dropped 2', 'dropped 2']);
  t.mock.timers.tick(1_000);
  drop();
  assert.equal(logs.timers.size, 1);
  // What Agents.close does: the pending line is never logged, and no timer is set after.
  logs.closed = true;
  for (const timer of logs.timers) clearTimeout(timer);
  logs.timers.clear();
  drop();
  t.mock.timers.tick(120_000);
  assert.deepEqual(said(), ['dropped 1', 'dropped 2', 'dropped 2']);
  assert.equal(logs.timers.size, 0);
});

test('a flood over 20 lines/s for 10 s closes its connection', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const errors = t.mock.method(console, 'error', () => {});
  const { agents, port } = await setup(t);
  const sides = hubSides(t, port);
  const agent = await agentUp(port); // its agentHello took from its address's budget, not the Agent connection's
  for (let i = 0; i < 101; i++) agent.send({ type: 'ping' }); // the last one is dropped: over since now
  await readAll(sides[0]!, agent.socket);
  for (let step = 1; step <= 100; step++) {
    t.mock.timers.tick(100);
    for (let i = 0; i < 3; i++) agent.send({ type: 'ping' }); // 30 a second: 2 fit each 100 ms, 1 is dropped
    await readAll(sides[0]!, agent.socket);
    assert.equal(sides[0]!.destroyed, step === 100, `after ${step * 100} ms`);
  }
  await agent.closed;
  assert.equal(agents.get('vm')?.connected, false);
  const said = errors.mock.calls.map((c) => String(c.arguments[0]));
  assert.deepEqual(said, ['[agents] agent vm: over 20 lines/s, dropping lines (1 dropped)', '[agents] agent vm: over the line rate for 10 s, closing']);
});

test('a push identical to the last one passed on is skipped; changed ones come at most 1/s in bursts of 10', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'error', () => {});
  const { agents, port } = await setup(t);
  const sides = hubSides(t, port);
  const agent = await agentUp(port);
  const pushed: string[] = [];
  agents.on('serviceState', (_, m) => pushed.push(`${m.active} ${m.since}`));
  agents.on('saves', (_, m) => pushed.push(`saves ${m.free}`));
  const state = (active: string, since: number) => ({ type: 'serviceState', unit: 'factorio.service', active, sub: 'running', since, result: 'success' });
  const saves = (free: number) => ({ type: 'saves', saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'auto', current: false }], free });
  for (const msg of [state('active', 1), state('active', 1), state('failed', 2), state('active', 1), saves(9), saves(9), saves(8), saves(9)]) agent.send(msg);
  await readAll(sides[0]!, agent.socket);
  assert.deepEqual(pushed, ['active 1', 'failed 2', 'active 1', 'saves 9', 'saves 8', 'saves 9']);

  pushed.length = 0;
  for (let i = 0; i < 15; i++) agent.send(state('active', 100 + i)); // 7 left of the 10: skipped ones took none
  await readAll(sides[0]!, agent.socket);
  assert.equal(pushed.length, 7);
  t.mock.timers.tick(1000);
  agent.send(state('active', 200));
  agent.send(state('active', 201));
  await readAll(sides[0]!, agent.socket);
  assert.deepEqual(pushed.slice(7), ['active 200']);
  assert.equal(agents.get('vm')?.connected, true);
});

test('reconnecting never refills a budget: each connection goes on with what the one it replaces left', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); // no refill at all: what passes is one burst
  t.mock.method(console, 'error', () => {});
  const { agents, port, events } = await setup(t);
  const sides = hubSides(t, port);
  const pushed: number[] = [];
  agents.on('serviceState', (_, m) => pushed.push(m.since));
  const state = (since: number) => ({ type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since, result: 'success' });
  for (let round = 0; round < 10; round++) {
    const agent = await agentUp(port); // each a fresh Agent connection, the last one closed first
    for (let i = 0; i < 20; i++) agent.send(state(round * 100 + i));
    await readAll(sides.at(-1)!, agent.socket);
    if (round < 9) {
      agent.socket.destroy();
      await waitFor(() => sides.at(-1)!.destroyed, 'the hub saw it close');
    }
  }
  assert.equal(pushed.length, 10); // serviceState's burst, once in all
  for (let round = 0; round < 10; round++) {
    const game = await gameUp(port); // replaces the last one, which stays open
    // A chat line in every 10, the rest a command's answer nobody waits for (no budget of its own, and no effect).
    for (let i = 0; i < 100; i++) game.send(i % 10 === 9 ? { type: 'chat', player: 'Ann', message: `round ${round}` } : { type: 'cmdResult', id: `none ${i}`, output: [] });
    await readAll(sides.at(-1)!, game.socket);
  }
  // The line burst once in all: the first round's 100 lines, so only its 10 chat lines got through.
  assert.deepEqual(events.flatMap((e) => (e.type === 'chat' ? [e.message] : [])), Array(10).fill('round 0'));
});

test("an Agent's backups pass at most one per 10 s, in bursts of 3, each a notice to post; the connection stays", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const errors = t.mock.method(console, 'error', () => {});
  const { port, events } = await setup(t);
  const sides = hubSides(t, port);
  await agentUp(port);
  const game = await gameUp(port);
  for (let step = 0; step < 6; step++) {
    for (let i = 0; i < 100; i++) game.send({ type: 'backup', ok: true, detail: `${step}.${i}` }); // under the line rate
    await readAll(sides.at(-1)!, game.socket);
    t.mock.timers.tick(10_000);
  }
  assert.deepEqual(
    events.flatMap((e) => (e.type === 'backup' ? [e.detail] : [])),
    ['0.0', '0.1', '0.2', '1.0', '2.0', '3.0', '4.0', '5.0'],
  );
  assert.equal(game.socket.destroyed, false);
  assert.deepEqual(errors.mock.calls.map((c) => c.arguments[0]), ['[agents] game space: over the backup budget, dropped 1']);
});

test("an Agent's heartbeats pass at most 1 a second, in bursts of 5, so toggling paused can't flood the stream", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'error', () => {});
  const { port, events } = await setup(t);
  const sides = hubSides(t, port);
  await agentUp(port);
  const game = await gameUp(port);
  const paused = () => events.filter((e) => e.type === 'paused').length;
  for (let i = 0; i < 100; i++) game.send({ type: 'heartbeat', tps: 60, players: [], paused: i % 2 === 0 }); // the line burst
  await readAll(sides.at(-1)!, game.socket);
  assert.equal(paused(), 5);
  t.mock.timers.tick(1000);
  for (let i = 0; i < 10; i++) game.send({ type: 'heartbeat', tps: 60, players: [], paused: false });
  await readAll(sides.at(-1)!, game.socket);
  assert.equal(paused(), 6);
  assert.equal(game.socket.destroyed, false);
});

test("a heartbeat's names new to its server join it at most 1 per 10 s past a full list: churning names, or reconnecting, can't make sessions faster", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const errors = t.mock.method(console, 'error', () => {});
  const { hub, db, port, types } = await setup(t);
  const playtime = new PlaytimeTracker(hub, db);
  const sides = hubSides(t, port);
  await agentUp(port);
  let game = await gameUp(port);
  const fresh = (round: number) => Array.from({ length: LIMITS.players }, (_, i) => `p${round}-${i}`);
  /** A heartbeat with `players`, then the tracker's poll, then 10 s on (`wait`). */
  const beat = async (players: string[], wait = true) => {
    game.send({ type: 'heartbeat', tps: 60, players });
    await readAll(sides.at(-1)!, game.socket);
    playtime.poll(Date.now());
    if (wait) t.mock.timers.tick(10_000);
  };
  const sessions = () => db.sessionsSince('space', 0).length;
  await beat(fresh(0), false); // a full list at once, as after a connect
  await beat(fresh(0)); // the same names again: none of them is new
  assert.equal(hub.get('space')?.players.length, LIMITS.players);
  assert.equal(sessions(), LIMITS.players);
  for (let round = 1; round <= 10; round++) await beat(fresh(round)); // every poll a fresh 200
  assert.deepEqual(hub.get('space')?.players, ['p10-0']); // one new name per 10 s, the rest left out
  assert.equal(sessions(), LIMITS.players + 10);
  assert.match(String(errors.mock.calls[0]!.arguments[0]), /^\[agents\] game space: over the new players budget, dropped 1$/);

  game.socket.destroy(); // a reconnect empties its list: the names it brings back are new again
  await waitFor(() => types().includes('crashed'), 'the hub saw it close');
  playtime.poll(Date.now());
  game = await gameUp(port);
  await beat(fresh(0));
  assert.deepEqual(hub.get('space')?.players, ['p0-0']);
  assert.equal(sessions(), LIMITS.players + 11);
});

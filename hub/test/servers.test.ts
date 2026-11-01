import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { Db } from '../src/db.ts';
import { mcText, ServerHub, truncate, type AuditEntry, type HubEvent, type HubOptions } from '../src/servers.ts';
import { fakeMod, hello, online, sleep, TOKEN, until } from './fake-mod.ts';

async function setup(t: TestContext, opts: HubOptions = {}) {
  const hub = new ServerHub([{ id: 'gtnh', name: 'GTNH', game: 'minecraft', token: TOKEN }], opts);
  const port = await hub.listen(0);
  hub.start();
  const events: HubEvent[] = [];
  hub.on('event', (e) => events.push(e));
  t.after(() => hub.close());
  return { hub, port, events, types: () => events.map((e) => e.type) };
}

test('rejects tokens shorter than 16 characters', () => {
  assert.throws(() => new ServerHub([{ id: 'x', name: 'X', game: 'minecraft', token: 'short' }]), /at least 16/);
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

test('rejects a server that has no token', async (t) => {
  const hub = new ServerHub([{ id: 'gtnh', name: 'GTNH', game: 'minecraft' }]);
  const port = await hub.listen(0);
  t.after(() => hub.close());
  const mod = fakeMod(port);
  mod.send(hello(''));
  assert.deepEqual(await mod.next(), { type: 'reject', reason: 'unknown serverId or bad token' });
  await mod.closed;
});

test('accepts only protocol versions in the supported range', async (t) => {
  const { port } = await setup(t);
  for (const protocol of [0, 2, 1.5]) {
    const mod = fakeMod(port);
    mod.send(hello(TOKEN, protocol));
    const reply = (await mod.next()) as { type: string; reason: string };
    assert.equal(reply.type, 'reject');
    assert.equal(reply.reason, `protocol ${protocol} not supported (hub speaks 1)`);
    await mod.closed;
  }
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
  const { hub, port, types } = await setup(t);
  const mod = await online(port);
  mod.send({ type: 'heartbeat', tps: 19.5, players: ['Steve', 'Alex'] });
  await until(() => hub.get('gtnh')?.tps === 19.5);
  assert.deepEqual(hub.get('gtnh')?.players, ['Steve', 'Alex']);
  assert.deepEqual(types(), ['connected', 'tps']); // a Mod's heartbeat has no `paused`, so no paused event
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

test('commands sent, and only those, go to the audit log', async (t) => {
  const audit: AuditEntry[] = [];
  const { hub, port } = await setup(t, { audit: (e) => audit.push(e) });
  await assert.rejects(hub.runCommand('gtnh', 'list', 'test'), /offline/);
  const mod = await online(port);
  await assert.rejects(hub.runCommand('gtnh', ' / ', 'test'), /empty command/);
  void hub.runCommand('gtnh', '/backup start', 'discord:alice (123)').catch(() => {});
  await mod.next();
  assert.deepEqual(audit, [{ actor: 'discord:alice (123)', action: 'command', target: 'gtnh', details: 'backup start' }]);
});

test("a Mod's command has no length cap of the Agent's (256 characters)", async (t) => {
  const { hub, port } = await setup(t);
  const mod = await online(port);
  const long = 'x'.repeat(1000);
  void hub.runCommand('gtnh', long, 'test').catch(() => {});
  assert.equal(((await mod.next()) as { command: string }).command, long);
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

test('started is one event per connection, a repeat on it dropped; the next connection may start again', async (t) => {
  const { port, types } = await setup(t);
  const a = await online(port);
  a.send({ type: 'started' });
  a.send({ type: 'started' });
  a.send({ type: 'stopping' });
  a.socket.end();
  await until(() => types().includes('stopped'));
  const b = await online(port);
  b.send({ type: 'started' });
  await until(() => types().length === 5);
  assert.deepEqual(types(), ['connected', 'started', 'stopped', 'connected', 'started']);
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
  assert.deepEqual(types(), ['connected', 'tps', 'hung', 'recovered']); // the same TPS again isn't news
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
  assert.equal(hub.say('gtnh', 'Bob', 'hi', 'discord'), false); // offline
  const mod = await online(port);
  assert.equal(hub.say('gtnh', 'Bob', '§c§l', 'discord'), false);
  assert.equal(hub.say('gtnh', 'B§4ob\n', 'line1\nline2 §kx' + 'y'.repeat(300), 'discord'), true);
  const say = (await mod.next()) as { type: string; author: string; message: string; source: string };
  assert.equal(say.type, 'say');
  assert.equal(say.author, 'Bob');
  assert.equal(say.source, 'discord');
  assert.equal(say.message.length, 256);
  assert.ok(say.message.startsWith('line1 line2 xyyy'));
});

test('say sends its source to the mod and keeps the avatar on the event', async (t) => {
  const { hub, port, events } = await setup(t);
  const mod = await online(port);
  assert.equal(hub.say('gtnh', 'alex', 'hi', 'dashboard', 'https://cdn.example/a.png'), true);
  assert.deepEqual(await mod.next(), { type: 'say', author: 'alex', message: 'hi', source: 'dashboard' });
  assert.deepEqual(events.at(-1), {
    serverId: 'gtnh',
    type: 'say',
    author: 'alex',
    message: 'hi',
    source: 'dashboard',
    avatar: 'https://cdn.example/a.png',
  });
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
      { id: 'gtnh', name: 'GTNH', game: 'minecraft', token: TOKEN },
      { id: 'idle', name: 'Idle', game: 'minecraft', token: TOKEN },
    ],
    { graceMs: 150 },
  );
  const events: HubEvent[] = [];
  hub.on('event', (e) => events.push(e));
  t.after(() => hub.close());
  const port = await hub.listen(0);
  hub.start();
  await online(port);
  await sleep(300);
  assert.deepEqual(events, [
    { serverId: 'gtnh', type: 'connected' },
    { serverId: 'idle', type: 'offline' },
  ]);
});

test('with the Minecraft integration off (no Mod port), a minecraft server stays unknown after the grace period', async (t) => {
  const hub = new ServerHub([{ id: 'gtnh', name: 'GTNH', game: 'minecraft', token: TOKEN }], { graceMs: 100 });
  const events: HubEvent[] = [];
  hub.on('event', (e) => events.push(e));
  t.after(() => hub.close());
  hub.start(); // as startHub does, with no listen()
  await sleep(250);
  assert.deepEqual(events, []);
});

test("a factorio server is offline after the grace period only while its Agent is connected, else unknown", async (t) => {
  const hub = new ServerHub(
    [
      { id: 'space', name: 'Space Age', game: 'factorio' },
      { id: 'moon', name: 'Moon', game: 'factorio' },
    ],
    { graceMs: 150 },
  );
  const events: HubEvent[] = [];
  hub.on('event', (e) => events.push(e));
  t.after(() => hub.close());
  hub.start(); // no Mod port needed
  hub.agentUp('space'); // its Agent is up, its game is not
  await sleep(300);
  assert.deepEqual(events, [{ serverId: 'space', type: 'offline' }]);
});

test('truncate never leaves half an emoji', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 3), 'abc');
  assert.equal(truncate('ab😀', 3), 'ab'); // cutting at 3 would split the surrogate pair
  assert.equal(truncate('ab😀', 4), 'ab😀');
  assert.equal(mcText('a'.repeat(255) + '😀', 256), 'a'.repeat(255));
});

test('close() does not wait for connections that never sent hello', async () => {
  const hub = new ServerHub([{ id: 'gtnh', name: 'GTNH', game: 'minecraft', token: TOKEN }]);
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
  await until(() => events.length === 5);
  assert.deepEqual(hub.get('gtnh')?.dims, [{ id: -1, name: 'Nether', ms: 60 }]);
  assert.deepEqual(
    events.slice(1).map((e) => e.type),
    ['tps', 'quest', 'link', 'backup'],
  );
});

test('sendLinkResult reaches the mod', async (t) => {
  const { hub, port } = await setup(t);
  assert.equal(hub.sendLinkResult('gtnh', 'Steve', true, 'Linked'), false); // offline
  const mod = await online(port);
  assert.equal(hub.sendLinkResult('gtnh', 'Steve', true, 'Linked'), true);
  assert.deepEqual(await mod.next(), { type: 'linkResult', player: 'Steve', ok: true, message: 'Linked' });
});

test('late command output reaches onLate until it expires, every batch of it', async (t) => {
  const { hub, port, events } = await setup(t, { lateMs: 150 });
  const mod = await online(port);
  const late: string[][] = [];
  const result = hub.runCommand('gtnh', 'spark profiler', 'test', (lines) => late.push(lines));
  const cmd = (await mod.next()) as { id: string };
  mod.send({ type: 'cmdResult', id: cmd.id, output: ['Profiler started'] });
  assert.deepEqual(await result, ['Profiler started']);
  mod.send({ type: 'cmdLate', id: cmd.id, output: ['https://spark.lucko.me/abc'] });
  mod.send({ type: 'cmdLate', id: 'unknown', output: ['ignored'] });
  mod.send({ type: 'cmdLate', id: cmd.id, output: ['a second batch'] }); // a Mod sends up to 10 for one command
  await until(() => late.length === 2);
  await sleep(250);
  mod.send({ type: 'cmdLate', id: cmd.id, output: ['too late'] });
  await sleep(50);
  assert.deepEqual(late, [['https://spark.lucko.me/abc'], ['a second batch']]);
  assert.equal(events.filter((e) => e.type === 'console' && e.late).length, 2);
});

test('publish puts a hub-core notice on the event stream for that server', async (t) => {
  const { hub, events } = await setup(t);
  hub.publish('gtnh', { severity: 'info', kind: 'restartNow' });
  assert.deepEqual(events, [{ severity: 'info', kind: 'restartNow', type: 'notice', serverId: 'gtnh' }]);
});

test('announce puts a quest batch or a new link on the event stream for that server', async (t) => {
  const { hub, events } = await setup(t);
  hub.announce('gtnh', { type: 'linked', player: 'Steve', discordId: '123' });
  assert.deepEqual(events, [{ type: 'linked', player: 'Steve', discordId: '123', serverId: 'gtnh' }]);
});

test('a mod cannot send hub-core notices, quest batches, links or summaries', async (t) => {
  const { port, types } = await setup(t);
  const mod = await online(port);
  mod.send({ type: 'notice', severity: 'problem', kind: 'restartFailed', error: 'spoofed' });
  mod.send({ type: 'questBatch', player: 'Steve', quests: [{ name: 'x', main: true }], count: 1 });
  mod.send({ type: 'linked', player: 'Steve', discordId: '123' });
  mod.send({ type: 'summary', name: 'GTNH', summary: {} });
  mod.send({ type: 'started' });
  await until(() => types().includes('started'));
  assert.deepEqual(types(), ['connected', 'started']);
});

/**
 * A factorio server's hub, with its lifecycle rows in a database as `startHub` records them, the clock and timers
 * mocked; its game connections are attached sockets standing in for the ones `Agents` hands over.
 */
function factorio(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const errors = t.mock.method(console, 'error', () => {});
  const hub = new ServerHub([{ id: 'space', name: 'Space Age', game: 'factorio' }]);
  const db = new Db(':memory:');
  const events: HubEvent[] = [];
  hub.on('event', (e) => {
    events.push(e);
    db.recordLifecycle(e.serverId, e.type);
  });
  const from = Date.now();
  t.after(() => hub.close());
  const attach = () => {
    const socket = new PassThrough();
    return { socket, send: hub.attach(socket as unknown as Socket, 'space', '1.0.0') };
  };
  const closed = () => new Promise((r) => setImmediate(r)); // a destroyed stream's 'close' comes on a later tick
  return { hub, db, events, errors, from, attach, closed, rows: () => db.states('space', from - 1) };
}

test("a factorio server's churned lifecycle stores at most its budget, and its latest state once the budget allows", async (t) => {
  const { hub, events, errors, attach, rows } = factorio(t);
  for (let i = 0; i < 200; i++) {
    hub.agentUp('space');
    attach(); // connected
    hub.agentDown('space'); // lost
    t.mock.timers.tick(18_000); // 200 cycles in an hour
  }
  // 20 at once, 20 more refilled over the hour, and the latest dropped one put through on the way
  assert.ok(events.length <= 41, `${events.length} events`);
  assert.ok(rows().length <= 41, `${rows().length} rows`);
  assert.ok(errors.mock.callCount() >= 1 && errors.mock.callCount() <= 60, `${errors.mock.callCount()} log lines`); // at most once a minute
  assert.match(String(errors.mock.calls[1].arguments[0]), /^\[hub\] space: over 20 lifecycle events an hour, dropped \d+$/);
  t.mock.timers.tick(180_000); // the next token: the latest event goes out if it hasn't
  assert.equal(events.at(-1)?.type, 'lost');
  assert.equal(rows().at(-1)?.state, 'unknown');
  assert.equal(hub.get('space')?.online, false);

  // ending on a connection: the card's online, and so is the recorded state once the budget allows
  for (let i = 0; i < 30; i++) {
    hub.agentUp('space');
    attach();
    if (i < 29) hub.agentDown('space');
  }
  assert.equal(hub.get('space')?.online, true);
  const before = events.length; // its budget is spent: the latest connection is not out yet
  t.mock.timers.tick(180_000);
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1)?.type, 'connected');
  assert.equal(rows().at(-1)?.state, 'up');
  t.mock.timers.tick(3_600_000); // nothing left to put through
  assert.equal(events.at(-1)?.type, 'connected');
});

test("a factorio server's normal use, a few starts and stops a day, is all recorded", async (t) => {
  const { hub, events, errors, attach, closed, rows } = factorio(t);
  hub.agentUp('space');
  const expected: string[] = [];
  for (let day = 0; day < 3; day++) {
    for (let run = 0; run < 4; run++) {
      const game = attach();
      game.send({ type: 'started' });
      t.mock.timers.tick(2 * 3_600_000);
      game.send({ type: 'stopping' });
      game.socket.destroy();
      await closed();
      t.mock.timers.tick(4 * 3_600_000);
      expected.push('connected', 'started', 'stopped');
    }
  }
  assert.deepEqual(
    events.map((e) => e.type),
    expected,
  );
  assert.deepEqual(
    rows().map((r) => r.reason),
    expected,
  );
  assert.equal(errors.mock.callCount(), 0);
});

test("a factorio server's bad minute, 20 lifecycle events at once, is all recorded; the 21st waits for the budget", async (t) => {
  const { hub, events, errors, attach, closed, rows } = factorio(t);
  const expected: string[] = [];
  hub.agentUp('space');
  let game = attach();
  game.send({ type: 'started' });
  expected.push('connected', 'started');
  // a restart: the game stops, and comes back
  game.send({ type: 'stopping' });
  game.socket.destroy();
  await closed();
  game = attach();
  game.send({ type: 'started' });
  expected.push('stopped', 'connected', 'started');
  // its Agent restarts, then the game crashes twice, then its Agent is lost, then the game crashes again
  const agentBack = () => {
    hub.agentDown('space');
    hub.agentUp('space');
    game = attach();
    game.send({ type: 'started' });
    expected.push('lost', 'connected', 'started');
  };
  const crash = async () => {
    game.socket.destroy();
    await closed();
    t.mock.timers.tick(5_000); // settleMs: its Agent connection stayed up
    game = attach();
    game.send({ type: 'started' });
    expected.push('crashed', 'connected', 'started');
  };
  agentBack();
  await crash();
  await crash();
  agentBack();
  await crash();
  // 20 events in 15 s: the burst takes them all, nothing dropped or logged
  assert.equal(expected.length, 20);
  assert.deepEqual(
    events.map((e) => e.type),
    expected,
  );
  assert.deepEqual(
    rows().map((r) => r.reason),
    expected,
  );
  assert.equal(errors.mock.callCount(), 0);

  // the 21st finds under a token (one comes every 3 min), so it waits, and goes out when the token comes
  hub.agentDown('space');
  assert.equal(events.length, 20);
  assert.equal(errors.mock.callCount(), 1);
  t.mock.timers.tick(180_000);
  assert.equal(events.length, 21);
  assert.equal(events.at(-1)?.type, 'lost');
  assert.equal(rows().at(-1)?.reason, 'lost');
  assert.equal(errors.mock.callCount(), 1); // putting it through is no second drop
});

test("a Minecraft server's lifecycle has no budget: every connect and crash is recorded", async (t) => {
  const { hub, port, events } = await setup(t);
  const db = new Db(':memory:');
  const from = Date.now();
  hub.on('event', (e) => db.recordLifecycle(e.serverId, e.type));
  const errors = t.mock.method(console, 'error', () => {});
  const expected: string[] = [];
  for (let i = 0; i < 30; i++) {
    const mod = await online(port);
    mod.socket.destroy();
    expected.push('connected', 'crashed');
    await until(() => events.length === expected.length);
  }
  assert.deepEqual(
    events.map((e) => e.type),
    expected,
  );
  assert.deepEqual(
    db.states('gtnh', from - 1).map((r) => r.reason),
    expected,
  );
  assert.equal(errors.mock.callCount(), 0);
});

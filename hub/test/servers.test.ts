import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mcText, ServerHub, truncate, type AuditEntry, type HubEvent, type HubOptions } from '../src/servers.ts';
import { fakeMod, hello, online, sleep, TOKEN, until } from './fake-mod.ts';

async function setup(t: TestContext, opts: HubOptions = {}) {
  const hub = new ServerHub([{ id: 'gtnh', name: 'GTNH', token: TOKEN }], opts);
  const port = await hub.listen(0);
  const events: HubEvent[] = [];
  hub.on('event', (e) => events.push(e));
  t.after(() => hub.close());
  return { hub, port, events, types: () => events.map((e) => e.type) };
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

test('rejects a server that has no token', async (t) => {
  const hub = new ServerHub([{ id: 'gtnh', name: 'GTNH' }]);
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

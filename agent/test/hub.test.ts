import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { HubClient, backoff, type HubOptions } from '../src/hub.ts';
import { StatusPoller, type Reading } from '../src/status.ts';
import { LIMITS } from '../src/wire.ts';
import { eventually, fakeHub, type Answer, type HubConn } from './fake-hub.ts';
import { PASSWORD, fakeRcon } from './fake-rcon.ts';

const TOKEN = 'agent-token-'.padEnd(40, 'x');
const VERSION = 'agent-v1.2.3';
const READING: Reading = { ups: null, players: [], paused: true, modVersion: '0.1.0' };

async function setup(t: TestContext, answer?: (hello: Record<string, unknown>, conn: HubConn) => Answer, options: Partial<HubOptions> = {}) {
  const hub = await fakeHub(answer);
  const root = await mkdtemp(join(tmpdir(), 'orrery-agent-'));
  const server = { id: 'factorio', unit: 'factorio.service', install: '/opt/factorio', data: '/srv/factorio', rconPort: 1, factorioUdpPort: 34198, agentUdpPort: 34199 };
  const client = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server, token: TOKEN, root },
    version: VERSION,
    backoffMs: 20,
    maxBackoffMs: 100,
    random: () => 1,
    ...options,
  });
  t.after(async () => {
    await client.stop();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  return { hub, client, root };
}

/** The connection's lines after the hello, by type. */
const sent = (conn: HubConn, type: string) => conn.lines.slice(1).filter((m) => m.type === type);

test('backoff doubles from the base up to the cap, jittered into its upper half', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 60].map((n) => backoff(n, 100, 1000, () => 1)), [100, 200, 400, 800, 1000, 1000, 1000]);
  assert.equal(backoff(2, 100, 1000, () => 0), 200);
  assert.equal(backoff(2, 100, 1000, () => 0.5), 300);
});

test('agentHello first, nothing else before welcome; then serviceState, pings and the connected file', async (t) => {
  let welcome = false;
  const { hub, client, root } = await setup(t, () => (welcome ? 'welcome' : 'silent'), { pingMs: 20, handshakeMs: 150 });
  client.service({ unit: 'factorio.service', active: 'active', sub: 'running', since: 1_700_000_000_000, result: 'success' });
  client.start();
  const [first] = await eventually(() => hub.of('agentHello').length === 1 && hub.of('agentHello'));
  assert.deepEqual(first!.lines[0], { type: 'agentHello', protocol: 1, agentId: 'factorio-vm', token: TOKEN, agentVersion: VERSION });
  client.sample({ ts: 1, cpu: 0.5, load: [1, 2, 3], memory: { used: 1, total: 2 }, disks: [] });
  client.status({ ...READING, ups: 60 });
  await sleep(60);
  assert.equal(first!.lines.length, 1, 'only the hello before a welcome');
  assert.equal(client.connected, false);
  assert.equal(hub.of('hello').length, 0, 'no game connection before a welcome');

  welcome = true; // the silent connection times out, the next is welcomed
  const second = await eventually(() => hub.of('agentHello')[1]);
  assert.ok(first!.closed);
  await eventually(() => sent(second, 'ping').length >= 2, 2000, 'pings');
  assert.deepEqual(sent(second, 'serviceState'), [
    { type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since: 1_700_000_000_000, result: 'success' },
  ]);
  await eventually(() => existsSync(join(root, 'connected')), 2000, 'the connected file');
  const connected = JSON.parse(await readFile(join(root, 'connected'), 'utf8'));
  assert.deepEqual(Object.keys(connected), ['version', 'time']);
  assert.equal(connected.version, VERSION);
  assert.ok(Math.abs(connected.time - Date.now()) < 5000);

  client.sample({ ts: 2, cpu: 0.25, load: [0.1, 0.2, 0.3], memory: { used: 3, total: 4 }, disks: [{ mount: '/', free: 5, total: 6 }] });
  client.service({ unit: 'factorio.service', active: 'inactive', sub: 'dead', since: 1_700_000_100_000, result: 'success' });
  await eventually(() => sent(second, 'hostSample').length === 1 && sent(second, 'serviceState').length === 2);
  assert.deepEqual(sent(second, 'hostSample')[0], {
    type: 'hostSample',
    sample: { ts: 2, cpu: 0.25, load: [0.1, 0.2, 0.3], memory: { used: 3, total: 4 }, disks: [{ mount: '/', free: 5, total: 6 }] },
  });
  assert.deepEqual([...first!.invalid, ...second.invalid], [], 'every line valid for the hub');
});

test('reconnects with capped exponential backoff while the hub resets every connection', async (t) => {
  let n = 0;
  const { hub, client } = await setup(t, () => (++n <= 4 ? 'destroy' : 'welcome'), { backoffMs: 40, maxBackoffMs: 160 });
  client.start();
  await eventually(() => hub.conns[4], 3000, 'a 5th connection');
  await eventually(() => client.connected);
  const at = hub.conns.map((c) => c.at);
  const gaps = at.slice(1).map((a, i) => a - at[i]!);
  for (const [i, want] of [40, 80, 160, 160].entries()) {
    assert.ok(gaps[i]! >= want - 5 && gaps[i]! < want + 60, `wait ${i} was ${gaps[i]} ms, want about ${want}`);
  }
  assert.equal(hub.of('agentHello').length, 5, 'every attempt opens with agentHello');
});

test('after a welcomed connection drops, the first retry waits only the base', async (t) => {
  const { hub, client } = await setup(t, () => 'welcome', { backoffMs: 40, maxBackoffMs: 1000 });
  client.start();
  const first = await eventually(() => hub.conns[0]);
  await eventually(() => client.connected);
  const dropped = performance.now();
  first.socket.destroy();
  const second = await eventually(() => hub.conns[1], 2000);
  assert.ok(second.at - dropped >= 35 && second.at - dropped < 120, `retried after ${second.at - dropped} ms`);
});

test('the game connection: a hello with the agent token and the mod version, then heartbeats; stop sends bye and closes both', async (t) => {
  const { hub, client } = await setup(t);
  client.start();
  await eventually(() => client.connected);
  client.status(READING);
  const game = await eventually(() => hub.of('hello')[0]);
  assert.deepEqual(game.lines[0], { type: 'hello', protocol: 1, serverId: 'factorio', token: TOKEN, modVersion: '0.1.0' });
  await sleep(30);
  client.status({ ups: 59.8, players: ['alice', 'bob'], paused: false, modVersion: '0.1.0' });
  client.status({ ups: 0.2, players: [], paused: true, modVersion: '0.1.0' });
  await eventually(() => game.lines.length === 3);
  assert.deepEqual(game.lines.slice(1), [
    { type: 'heartbeat', tps: 59.8, players: ['alice', 'bob'], paused: false },
    { type: 'heartbeat', tps: 0.2, players: [], paused: true },
  ]);

  const agent = hub.of('agentHello')[0]!;
  await client.stop();
  await eventually(() => agent.closed && game.closed, 2000, 'both connections closed');
  assert.deepEqual(agent.lines.at(-1), { type: 'bye' });
  assert.equal(hub.conns.length, 2, 'no reconnect after stop');
  assert.deepEqual([...agent.invalid, ...game.invalid], []);
});

test('the game connection is open only while the Agent connection is up and RCON answers', async (t) => {
  let tick = 0;
  let answering = true;
  const rcon = await fakeRcon((cmd) => {
    if (cmd !== '/orrery-status') return [];
    if (!answering) return 'Unknown command "orrery-status".';
    tick += 3;
    return JSON.stringify({ ok: true, tick, tick_paused: false, players: ['alice'], version: '2.1.24', mods: { base: '2.1.24', orrery: '0.1.0' }, loaded: true });
  });
  t.after(() => rcon.close());
  let welcome = false;
  const { hub, client } = await setup(t, (hello) => (hello.type === 'hello' || welcome ? 'welcome' : 'silent'), { handshakeMs: 5000 });
  const poller = new StatusPoller({ port: rcon.port, password: PASSWORD, settings: '/nonexistent/server-settings.json', intervalMs: 20, timeoutMs: 500 });
  poller.on('status', (r) => client.status(r));
  poller.on('down', () => client.down());
  t.after(() => poller.stop());
  client.start();
  poller.start();

  const agent = await eventually(() => hub.of('agentHello')[0]);
  await eventually(() => tick >= 12, 2000, 'RCON answering');
  assert.equal(hub.of('hello').length, 0, 'RCON answers, but the Agent connection is not up');

  welcome = true;
  agent.send({ type: 'welcome' });
  const game = await eventually(() => hub.of('hello')[0]);
  assert.equal(game.lines[0]!.modVersion, '0.1.0');
  await eventually(() => game.lines.length >= 3, 2000, 'heartbeats');
  for (const hb of game.lines.slice(1)) {
    assert.equal(hb.type, 'heartbeat');
    assert.deepEqual(hb.players, ['alice']);
    assert.equal(hb.paused, false);
    assert.ok(typeof hb.tps === 'number' && hb.tps > 0);
  }

  answering = false; // RCON answers, but with no status: as good as down
  await eventually(() => game.closed, 2000, 'the game connection closed');
  await sleep(60);
  assert.equal(hub.of('hello').length, 1, 'not reopened while RCON gives no status');
  assert.equal(agent.closed, false, 'the Agent connection stays up');

  answering = true;
  const again = await eventually(() => hub.of('hello')[1], 2000, 'a new game connection');
  await eventually(() => again.lines.length >= 2);
  agent.socket.destroy(); // the Agent connection gone: the game connection follows
  await eventually(() => again.closed, 2000);
  assert.deepEqual([...agent.invalid, ...game.invalid, ...again.invalid], []);
});

test('a line from the hub over 1 MiB closes the connection cleanly, then it reconnects; a line of exactly 1 MiB is read', async (t) => {
  const { hub, client } = await setup(t);
  client.start();
  const first = await eventually(() => hub.conns[0]);
  await eventually(() => client.connected);
  // Exactly LIMITS.lineBytes with its newline: read (extra fields dropped), answered.
  const base = JSON.stringify({ type: 'logs', id: 'r1', pad: '' });
  first.socket.write(JSON.stringify({ type: 'logs', id: 'r1', pad: 'x'.repeat(LIMITS.lineBytes - 1 - base.length) }) + '\n');
  await eventually(() => sent(first, 'reply').length === 1);
  // One byte more, with no newline yet: closed as soon as the cap is passed.
  first.socket.write('x'.repeat(LIMITS.lineBytes));
  await eventually(() => first.closed, 2000, 'the connection closed');
  assert.equal(sent(first, 'bye').length, 0, 'not a planned exit');
  const second = await eventually(() => hub.conns[1], 2000, 'a reconnect');
  await eventually(() => client.connected);
  assert.equal(second.kind, 'agentHello');
});

test('every request gets a reply by its id: invalid, unknown and unsupported ones ok: false', async (t) => {
  const seen: unknown[] = [];
  const { hub, client } = await setup(t, undefined, {
    handlers: {
      journal: async (req) => (seen.push(req), { lines: ['one', 'two'] }),
      log: async () => {
        throw new Error('no such log');
      },
    },
  });
  client.start();
  const conn = await eventually(() => hub.conns[0]);
  await eventually(() => client.connected);
  const requests = [
    { type: 'serviceAct', id: 'a', action: 'explode' },
    { type: 'frobnicate', id: 'b' },
    { type: 'restore', id: 'c', name: 'x'.repeat(LIMITS.text + 1) },
    { type: 'update', id: 'd', factorio: { version: '2.1.25', url: 'https://dl.factorio.com/x', sha256: 'aa' }, mods: 'all' },
    { type: 'logs', id: 'e' },
    { type: 'journal', id: 'f', unit: 'factorio.service', extra: 'dropped' },
    { type: 'log', id: 'g', name: 'agent.log' },
  ];
  conn.socket.write('not json\n' + JSON.stringify({ id: 'no-type' }) + '\n' + JSON.stringify({ type: 'logs', id: 'x'.repeat(LIMITS.text + 1) }) + '\n');
  for (const r of requests) conn.send(r);
  await eventually(() => sent(conn, 'reply').length === requests.length, 2000, 'a reply to each');
  const replies = Object.fromEntries(sent(conn, 'reply').map((r) => [r.id, r]));
  assert.deepEqual(replies.a, { type: 'reply', id: 'a', ok: false, error: 'invalid serviceAct' });
  assert.deepEqual(replies.b, { type: 'reply', id: 'b', ok: false, error: 'unknown type' });
  assert.deepEqual(replies.c, { type: 'reply', id: 'c', ok: false, error: 'invalid restore' });
  assert.deepEqual(replies.d, { type: 'reply', id: 'd', ok: false, error: 'invalid update' });
  assert.deepEqual(replies.e, { type: 'reply', id: 'e', ok: false, error: `logs is not supported by ${VERSION}` });
  assert.deepEqual(replies.f, { type: 'reply', id: 'f', ok: true, data: { lines: ['one', 'two'] } });
  assert.deepEqual(replies.g, { type: 'reply', id: 'g', ok: false, error: 'no such log' });
  assert.deepEqual(seen, [{ type: 'journal', id: 'f', unit: 'factorio.service' }], 'a handler gets only the documented fields');
  assert.equal(conn.closed, false, 'lines with no usable id are dropped; the connection stays');
  assert.deepEqual(conn.invalid, []);
});

test('a reject is retried with backoff and logged once', async (t) => {
  const { hub, client } = await setup(t, () => ({ reject: 'bad token' }), { backoffMs: 10, maxBackoffMs: 20 });
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => logged.push(line));
  client.start();
  await eventually(() => hub.conns.length >= 4, 2000);
  assert.equal(client.connected, false);
  assert.equal(logged.filter((l) => l.includes('rejected: bad token')).length, 1, logged.join('\n'));
});

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { HubClient, backoff, type HubOptions } from '../src/hub.ts';
import { RconNoAnswer, RconNotSent } from '../src/rcon.ts';
import { StatusPoller, type Reading } from '../src/status.ts';
import { LIMITS } from '../src/wire.ts';
import { eventually, fakeHub, type Answer, type HubConn } from './fake-hub.ts';
import { PASSWORD, fakeRcon } from './fake-rcon.ts';

const TOKEN = 'agent-token-'.padEnd(40, 'x');
const VERSION = 'agent-v1.2.3';
const READING: Reading = { ups: null, players: [], paused: true, modVersion: '0.1.0' };
const SERVER = { id: 'factorio', unit: 'factorio.service', install: '/opt/factorio', data: '/srv/factorio', rconPort: 1, factorioUdpPort: 34198, agentUdpPort: 34199 };

async function setup(t: TestContext, answer?: (hello: Record<string, unknown>, conn: HubConn) => Answer, options: Partial<HubOptions> = {}) {
  const hub = await fakeHub(answer);
  const root = await mkdtemp(join(tmpdir(), 'orrery-agent-'));
  const client = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: SERVER, token: TOKEN, root, state: join(root, 'state') },
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
  // The welcomed one, not the second by index: a slow machine may have opened (and timed out) another silent one first.
  const second = await eventually(() => hub.of('agentHello').find((c) => c !== first && sent(c, 'ping').length >= 2), 2000, 'pings');
  assert.ok(first!.closed);
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
  // Lower bounds only (a timer is never early, a busy machine makes it late): they show the doubling, since a flat
  // retry would wait 40 ms each time. The cap is `backoff`'s own test above: an upper bound here would race the machine.
  for (const [i, want] of [40, 80, 160, 160].entries()) assert.ok(gaps[i]! >= want - 5, `wait ${i} was ${gaps[i]} ms, want ${want}`);
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
  assert.ok(second.at - dropped >= 35 && second.at - dropped < 1000, `retried after ${second.at - dropped} ms, not a capped wait`);
});

test('the game connection: a hello with the agent token and the mod version, then heartbeats; stop sends bye and closes both', async (t) => {
  const { hub, client } = await setup(t);
  client.start();
  await eventually(() => client.connected);
  client.status(READING);
  const game = await eventually(() => hub.of('hello')[0]);
  assert.deepEqual(game.lines[0], { type: 'hello', protocol: 1, serverId: 'factorio', token: TOKEN, modVersion: '0.1.0' });
  // Heartbeats start once the client has read the welcome: the first status again until one lands (RCON answers
  // every 5 s), so the first heartbeat may come more than once.
  const busy = { type: 'heartbeat', tps: 59.8, players: ['alice', 'bob'], paused: false };
  await eventually(() => (client.status({ ups: 59.8, players: ['alice', 'bob'], paused: false, modVersion: '0.1.0' }), game.lines.length >= 2));
  client.status({ ups: 0.2, players: [], paused: true, modVersion: '0.1.0' });
  await eventually(() => game.lines.at(-1)?.tps === 0.2);
  assert.deepEqual(game.lines.slice(1), [...game.lines.slice(1, -1).map(() => busy), { type: 'heartbeat', tps: 0.2, players: [], paused: true }]);

  const agent = hub.of('agentHello')[0]!;
  await client.stop();
  await eventually(() => agent.closed && game.closed, 2000, 'both connections closed');
  assert.deepEqual(agent.lines.at(-1), { type: 'bye' });
  assert.equal(hub.conns.length, 2, 'no reconnect after stop');
  assert.deepEqual([...agent.invalid, ...game.invalid], []);
});

test('the game connection opens only while the Agent connection is up and RCON answers; a stall keeps it; with no unit state known, RCON gone closes it', async (t) => {
  let tick = 0;
  let mode: 'status' | 'hang' | 'garbage' = 'status';
  const handle = (cmd: string) => {
    if (cmd !== '/orrery-status') return [];
    if (mode === 'hang') return undefined; // like a frozen server: no answer at all
    if (mode === 'garbage') return 'Unknown command "orrery-status".';
    tick += 3;
    return JSON.stringify({ ok: true, tick, tick_paused: false, players: ['alice'], version: '2.1.24', mods: { base: '2.1.24', orrery: '0.1.0' }, loaded: true });
  };
  let rcon = await fakeRcon(handle);
  t.after(() => rcon.close());
  let welcome = false;
  const { hub, client } = await setup(t, (hello) => (hello.type === 'hello' || welcome ? 'welcome' : 'silent'), { handshakeMs: 5000 });
  const poller = new StatusPoller({ port: rcon.port, password: PASSWORD, settings: '/nonexistent/server-settings.json', intervalMs: 20, timeoutMs: 100 });
  poller.on('status', (r) => client.status(r));
  poller.on('stalled', () => client.stalled());
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

  for (const stall of ['hang', 'garbage'] as const) {
    mode = stall; // a blocking save or a frozen server: no heartbeats, so the hub sees it hung, not crashed
    await sleep(60);
    const beats = game.lines.length;
    await sleep(350);
    assert.equal(game.lines.length, beats, `no heartbeat while RCON stalls (${stall})`);
    assert.equal(game.closed, false, `a stall (${stall}) keeps the game connection`);
    mode = 'status';
    await eventually(() => game.lines.length > beats, 2000, `heartbeats again after the ${stall}`);
  }
  assert.equal(hub.of('hello').length, 1, 'the same game connection all along');

  await rcon.close(); // Factorio gone: nothing listens on the RCON port
  await eventually(() => game.closed, 2000, 'the game connection closed');
  await sleep(60);
  assert.equal(hub.of('hello').length, 1, 'not reopened while RCON is gone');
  assert.equal(agent.closed, false, 'the Agent connection stays up');

  rcon = await fakeRcon(handle, Infinity, rcon.port);
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

test('every request gets a reply by its id: invalid, unknown and unsupported ones ok: false; an error redacted and cut', async (t) => {
  const seen: unknown[] = [];
  const { hub, client } = await setup(t, undefined, {
    handlers: {
      journal: async (req) => (seen.push(req), { lines: ['one', 'two'] }),
      log: async () => {
        throw new Error('no such log');
      },
      restore: async () => {
        throw new Error(`can't fetch https://dl.factorio.com/x1.zip?secure=abc&expires=1 ${'😀'.repeat(LIMITS.detail)}`);
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
    { type: 'restore', id: 'h', name: 'world.zip' },
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
  const h = replies.h!.error as string;
  assert.ok(h.startsWith("can't fetch https://dl.factorio.com/x1.zip 😀"), 'no query string');
  assert.ok(h.length <= LIMITS.detail && !/[\uD800-\uDBFF]$/.test(h), 'cut to 2 KiB, never half a surrogate pair');
  assert.deepEqual(seen, [{ type: 'journal', id: 'f', unit: 'factorio.service' }], 'a handler gets only the documented fields');
  assert.equal(conn.closed, false, 'lines with no usable id are dropped; the connection stays');
  assert.deepEqual(conn.invalid, []);
});

test('deliver: false while not connected; true once the line is written; false when its write fails', async (t) => {
  const { hub, client } = await setup(t);
  const done = { type: 'updateDone', id: 'u1', outcome: 'ok', from: '2.1.24 · 3 mods', to: '2.1.25 · 4 mods' } as const;
  assert.equal(await client.deliver(done), false, 'no connection yet');
  client.start();
  await eventually(() => client.connected);
  const agent = hub.of('agentHello')[0]!;
  assert.equal(await client.deliver(done), true);
  await eventually(() => sent(agent, 'updateDone').length === 1);
  // A write that fails, as on a connection that drops while the line goes out.
  t.mock.method(Socket.prototype, 'write', function (this: Socket, _line: string, cb?: (err?: Error) => void) {
    process.nextTick(() => cb?.(new Error('write EPIPE')));
    return false;
  });
  assert.equal(await client.deliver(done), false);
  t.mock.restoreAll();
  await client.stop();
  assert.equal(await client.deliver(done), false, 'stopping');
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

const T0 = 1_793_475_900_000;
const unit = (since: number, active = 'active') => ({ unit: 'factorio.service', active, sub: active === 'active' ? 'running' : 'dead', since, result: 'success' });

test('started once per run of the unit, after the game hello; not again for a run already announced, even by an earlier agent', async (t) => {
  const { hub, client, root } = await setup(t);
  client.start();
  await eventually(() => client.connected);
  client.status(READING); // RCON answers before the unit's first reading: started waits for it
  const game = await eventually(() => hub.of('hello')[0]);
  await sleep(30);
  assert.deepEqual(sent(game, 'started'), []);
  client.service(unit(T0));
  await eventually(() => sent(game, 'started').length === 1, 2000, 'started');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'state', 'started.json'), 'utf8')), { since: T0 });

  game.socket.destroy(); // the hub dropped the game connection: the next one is the same run
  await eventually(() => game.closed);
  // The next RCON answer opens a new one, once the client has seen the close too: answers until it has.
  const again = await eventually(() => (client.status(READING), hub.of('hello')[1]), 2000, 'a new game connection');
  await sleep(50);
  assert.deepEqual(sent(again, 'started'), [], 'the same run: no second started');
  await client.stop();

  // A new agent (a deploy, a restart) on the same run: nothing; on the next run: started.
  const next = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: SERVER, token: TOKEN, root, state: join(root, 'state') },
    version: VERSION,
  });
  t.after(() => next.stop());
  next.service(unit(T0));
  next.start();
  await eventually(() => next.connected);
  next.status(READING);
  const third = await eventually(() => hub.of('hello')[2], 2000, 'the new agent’s game connection');
  await sleep(50);
  assert.deepEqual(sent(third, 'started'), [], 'announced by the agent before');
  next.service(unit(T0 + 5000)); // restarted between two readings
  await eventually(() => third.closed, 2000, 'the old run’s game connection closed');
  assert.deepEqual(sent(third, 'stopping').length, 1);
  next.status(READING);
  const fourth = await eventually(() => hub.of('hello')[3], 2000, 'the next run’s game connection');
  await eventually(() => sent(fourth, 'started').length === 1, 2000, 'started for the next run');
  assert.deepEqual(hub.conns.flatMap((c) => c.invalid), []);
});

test("a game hello the hub refuses as reconnecting too fast is tried again on the next RCON answer, every time (an update's gate waits for it), never given up", async (t) => {
  let refused = 0;
  const { hub, client } = await setup(t, (hello) => {
    if (hello.type === 'hello' && refused < 4) {
      refused++;
      return { reject: 'reconnecting too fast' };
    }
    return 'welcome';
  });
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => logged.push(line));
  client.service(unit(T0)); // the swap started the unit: a new run
  client.start();
  await eventually(() => client.connected);
  // RCON answers, as the status poll does every 5 s while the new Factorio runs.
  const poll = setInterval(() => client.status(READING), 20);
  t.after(() => clearInterval(poll));
  await eventually(() => client.gameUp, 3000, 'the game connection, after four refusals');
  clearInterval(poll);
  assert.equal(refused, 4);
  const hellos = hub.of('hello');
  assert.equal(hellos.length, 5, 'one hello per try: four refused, the fifth welcomed');
  for (const c of hellos.slice(0, 4)) await eventually(() => c.closed, 2000, 'a refused one closed');
  assert.equal(hub.of('agentHello').length, 1, 'the Agent connection stayed');
  assert.ok(!logged.some((l) => l.startsWith('[hub]') && l.includes('(rejected: ')), 'no [hub] rejection, which the first-boot check stops at');
});

test('a console cmd on the game connection runs through command and is answered by cmdResult; one the agent won’t run is answered too', async (t) => {
  const ran: string[] = [];
  const command = async (c: string) => {
    ran.push(c);
    if (c === '/slow') throw new RconNoAnswer('RCON command timed out after 4000 ms'); // sent: Factorio may still run it
    if (c === '/queued') throw new RconNotSent('RCON connection closed before the command was sent');
    return ['Online players (1):', '  alice (online)'];
  };
  const { hub, client } = await setup(t, undefined, { command });
  client.start();
  await eventually(() => client.connected);
  client.status(READING);
  const game = await eventually(() => hub.of('hello')[0]);
  game.send({ type: 'cmd', id: 'c1', command: '/players' });
  game.send({ type: 'cmd', id: 'c2', command: '/slow' });
  game.send({ type: 'cmd', id: 'c3', command: 'x'.repeat(LIMITS.text + 1) });
  game.send({ type: 'cmd', id: 'c4', command: '/c game.print(1)\n/c game.print(2)' });
  game.send({ type: 'cmd', id: 'c5', command: '/queued' });
  await eventually(() => sent(game, 'cmdResult').length === 5, 2000, 'five results');
  const out = Object.fromEntries(sent(game, 'cmdResult').map((r) => [r.id, r.output as string[]]));
  assert.deepEqual(out.c1, ['Online players (1):', '  alice (online)']);
  assert.deepEqual(out.c2, ['no answer in time (Factorio may be saving): the command may still run (RCON command timed out after 4000 ms)']);
  assert.deepEqual(out.c5, ['the command did not run: RCON connection closed before the command was sent']);
  assert.match(out.c3![0]!, /^refused/);
  assert.match(out.c4![0]!, /^refused/, 'one line only');
  assert.deepEqual(ran, ['/players', '/slow', '/queued'], 'only valid commands reach RCON');
  assert.deepEqual(game.invalid, []);
});

test('the saves list goes on the Agent connection on each connect and change; the game connection’s save goes to save, and backup back on it', async (t) => {
  let saves = 0;
  const { hub, client } = await setup(t, undefined, { save: () => saves++ });
  const list = { saves: [{ name: 'world.zip', size: 10, mtime: T0, kind: 'world' as const, current: true }], free: 1e9 };
  client.saves(list); // before any connection: kept for it
  client.start();
  const agent = await eventually(() => hub.of('agentHello')[0]);
  await eventually(() => sent(agent, 'saves').length === 1, 2000, 'saves on connect');
  assert.deepEqual(sent(agent, 'saves')[0], { type: 'saves', ...list });
  client.saves({ ...list, free: 5e8 });
  await eventually(() => sent(agent, 'saves').length === 2, 2000, 'saves on change');

  client.status(READING);
  const game = await eventually(() => hub.of('hello')[0]);
  game.send({ type: 'save' });
  await eventually(() => saves === 1, 2000, 'save called');
  client.backup({ ok: true, detail: 'Saved orrery-20261031T120000Z.zip (1.0 MB)' });
  await eventually(() => sent(game, 'backup').length === 1, 2000, 'backup');
  assert.deepEqual(sent(game, 'backup')[0], { type: 'backup', ok: true, detail: 'Saved orrery-20261031T120000Z.zip (1.0 MB)' });

  agent.socket.destroy(); // a new Agent connection gets the latest list again
  const second = await eventually(() => hub.of('agentHello')[1], 2000, 'reconnected');
  await eventually(() => sent(second, 'saves').length === 1, 2000, 'saves on the new connection');
  assert.equal(sent(second, 'saves')[0]!.free, 5e8);
  assert.deepEqual(hub.conns.flatMap((c) => c.invalid), []);
});

test('no game connection while the unit is known and not active: RCON may still answer a Factorio that is shutting down', async (t) => {
  const { hub, client } = await setup(t);
  client.start();
  await eventually(() => client.connected);
  client.service(unit(T0, 'deactivating'));
  client.status(READING);
  await sleep(50);
  assert.equal(hub.of('hello').length, 0);
  client.service(unit(T0 + 1000, 'inactive'));
  client.service(unit(T0 + 5000));
  client.status(READING);
  const game = await eventually(() => hub.of('hello')[0], 2000, 'a game connection for the new run');
  await eventually(() => sent(game, 'started').length === 1);
});

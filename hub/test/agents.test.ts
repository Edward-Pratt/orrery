import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, Server, Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { Agents, type AgentsOptions } from '../src/agents.ts';
import { Db } from '../src/db.ts';
import { Hosts } from '../src/host.ts';
import { LiveFeed } from '../src/live.ts';
import { LIMITS } from '../src/protocol.ts';
import { ServerHub, type HubEvent, type HubOptions, type TargetEvent } from '../src/servers.ts';
import { fakeMod, online, sleep, TOKEN, until } from './fake-mod.ts';

const AGENT_TOKEN = 'agent-token-0123456789abcdef-0123456789';
const LIMITS_VM = { memoryMaxPercent: 90, memoryMinutes: 5, diskMinFreeGB: 10 };
const VM = { id: 'vm', name: 'Factorio VM', token: AGENT_TOKEN, address: '127.0.0.1', server: 'space', host: LIMITS_VM };

const agentHello = (token = AGENT_TOKEN, agentId = 'vm', protocol = 1) => ({ type: 'agentHello', protocol, agentId, token, agentVersion: 'agent-v1.0.0' });
const gameHello = (token = AGENT_TOKEN, serverId = 'space') => ({ type: 'hello', protocol: 1, serverId, token, modVersion: '0.1.0' });
const SAMPLE = { ts: 1_000, cpu: 0.25, load: [1, 0.5, 0.25], memory: { used: 1, total: 4 }, disks: [{ mount: '/', free: 3, total: 9 }] };

/**
 * A hub with a minecraft server (`gtnh`, on no port here) and a factorio one (`space`) run by Agent `vm`, whose
 * address is `address` (default the tests' own, 127.0.0.1); the Agent port on an ephemeral port, welcoming a
 * reconnect at once unless `agents.handshakeMs` says otherwise.
 */
async function setup(t: TestContext, { address = '127.0.0.1', hub: hubOpts = {}, agents: agentOpts = {} }: { address?: string; hub?: HubOptions; agents?: AgentsOptions } = {}) {
  const hub = new ServerHub(
    [
      { id: 'gtnh', name: 'GTNH', game: 'minecraft', token: TOKEN },
      { id: 'space', name: 'Space Age', game: 'factorio' },
    ],
    { settleMs: 100, ...hubOpts },
  );
  hub.start();
  const db = new Db(':memory:');
  const hosts = new Hosts(hub, db);
  hosts.add({ id: 'vm', mounts: [], ...LIMITS_VM });
  const agents = new Agents(hub, hosts, { listen: { host: '127.0.0.1', port: 0 }, agents: [{ ...VM, address }] }, { silenceMs: 5_000, handshakeMs: 0, ...agentOpts });
  const port = await agents.start();
  const events: HubEvent[] = [];
  hub.on('event', (e) => events.push(e));
  const targets: TargetEvent[] = [];
  hub.on('target', (e) => targets.push(e));
  t.after(async () => {
    await agents.close();
    await hub.close();
    db.close();
  });
  const notices = () => targets.flatMap((e) => (e.type === 'notice' ? [e.kind] : []));
  return { hub, agents, hosts, db, port, events, targets, notices, types: () => events.map((e) => e.type) };
}

/**
 * The hub's side of each connection the Agent port goes on to read (it resumes each one it accepts), in order: so a
 * test can wait until the hub has read what it sent, even lines the hub drops.
 */
function hubSides(t: TestContext, port: number): Socket[] {
  const sides: Socket[] = [];
  const resume = Socket.prototype.resume;
  t.mock.method(Socket.prototype, 'resume', function (this: Socket) {
    if (this.localPort === port && !sides.includes(this)) sides.push(this);
    return resume.call(this);
  });
  return sides;
}

/** Waits for `cond` by the real clock (`Date` may be mocked), failing after 2 s. */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const end = performance.now() + 2000;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`${what}: not in time`);
    await sleep(2);
  }
}

/** Waits until the hub's side has read every byte `client` wrote (its lines are handled as they are read), or is gone. */
const readAll = (side: Socket, client: Socket) => waitFor(() => side.destroyed || side.bytesRead >= client.bytesWritten, 'the hub reading');

async function agentUp(port: number) {
  const agent = fakeMod(port);
  agent.send(agentHello());
  assert.deepEqual(await agent.next(), { type: 'welcome' });
  return agent;
}

async function gameUp(port: number) {
  const game = fakeMod(port);
  game.send(gameHello());
  assert.deepEqual(await game.next(), { type: 'welcome' });
  return game;
}

test('a connection from another address is destroyed with zero bytes read, for both first lines', async (t) => {
  const { port, types, targets } = await setup(t, { address: '127.0.0.2' }); // the tests connect from 127.0.0.1
  const destroy = Socket.prototype.destroy;
  const read: number[] = []; // bytes the hub's side had read when it destroyed it
  t.mock.method(Socket.prototype, 'destroy', function (this: Socket, ...args: Parameters<Socket['destroy']>) {
    if (this.localPort === port) read.push(this.bytesRead);
    return destroy.apply(this, args);
  });
  for (const first of [agentHello(), gameHello()]) {
    const client = fakeMod(port);
    client.send(first);
    client.send({ type: 'ping' });
    await client.closed;
    assert.equal(client.socket.bytesRead, 0, `${first.type}: no reply`);
  }
  assert.ok(read.length >= 2 && read.every((bytes) => bytes === 0), `read ${read}`);
  assert.deepEqual(types(), []);
  assert.deepEqual(targets, []);
});

test('a line over the cap closes the connection, before and after the handshake (a 100 MB one too), and the hub stays up', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { agents, port } = await setup(t);
  const huge = Buffer.alloc(100 * 1024 * 1024, 'a');
  const before = fakeMod(port);
  before.socket.write(huge);
  await before.closed;

  const agent = await agentUp(port);
  const atCap = JSON.stringify({ type: 'ping', pad: '' });
  agent.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(LIMITS.lineBytes - atCap.length) })); // exactly the cap: fine
  agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since: 1, result: 'success' });
  await new Promise((resolve) => agents.once('serviceState', resolve));
  agent.socket.write(huge);
  await agent.closed;
  await waitFor(() => agents.get('vm')?.connected === false, 'the hub saw it close'); // its close may come after the peer's
  assert.equal(errors.mock.calls.filter((c) => /a line over 1048576 bytes, closing/.test(String(c.arguments[0]))).length, 2);

  await agentUp(port); // still listening, and handshakes as before
  assert.equal(agents.get('vm')?.connected, true);
});

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

test('unknown fields never reach events, the Host or the state', async (t) => {
  const { agents, hosts, port, events, hub } = await setup(t);
  const agent = await agentUp(port);
  const pushed: unknown[] = [];
  agents.on('serviceState', (id, msg) => pushed.push([id, msg]));
  agents.on('saves', (id, msg) => pushed.push([id, msg]));
  agent.send('{"type":"serviceState","unit":"factorio.service","active":"active","sub":"running","since":5,"result":"success","evil":1,"__proto__":{"admin":true}}');
  agent.send({ type: 'saves', saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'auto', current: false, path: '/etc/passwd' }], free: 9, extra: [1] });
  const before = Date.now();
  agent.send({ type: 'hostSample', sample: { ...SAMPLE, memory: { ...SAMPLE.memory, swap: 7 }, disks: [{ ...SAMPLE.disks[0], device: 'sda' }], extra: 1 }, more: 2 });
  await until(() => pushed.length === 2 && hosts.get('vm')!.latest() !== null);
  assert.deepEqual(pushed, [
    ['vm', { type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since: 5, result: 'success' }],
    ['vm', { type: 'saves', saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'auto', current: false }], free: 9 }],
  ]);
  assert.equal(Object.getPrototypeOf((pushed[0] as unknown[])[1]), Object.prototype);
  const latest = hosts.get('vm')!.latest()!;
  assert.deepEqual(latest, { ...SAMPLE, ts: latest.ts });
  assert.ok(latest.ts >= before && latest.ts <= Date.now(), `${latest.ts}`); // the hub's clock, not the Agent's

  const game = await gameUp(port);
  game.send({ type: 'chat', player: 'Ann', message: 'hi', serverId: 'gtnh', avatar: 'x' });
  game.send({ type: 'heartbeat', tps: 60, players: ['Ann'], paused: false, dims: [], cpu: 3 });
  await until(() => hub.get('space')?.tps === 60);
  assert.deepEqual(events.find((e) => e.type === 'chat'), { type: 'chat', player: 'Ann', message: 'hi', serverId: 'space' });
  assert.deepEqual(hub.get('space'), { id: 'space', name: 'Space Age', game: 'factorio', online: true, hung: false, paused: false, tps: 60, players: ['Ann'], dims: [] });
});

test('handshake: a bad token, an unknown Agent or protocol, a wrong server, and a game hello before its Agent are refused', async (t) => {
  const { hub, agents, port, types } = await setup(t, { agents: { helloTimeoutMs: 100 } });
  const refused = async (first: object, reason: string) => {
    const client = fakeMod(port);
    client.send(first);
    assert.deepEqual(await client.next(), { type: 'reject', reason }, JSON.stringify(first));
    await client.closed;
  };
  await refused(agentHello('x'.repeat(AGENT_TOKEN.length)), 'unknown agentId or bad token');
  await refused(agentHello(AGENT_TOKEN, 'other'), 'unknown agentId or bad token');
  await refused(agentHello(AGENT_TOKEN, 'vm', 2), 'protocol 2 not supported (hub speaks 1)');
  await refused(gameHello(), 'its agent is not connected');
  await refused(gameHello(TOKEN, 'gtnh'), 'unknown serverId or bad token'); // a Mod's token is no good here
  assert.equal(agents.get('vm')?.connected, false);

  const agent = await agentUp(port);
  await refused(gameHello(AGENT_TOKEN, 'gtnh'), 'unknown serverId or bad token'); // not this Agent's server
  await refused(gameHello('y'.repeat(AGENT_TOKEN.length)), 'unknown serverId or bad token');
  for (const junk of [{ type: 'ping' }, { type: 'chat', player: 'a', message: 'b' }]) {
    const client = fakeMod(port);
    client.send(junk); // not a first line: closed without a word
    await client.closed;
    assert.equal(client.socket.bytesRead, 0);
  }
  const silent = fakeMod(port);
  await silent.closed; // no first line in time
  assert.equal(hub.get('space')?.online, false);
  assert.deepEqual(types(), []);

  await gameUp(port);
  assert.equal(hub.get('space')?.online, true);
  assert.equal(hub.modVersion('space'), '0.1.0');
  const second = await agentUp(port); // replaces the first, with no notice
  await agent.closed;
  await sleep(50);
  assert.deepEqual(types(), ['connected']);
  assert.deepEqual(agents.list(), [{ id: 'vm', name: 'Factorio VM', server: 'space', connected: true, version: 'agent-v1.0.0' }]);
  second.send({ type: 'ping' });
});

test('the Agent port asks for its address again every 10 s while it is not on this machine, logging once', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const listen = Server.prototype.listen;
  let calls = 0;
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
    calls++;
    if (calls <= 2) {
      process.nextTick(() => this.emit('error', Object.assign(new Error('listen EADDRNOTAVAIL: address not available'), { code: 'EADDRNOTAVAIL' })));
      return this;
    }
    return (listen as (...a: unknown[]) => Server).apply(this, [args[0], '127.0.0.1', ...args.slice(2)]); // the address came up
  });
  const hub = new ServerHub([{ id: 'space', name: 'Space Age', game: 'factorio' }]);
  const db = new Db(':memory:');
  const agents = new Agents(hub, new Hosts(hub, db), { listen: { host: '100.101.102.103', port: 0 }, agents: [VM] }, { bindRetryMs: 30 });
  t.after(async () => {
    await agents.close();
    db.close();
  });
  const bound = agents.start();
  assert.equal(await Promise.race([bound, sleep(10).then(() => 'waiting')]), 'waiting'); // nothing waits on it
  const port = await bound;
  assert.equal(calls, 3);
  assert.deepEqual(errors.mock.calls.map((c) => c.arguments[0]), ['[agents] 100.101.102.103 is not on this machine yet: trying again every 0.03 s']);
  await agentUp(port);
});

test('an address not on this machine really is EADDRNOTAVAIL: retried until closed', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const listens = t.mock.method(Server.prototype, 'listen');
  const hub = new ServerHub([{ id: 'space', name: 'Space Age', game: 'factorio' }]);
  const db = new Db(':memory:');
  const agents = new Agents(hub, new Hosts(hub, db), { listen: { host: '192.0.2.1', port: 0 }, agents: [VM] }, { bindRetryMs: 20 });
  let settled = false;
  agents.start().then(
    () => (settled = true),
    () => (settled = true),
  );
  await until(() => listens.mock.callCount() >= 3);
  await agents.close();
  db.close();
  assert.equal(settled, false);
  assert.equal(errors.mock.callCount(), 1);
});

test('bye: the server is lost, silently, its game connection dropped, even if that closed first', async (t) => {
  const { hub, agents, port, types, notices } = await setup(t, { hub: { settleMs: 1_000 } });
  const agent = await agentUp(port);
  const game = await gameUp(port);
  game.send({ type: 'heartbeat', tps: 60, players: ['Ann'] });
  await until(() => hub.get('space')?.players.length === 1);
  agent.send({ type: 'bye' });
  await agent.closed;
  await game.closed;
  await until(() => types().includes('lost'));
  assert.deepEqual(types(), ['connected', 'tps', 'lost']);
  assert.deepEqual(hub.get('space'), { id: 'space', name: 'Space Age', game: 'factorio', online: false, hung: false, paused: false, tps: null, players: [], dims: [] });
  assert.equal(agents.get('vm')?.connected, false);

  // The game connection's close can come first, on its own stream: it waits for the Agent's.
  const again = await agentUp(port);
  const game2 = await gameUp(port);
  game2.socket.destroy();
  await sleep(50);
  again.send({ type: 'bye' });
  await until(() => types().filter((type) => type === 'lost').length === 2);
  await sleep(50);
  assert.deepEqual(types(), ['connected', 'tps', 'lost', 'connected', 'lost']);
  await agentUp(port);
  await sleep(50);
  assert.deepEqual(notices(), []); // no agentLost, so no agentBack either
});

test('silence or a close without bye: the Agent is lost, once, with no hung alert, then back', async (t) => {
  const { hub, agents, port, types, targets } = await setup(t, { hub: { hungMs: 400 }, agents: { silenceMs: 150 } });
  const lost: string[] = [];
  agents.on('agentLost', (id) => lost.push(`lost ${id}`));
  agents.on('agentBack', (id) => lost.push(`back ${id}`));
  const agent = await agentUp(port);
  const game = await gameUp(port);
  game.send({ type: 'heartbeat', tps: 60, players: [] });
  await until(() => hub.get('space')?.tps === 60);
  await agent.closed; // silent: the hub drops it after 150 ms
  await game.closed;
  await sleep(500); // past hungMs
  assert.deepEqual(types(), ['connected', 'tps', 'lost']);
  assert.deepEqual(targets, [{ target: 'host', id: 'vm', type: 'notice', severity: 'warning', kind: 'agentLost', name: 'Factorio VM' }]);

  const back = await agentUp(port);
  assert.deepEqual(targets.at(-1), { target: 'host', id: 'vm', type: 'notice', severity: 'good', kind: 'agentBack', name: 'Factorio VM' });
  back.socket.destroy(); // a close without bye
  await until(() => types().filter((type) => type === 'lost').length === 2);
  assert.deepEqual(lost, ['lost vm', 'back vm', 'lost vm']);
  assert.equal(targets.filter((e) => e.type === 'notice' && e.kind === 'agentLost').length, 2);
});

test('a game connection closing without stopping waits for its Agent: lost if that closes too, else crashed', async (t) => {
  const { port, types, notices } = await setup(t, { hub: { settleMs: 150 } });
  const agent = await agentUp(port);
  const game = await gameUp(port);
  game.socket.destroy();
  await sleep(30);
  agent.socket.destroy(); // within the settle: the Agent is lost, the server didn't crash
  await until(() => types().includes('lost'));
  await sleep(200);
  assert.deepEqual(types(), ['connected', 'lost']);
  assert.deepEqual(notices(), ['agentLost']);

  const again = await agentUp(port);
  const crashing = await gameUp(port);
  crashing.socket.destroy(); // the Agent stays: a crash, once the settle is over
  await sleep(50);
  assert.deepEqual(types(), ['connected', 'lost', 'connected']);
  await until(() => types().includes('crashed'));
  const stopping = await gameUp(port);
  stopping.send({ type: 'stopping' });
  stopping.socket.end();
  await until(() => types().includes('stopped')); // a stop needs no wait
  assert.deepEqual(types(), ['connected', 'lost', 'connected', 'crashed', 'connected', 'stopped']);
  again.send({ type: 'ping' });
});

test('a frozen game while paused is reported hung: its Agent pings on, its heartbeats stop', async (t) => {
  const { hub, port, types } = await setup(t, { hub: { hungMs: 200 } });
  const agent = await agentUp(port);
  const game = await gameUp(port);
  game.send({ type: 'heartbeat', tps: 1, players: [], paused: true });
  await until(() => hub.get('space')?.paused === true);
  assert.equal(hub.get('space')?.tps, null); // a paused server's rate is ignored
  const pings = setInterval(() => agent.send({ type: 'ping' }), 50);
  t.after(() => clearInterval(pings));
  await until(() => types().includes('hung'));
  assert.deepEqual(types(), ['connected', 'paused', 'hung']); // no tps event while paused
  game.send({ type: 'heartbeat', tps: 59.5, players: ['Ann'], paused: false });
  await until(() => types().includes('recovered'));
  assert.deepEqual(hub.get('space'), { id: 'space', name: 'Space Age', game: 'factorio', online: true, hung: false, paused: false, tps: 59.5, players: ['Ann'], dims: [] });
  assert.deepEqual(types(), ['connected', 'paused', 'hung', 'paused', 'tps', 'recovered']);
});

test("a change in a factorio server's paused goes on the stream, once per change, before its rate", async (t) => {
  const { hub, port, events } = await setup(t);
  await agentUp(port);
  const game = await gameUp(port);
  const beat = (paused: boolean | undefined, tps = 60) => game.send({ type: 'heartbeat', tps, players: [], ...(paused === undefined ? {} : { paused }) });
  beat(false); // as it was: not paused
  beat(true);
  beat(true);
  beat(undefined, 59); // no `paused` is not paused
  beat(false, 59);
  beat(true, 59);
  await until(() => events.filter((e) => e.type === 'paused').length === 3);
  await sleep(50);
  const seen = () => events.flatMap((e) => (e.type === 'paused' ? [`paused ${e.paused}`] : e.type === 'tps' ? [`tps ${e.tps}`] : []));
  assert.deepEqual(seen(), ['tps 60', 'paused true', 'paused false', 'tps 59', 'paused true']);
  assert.equal(hub.get('space')?.paused, true);
});

test("each Agent's host samples go to its own Host's monitor", async (t) => {
  const { hosts, port } = await setup(t);
  const own = hosts.add({ id: 'oracle', mounts: ['/'], ...LIMITS_VM });
  const agent = await agentUp(port);
  agent.send({ type: 'hostSample', sample: SAMPLE });
  await until(() => hosts.get('vm')!.latest() !== null);
  assert.equal(own.latest(), null);
  assert.deepEqual(hosts.get('vm')!.history(1).map((s) => s.cpu), [SAMPLE.cpu]);
  assert.deepEqual(own.history(1), []);
});

test('requests carry fresh ids, answer with checked data, and fail on refusal, bad data, a timeout or a disconnect', async (t) => {
  const { agents, port } = await setup(t, { agents: { requestTimeoutMs: 100 } });
  await assert.rejects(agents.request('vm', { type: 'logs' }), /agent vm is not connected/);
  const agent = await agentUp(port);
  const journal = agents.request('vm', { type: 'journal', unit: 'factorio.service' });
  const asked = (await agent.next()) as { type: string; id: string; unit: string };
  assert.equal(asked.type, 'journal');
  assert.equal(asked.unit, 'factorio.service');
  agent.send({ type: 'reply', id: asked.id, ok: true, data: { lines: ['a', 'b'], extra: 1 } });
  assert.deepEqual(await journal, { lines: ['a', 'b'] });

  const act = agents.request('vm', { type: 'serviceAct', action: 'start' });
  const acted = (await agent.next()) as { id: string; action: string };
  assert.notEqual(acted.id, asked.id);
  assert.equal(acted.action, 'start');
  agent.send({ type: 'reply', id: acted.id, ok: true });
  assert.equal(await act, undefined);

  const refused = agents.request('vm', { type: 'restore', name: 'x.zip' });
  agent.send({ type: 'reply', id: ((await agent.next()) as { id: string }).id, ok: false, error: 'the server is running' });
  await assert.rejects(refused, /the server is running/);
  const bad = agents.request('vm', { type: 'log', name: 'agent.log' });
  agent.send({ type: 'reply', id: ((await agent.next()) as { id: string }).id, ok: true, data: { lines: [1] } });
  await assert.rejects(bad, /malformed/);
  const late = agents.request('vm', { type: 'logs' });
  await agent.next();
  await assert.rejects(late, /did not answer in time/);
  const dropped = agents.request('vm', { type: 'logs' });
  await agent.next();
  agent.socket.destroy();
  await assert.rejects(dropped, /disconnected/);
});

test('a line whose handling throws ends only its own connection; a deeply nested reply is just refused', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { agents, port } = await setup(t);
  agents.on('saves', () => {
    throw new Error('a listener broke');
  });
  const agent = await agentUp(port);
  const depth = 500_000; // under the line cap
  agent.send(`{"type":"reply","id":"x","ok":true,"data":${'['.repeat(depth)}${']'.repeat(depth)}}`);
  agent.send({ type: 'saves', saves: [], free: 1 });
  await agent.closed;
  assert.equal(errors.mock.calls.filter((c) => /a line failed, closing/.test(String(c.arguments[0]))).length, 1);
  await agentUp(port); // the hub is still up
  assert.equal(agents.get('vm')?.connected, true);
});

test("broadcast: a Mod's server runs say as an audited command, an Agent's factorio server gets a notice", async (t) => {
  const { hub, port } = await setup(t);
  const mod = await online(await hub.listen(0));
  const sent = hub.broadcast('gtnh', 'Server restarting in 5 minutes', 'hub:restart');
  const cmd = (await mod.next()) as { type: string; id: string; command: string };
  assert.deepEqual([cmd.type, cmd.command], ['cmd', 'say Server restarting in 5 minutes']);
  mod.send({ type: 'cmdResult', id: cmd.id, output: [] });
  await sent;

  await assert.rejects(hub.broadcast('space', 'Server stopping in 1 minute', 'hub:restart'), /Space Age is offline/);
  await agentUp(port);
  const game = await gameUp(port);
  await hub.broadcast('space', 'Server stopping\nin 1 minute', 'hub:restart');
  assert.deepEqual(await game.next(), { type: 'notice', message: 'Server stopping in 1 minute' });
  await assert.rejects(hub.broadcast('space', ' \u0000 ', 'hub:restart'), /empty notice/);
});

test("host samples: at most one stored per 10 s per Agent, reconnecting or not, with the hub's clock as its ts", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'error', () => {});
  const { hosts, db, port } = await setup(t);
  const sides = hubSides(t, port);
  const far = { ...SAMPLE, ts: 8.64e15 }; // the year 275760: the nightly prune by age would never remove it
  const flood = async (agent: Awaited<ReturnType<typeof agentUp>>, n: number) => {
    for (let i = 0; i < n; i++) agent.send({ type: 'hostSample', sample: { ...far, cpu: i / n } });
    await readAll(sides.at(-1)!, agent.socket);
  };
  const start = Date.now();
  const agent = await agentUp(port);
  await flood(agent, 50);
  t.mock.timers.tick(9_999);
  await flood(agent, 10);
  assert.deepEqual(db.hostSamples('vm', 0).map((s) => [s.ts, s.cpu]), [[start, 0]]); // the first one, stamped now
  t.mock.timers.tick(1);
  await flood(agent, 10);
  const again = await agentUp(port); // a new Agent connection gets no fresh sample either
  await flood(again, 10);
  assert.deepEqual(db.hostSamples('vm', 0).map((s) => s.ts), [start, start + 10_000]);
  assert.equal(db.hostSamples('vm', Date.now() + 1).length, 0); // nothing from the Agent's clock
  assert.equal(hosts.get('vm')!.latest()!.ts, start + 10_000);
  t.mock.timers.tick(10_000);
  await flood(again, 1);
  assert.equal(db.hostSamples('vm', 0).length, 3);
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
  assert.equal(db.feed('space', 1000).length, chats);
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

test('a refused connection is destroyed within 2 s even if its peer never sends its FIN', async (t) => {
  const { port } = await setup(t);
  const sides = hubSides(t, port);
  await agentUp(port).then((a) => t.after(() => void a.socket.destroy())); // so a game hello is checked against a token
  for (const first of [agentHello('x'.repeat(AGENT_TOKEN.length)), gameHello('y'.repeat(AGENT_TOKEN.length))]) {
    const client = connect({ port, host: '127.0.0.1', allowHalfOpen: true }); // it stays open after the hub's FIN
    client.on('error', () => {});
    t.after(() => void client.destroy());
    client.write(JSON.stringify(first) + '\n');
    const [line] = (await once(createInterface({ input: client }), 'line')) as [string];
    assert.equal(JSON.parse(line).type, 'reject');
    const at = performance.now();
    await waitFor(() => sides.at(-1)!.destroyed, 'destroyed');
    assert.ok(performance.now() - at < 2000);
    assert.equal(client.destroyed, false); // the peer did nothing
  }
});

test('a fifth connection at once from one address is destroyed with zero bytes read; one closing lets another in', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { agents, port } = await setup(t);
  const sides = hubSides(t, port);
  const destroy = Socket.prototype.destroy;
  const unread: number[] = []; // bytes read by hub sockets destroyed before they were ever resumed
  t.mock.method(Socket.prototype, 'destroy', function (this: Socket, ...args: Parameters<Socket['destroy']>) {
    if (this.localPort === port && !sides.includes(this)) unread.push(this.bytesRead);
    return destroy.apply(this, args);
  });
  const idle = Array.from({ length: 4 }, () => fakeMod(port)); // before any handshake: they count too
  await waitFor(() => sides.length === 4, 'four accepted');
  const fifth = fakeMod(port);
  fifth.send(agentHello());
  await fifth.closed;
  assert.equal(fifth.socket.bytesRead, 0);
  assert.deepEqual(unread, [0]);
  assert.deepEqual(errors.mock.calls.map((c) => c.arguments[0]), ['[agents] over 4 connections at once from one address: 1 refused']);

  idle[0]!.socket.destroy();
  await waitFor(() => sides[0]!.closed, 'the hub saw it close');
  await agentUp(port);
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
    for (let i = 0; i < 200; i++) game.send(i % 2 ? { type: 'chat', player: 'Ann', message: `spam ${i}` } : { type: 'backup', ok: true, detail: `${i}` });
    await readAll(sides.at(-1)!, game.socket);
  }
  // The line burst once in all (100 lines, half of them backups), and of its chat the game events' burst once.
  assert.equal(events.filter((e) => e.type === 'backup').length, 50);
  assert.equal(events.filter((e) => e.type === 'chat').length, 30);
});

test('a connection welcomed again under 5 s after the last of its kind is refused, and the live one stays', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { agents, hub, port, types, notices } = await setup(t, { agents: { handshakeMs: 5_000 } });
  const agent = await agentUp(port);
  const game = await gameUp(port);
  for (const first of [agentHello(), gameHello()]) {
    const again = fakeMod(port);
    again.send(first);
    assert.deepEqual(await again.next(), { type: 'reject', reason: 'reconnecting too fast' });
    await again.closed;
  }
  assert.equal(agents.get('vm')?.connected, true);
  assert.equal(hub.get('space')?.online, true);
  assert.equal(agent.socket.destroyed || game.socket.destroyed, false);
  t.mock.timers.tick(4_999);
  const early = fakeMod(port);
  early.send(gameHello());
  assert.deepEqual(await early.next(), { type: 'reject', reason: 'reconnecting too fast' });
  t.mock.timers.tick(1);
  await agentUp(port); // 5 s on: welcomed, and it replaces the first
  await agent.closed;
  await gameUp(port);
  await game.closed;
  assert.deepEqual(types(), ['connected', 'connected']); // a replaced game connection is no crash
  assert.deepEqual(notices(), []);
});

test("an Agent's game connection never passes on cmdLate, quest or achievement, which only a Mod sends", async (t) => {
  const { hub, port, events, types } = await setup(t, { hub: { lateMs: 60_000 } });
  await agentUp(port);
  const game = await gameUp(port);
  const late: string[][] = [];
  const result = hub.runCommand('space', '/players', 'test', (lines) => late.push(lines));
  const cmd = (await game.next()) as { id: string };
  game.send({ type: 'cmdResult', id: cmd.id, output: ['Ann'] });
  assert.deepEqual(await result, ['Ann']);
  for (let i = 0; i < 3; i++) game.send({ type: 'cmdLate', id: cmd.id, output: ['late output'] });
  game.send({ type: 'quest', player: 'Ann', quests: [{ name: 'Stone Age', main: true }] });
  game.send({ type: 'achievement', player: 'Ann', achievement: 'Getting Wood' });
  game.send({ type: 'started' });
  game.send({ type: 'started' }); // one per connection
  game.send({ type: 'chat', player: 'Ann', message: 'after' });
  await until(() => types().includes('chat'));
  assert.deepEqual(late, []);
  assert.deepEqual(types(), ['connected', 'console', 'started', 'chat']);
  assert.equal(events.filter((e) => e.type === 'console' && e.late).length, 0);
});

test("an Agent's Host watches the first 32 mounts its samples name, by its own limits, each one's change told at most once per 10 min", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { hosts, targets } = await setup(t);
  const vm = hosts.get('vm')!;
  const GB = 1024 ** 3;
  const told = () => targets.flatMap((e) => (e.type === 'notice' ? [`${e.kind} ${'mount' in e ? e.mount : ''}`] : []));
  const disks = (free: number, n = 32) => Array.from({ length: n }, (_, i) => ({ mount: `/m${i}`, free, total: 100 * GB }));
  const record = (free: number, n?: number) => vm.record({ ...SAMPLE, ts: Date.now(), disks: disks(free, n) });
  record(10 * GB); // at its diskMinFreeGB (10, from agents[].host): not low
  record(9.9 * GB, 40); // eight more names than it watches
  assert.equal(told().length, 32);
  assert.ok(told().every((n, i) => n === `diskLow /m${i}`));
  assert.deepEqual(targets.find((e) => e.type === 'notice'), { target: 'host', id: 'vm', type: 'notice', severity: 'warning', kind: 'diskLow', mount: '/m0', free: 9.9 * GB, minFreeGB: 10 });
  record(0, 40);
  for (let minute = 1; minute < 10; minute++) {
    t.mock.timers.tick(60_000);
    record(minute % 2 ? 50 * GB : 0); // flapping: each change waits out the 10 min
  }
  assert.equal(told().length, 32);
  t.mock.timers.tick(60_000); // 10 min on, and ok since the last sample: told now, once per mount
  record(50 * GB, 40);
  assert.equal(told().length, 64);
  assert.ok(told().slice(32).every((n, i) => n === `diskOk /m${i}`));
  t.mock.timers.tick(10_000);
  record(0); // low again 10 s on: waits
  t.mock.timers.tick(10 * 60_000);
  record(50 * GB); // and ok again before it was told: nothing to tell
  assert.equal(told().length, 64);
});

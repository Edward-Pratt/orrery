import assert from 'node:assert/strict';
import { Server, Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Agents, type AgentsOptions } from '../src/agents.ts';
import { Db } from '../src/db.ts';
import { Hosts } from '../src/host.ts';
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
 * address is `address` (default the tests' own, 127.0.0.1); the Agent port on an ephemeral port.
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
  const agents = new Agents(hub, hosts, { listen: { host: '127.0.0.1', port: 0 }, agents: [{ ...VM, address }] }, { silenceMs: 5_000, ...agentOpts });
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
  return { hub, agents, hosts, port, events, targets, notices, types: () => events.map((e) => e.type) };
}

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
  assert.equal(agents.get('vm')?.connected, false);
  assert.equal(errors.mock.calls.filter((c) => /a line over 1048576 bytes, closing/.test(String(c.arguments[0]))).length, 2);

  await agentUp(port); // still listening, and handshakes as before
  assert.equal(agents.get('vm')?.connected, true);
});

test('a chat flood is cut to the rate, then closes its connection; the hub stays up', async (t) => {
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
  assert.ok(chats >= 200 && chats <= 200 + 50 * seconds + 5, `${chats} chat lines in ${seconds} s`);
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
  agent.send({ type: 'hostSample', sample: { ...SAMPLE, memory: { ...SAMPLE.memory, swap: 7 }, disks: [{ ...SAMPLE.disks[0], device: 'sda' }], extra: 1 }, more: 2 });
  await until(() => pushed.length === 2 && hosts.get('vm')!.latest() !== null);
  assert.deepEqual(pushed, [
    ['vm', { type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since: 5, result: 'success' }],
    ['vm', { type: 'saves', saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'auto', current: false }], free: 9 }],
  ]);
  assert.equal(Object.getPrototypeOf((pushed[0] as unknown[])[1]), Object.prototype);
  assert.deepEqual(hosts.get('vm')!.latest(), SAMPLE);

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
  assert.deepEqual(types(), ['connected', 'hung']); // no tps event while paused
  game.send({ type: 'heartbeat', tps: 59.5, players: ['Ann'], paused: false });
  await until(() => types().includes('recovered'));
  assert.deepEqual(hub.get('space'), { id: 'space', name: 'Space Age', game: 'factorio', online: true, hung: false, paused: false, tps: 59.5, players: ['Ann'], dims: [] });
  assert.deepEqual(types(), ['connected', 'hung', 'tps', 'recovered']);
});

test("each Agent's host samples go to its own Host's monitor", async (t) => {
  const { hosts, port } = await setup(t);
  const own = hosts.add({ id: 'oracle', mounts: ['/'], ...LIMITS_VM });
  const agent = await agentUp(port);
  const ts = Date.now();
  agent.send({ type: 'hostSample', sample: { ...SAMPLE, ts: ts - 60_000 } });
  agent.send({ type: 'hostSample', sample: { ...SAMPLE, ts } });
  await until(() => hosts.get('vm')!.latest()?.ts === ts);
  assert.equal(own.latest(), null);
  assert.deepEqual(hosts.get('vm')!.history(1).map((s) => s.ts), [ts - 60_000, ts]);
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

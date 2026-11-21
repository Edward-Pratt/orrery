// `Agents` itself (`agents.ts`): the handshake and its refusals, binding the Agent port while its address isn't on
// this machine, an Agent lost (bye, silence, a close) and its game connection, broadcast, and a connection welcomed
// again too soon. The sockets are `agents-listener.test.ts`, the budgets `agents-budgets.test.ts`, what lines do
// `agents-dispatch.test.ts`, an Agent's Host `agents-hosts.test.ts`; the shared setup is `agent-port.ts`.

import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { test } from 'node:test';
import { Agents } from '../../src/agents/agents.ts';
import { Db } from '../../src/stats/db.ts';
import { Hosts } from '../../src/agents/host.ts';
import { ServerHub } from '../../src/servers/servers.ts';
import { fakeMod, online, sleep, TOKEN, until } from '../fake-mod.ts';
import { AGENT_TOKEN, agentHello, agentUp, gameHello, gameUp, setup, VM } from './agent-port.ts';

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
  assert.deepEqual(agents.list(), [{ id: 'vm', name: 'Factorio VM', server: 'space', connected: true, version: 'agent-v1.0.0', node: null }]);
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

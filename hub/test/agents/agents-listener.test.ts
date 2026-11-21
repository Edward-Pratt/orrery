// The Agent port's sockets (`listener.ts`): a connection from another address, or a fifth at once from one, is
// destroyed with zero bytes read; a line over the cap closes its connection; a line whose handling throws ends only its
// own; a refused connection is destroyed within 2 s whatever its peer does.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { LIMITS } from '../../src/protocol.ts';
import { fakeMod } from '../fake-mod.ts';
import { AGENT_TOKEN, agentHello, agentUp, gameHello, hubSides, setup, waitFor } from './agent-port.ts';

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

// A game connection's handshake, open and close (`connections.ts`): the hello's checks, a stop or a crash, a reconnect,
// and closing the hub.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerHub } from '../../src/servers/servers.ts';
import { fakeMod, hello, online, sleep, TOKEN, until } from '../fake-mod.ts';
import { setup } from './server-hub.ts';

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

test('a reconnect replaces the old connection without a crash alert', async (t) => {
  const { hub, port, types } = await setup(t);
  const first = await online(port);
  await online(port);
  await first.closed;
  await sleep(50);
  assert.deepEqual(types(), ['connected', 'connected']);
  assert.equal(hub.get('gtnh')?.online, true);
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

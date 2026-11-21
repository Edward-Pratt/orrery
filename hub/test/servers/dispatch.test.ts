// What a game connection's messages do and hung detection over their heartbeats (`dispatch.ts`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { online, sleep, until } from '../fake-mod.ts';
import { setup } from './server-hub.ts';

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

test('a mod cannot claim another serverId in its messages', async (t) => {
  const { port, events } = await setup(t);
  const mod = await online(port);
  mod.send({ type: 'chat', player: 'Steve', message: 'hi', serverId: 'other' });
  await until(() => events.length === 2);
  assert.equal(events[1].serverId, 'gtnh');
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

// `ServerHub`'s public API (`servers.ts`): `say`, the grace period `start` runs, `sendLinkResult`, `publish` and
// `announce`, and the text cleaning `say` uses (`server-text.ts`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcText, ServerHub, truncate, type HubEvent } from '../../src/servers/servers.ts';
import { online, sleep, TOKEN } from '../fake-mod.ts';
import { setup } from './server-hub.ts';

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

test('say sends its source to the mod and puts the line on the event stream', async (t) => {
  const { hub, port, events } = await setup(t);
  const mod = await online(port);
  assert.equal(hub.say('gtnh', 'alex', 'hi', 'dashboard'), true);
  assert.deepEqual(await mod.next(), { type: 'say', author: 'alex', message: 'hi', source: 'dashboard' });
  assert.deepEqual(events.at(-1), {
    serverId: 'gtnh',
    type: 'say',
    author: 'alex',
    message: 'hi',
    source: 'dashboard',
  });
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

test('sendLinkResult reaches the mod', async (t) => {
  const { hub, port } = await setup(t);
  assert.equal(hub.sendLinkResult('gtnh', 'Steve', true, 'Linked'), false); // offline
  const mod = await online(port);
  assert.equal(hub.sendLinkResult('gtnh', 'Steve', true, 'Linked'), true);
  assert.deepEqual(await mod.next(), { type: 'linkResult', player: 'Steve', ok: true, message: 'Linked' });
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

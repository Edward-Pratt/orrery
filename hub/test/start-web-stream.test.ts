// A web + Minecraft hub's event stream (`/api/events`, on `liveHub`): chat, commands and lifecycle changes, the replay
// and `Last-Event-ID`, the replay buffer of 500 events per server, heartbeats' TPS, a session needed and no listener
// left on a closed stream; a check's notice keyed apart from servers.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ServerHub } from '../src/servers/servers.ts';
import { startHub } from '../src/start.ts';
import { online, until } from './fake-mod.ts';
import { config, loginCookie, WEB } from './web/web-hub.ts';
import { MINECRAFT, DISCORD, type Sse, openStream } from './start-hub.ts';

/** A web + Minecraft hub with a logged-in owner: its API, session cookie, hub and mod port. */
async function liveHub(t: TestContext) {
  let hub: ServerHub | undefined;
  const handle = await startHub(config(t, { minecraft: MINECRAFT, discord: DISCORD, web: WEB }), {
    startFrontend: async (h) => {
      hub = h;
      return { stop: () => {} };
    },
    get: async () => ({ ok: true, status: 200 }),
  });
  t.after(() => handle.close());
  const app = handle.web!.app;
  return { app, cookie: await loginCookie(handle.web!), hub: hub!, live: handle.live, port: handle.port! };
}

test('chat, commands and lifecycle changes reach an open event stream', async (t) => {
  const { app, cookie, hub, port } = await liveHub(t);
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  const mod = await online(port);
  mod.send({ type: 'chat', player: 'Steve', message: 'hi' });
  await until(() => stream.events.length === 2);
  hub.say('gtnh', 'alex', 'hello back', 'discord');
  const result = hub.runCommand('gtnh', 'list', 'web:alex (5)');
  assert.deepEqual(await mod.next(), { type: 'say', author: 'alex', message: 'hello back', source: 'discord' });
  const run = (await mod.next()) as { id: string };
  mod.send({ type: 'cmdResult', id: run.id, output: ['There are 0 players'] });
  await result;
  mod.send({ type: 'cmdLate', id: run.id, output: ['later'] });
  await until(() => stream.events.length >= 5);
  assert.deepEqual(
    stream.events.map((e) => e.data),
    [
      { serverId: 'gtnh', type: 'connected' },
      { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' },
      { serverId: 'gtnh', type: 'say', author: 'alex', message: 'hello back', source: 'discord' },
      { serverId: 'gtnh', type: 'console', command: 'list', by: 'web:alex (5)', output: ['There are 0 players'] },
      { serverId: 'gtnh', type: 'console', command: 'list', by: 'web:alex (5)', output: ['later'], late: true },
    ],
  );
  const ids = stream.events.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
  for (const e of stream.events) assert.ok(Number.isInteger(e.at) && Math.abs(e.at - Date.now()) < 60_000, JSON.stringify(e));

  // A replay and a resume carry the time each event had live.
  const times = (events: Sse[]) => events.map((e) => [e.id, e.at]);
  const replay = await openStream(app, cookie);
  await until(() => replay.events.length === 5);
  await replay.close();
  assert.deepEqual(times(replay.events), times(stream.events));
  const resumed = await openStream(app, cookie, ids[1]);
  await until(() => resumed.events.length === 3);
  await resumed.close();
  assert.deepEqual(times(resumed.events), times(stream.events.slice(2)));
});

test('a new stream replays recent events first, and Last-Event-ID resumes after that id', async (t) => {
  const { app, cookie, port } = await liveHub(t);
  const mod = await online(port);
  for (const message of ['one', 'two', 'three']) mod.send({ type: 'chat', player: 'Steve', message });
  const first = await openStream(app, cookie);
  await until(() => first.events.length === 4);
  await first.close();
  const chats = first.events.filter((e) => e.data.type === 'chat');
  assert.deepEqual(chats.map((e) => (e.data as { message: string }).message), ['one', 'two', 'three']);

  mod.send({ type: 'chat', player: 'Steve', message: 'four' });
  const resumed = await openStream(app, cookie, chats[1]!.id);
  t.after(() => resumed.close());
  await until(() => resumed.events.length === 2);
  assert.deepEqual(resumed.events.map((e) => (e.data as { message: string }).message), ['three', 'four']);
});

test('the replay buffer keeps the last 500 events per server', async (t) => {
  const { app, cookie, port } = await liveHub(t);
  const mod = await online(port);
  for (let i = 1; i <= 510; i++) mod.send({ type: 'chat', player: 'Steve', message: String(i) });
  const probe = await openStream(app, cookie);
  await until(() => probe.events.some((e) => (e.data as { message?: string }).message === '510'));
  await probe.close();
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  await until(() => stream.events.length === 500);
  assert.equal((stream.events[0]!.data as { message: string }).message, '11');
});

test('heartbeats put TPS on the stream, and an hour of them evicts no chat and replays only the latest', async (t) => {
  const { app, cookie, port } = await liveHub(t);
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  const mod = await online(port);
  mod.send({ type: 'chat', player: 'Steve', message: 'before' });
  mod.send({ type: 'heartbeat', tps: 19.5, players: ['Steve'] });
  mod.send({ type: 'heartbeat', tps: 19.52, players: ['Steve'] }); // not a noticeable change
  mod.send({ type: 'heartbeat', tps: 12, players: ['Steve'] });
  await until(() => stream.events.filter((e) => e.data.type === 'tps').length === 2);
  assert.deepEqual(
    stream.events.filter((e) => e.data.type === 'tps').map((e) => e.data),
    [
      { serverId: 'gtnh', type: 'tps', tps: 19.5 },
      { serverId: 'gtnh', type: 'tps', tps: 12 },
    ],
  );

  for (let i = 0; i < 720; i++) mod.send({ type: 'heartbeat', tps: 10 + (i % 100) / 10, players: [] }); // 5 s apart
  mod.send({ type: 'heartbeat', tps: 18, players: [] });
  await until(() => (stream.events.at(-1)!.data as { tps?: number }).tps === 18);
  const replay = await openStream(app, cookie);
  t.after(() => replay.close());
  await until(() => replay.events.length === 3);
  assert.deepEqual(
    replay.events.map((e) => e.data),
    [
      { serverId: 'gtnh', type: 'connected' },
      { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'before' },
      { serverId: 'gtnh', type: 'tps', tps: 18 },
    ],
  );
});

test('the event stream needs a session, and a closed stream leaves no listener on the hub', async (t) => {
  const { app, cookie, live } = await liveHub(t);
  assert.equal((await app.request('/api/events')).status, 401);
  const stream = await openStream(app, cookie);
  assert.equal(live.listenerCount('event'), 1);
  await stream.close();
  await until(() => live.listenerCount('event') === 0);
});

test('a notice about a check reaches the stream, its replay and a resume, keyed apart from servers', async (t) => {
  const { app, cookie, hub } = await liveHub(t);
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  const down = (n: number) => ({ severity: 'problem', kind: 'checkDown', url: `https://site.example/${n}`, error: 'HTTP 503' }) as const;
  // Named like the server: a check's events are its own, never the server's.
  for (const n of [1, 2, 3]) hub.publishTarget({ target: 'check', id: 'gtnh', type: 'notice', ...down(n) });
  await until(() => stream.events.length === 3);
  assert.deepEqual(stream.events[0]!.data, { target: 'check', id: 'gtnh', type: 'notice', ...down(1) });

  const replay = await openStream(app, cookie);
  t.after(() => replay.close());
  await until(() => replay.events.length === 3);
  assert.deepEqual(replay.events, stream.events);
  const resumed = await openStream(app, cookie, stream.events[1]!.id);
  t.after(() => resumed.close());
  await until(() => resumed.events.length === 1);
  assert.deepEqual(resumed.events, [stream.events[2]]);
});

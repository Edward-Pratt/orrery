import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Db } from '../src/db.ts';
import { LiveFeed } from '../src/live.ts';
import { ServerHub } from '../src/servers.ts';
import type { HubEvent } from '../src/types.ts';

/** A hub that never listens: events are emitted by hand. A "restart" is a new hub and feed on the same `Db`. */
const hubOf = (...ids: string[]) => new ServerHub(ids.map((id) => ({ id, name: id })));
const unstamped = (entries: [number, { at: number }][]) => entries.map(([, { at: _, ...e }]) => e);

const history: HubEvent[] = [
  { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' },
  { serverId: 'gtnh', type: 'join', player: 'Alex' },
  { serverId: 'gtnh', type: 'say', author: 'ed', message: 'hello', source: 'web', avatar: 'https://cdn/a.png' },
  { serverId: 'gtnh', type: 'console', command: 'list', by: 'web:ed', output: ['There are 2 players'] },
  { serverId: 'gtnh', type: 'console', command: 'list', by: 'web:ed', output: ['later'], late: true },
  { serverId: 'gtnh', type: 'death', player: 'Alex', message: 'Alex fell' },
  { serverId: 'gtnh', type: 'leave', player: 'Alex' },
];

test('chat and console survive a restart with their ids and times', () => {
  const db = new Db(':memory:');
  const hub = hubOf('gtnh');
  const live = new LiveFeed(hub, db);
  for (const e of history) hub.emit('event', e);
  const sent = live.since();

  const after = new LiveFeed(hubOf('gtnh'), db);
  assert.deepEqual(after.since(0), sent);
  assert.deepEqual(unstamped(after.since(0)), history);
});

test('after a restart new ids are above every stored one, even ahead of the clock', () => {
  const db = new Db(':memory:');
  const ahead = Date.now() + 1e9;
  db.recordFeed(ahead, { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'from the future', at: 1 });
  db.recordFeed(ahead + 5, { serverId: 'gone', type: 'chat', player: 'Steve', message: 'removed server', at: 1 });
  const hub = hubOf('gtnh');
  const live = new LiveFeed(hub, db);
  assert.equal(live.lastId, ahead + 5);
  hub.emit('event', { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'now' });
  const ids = live.since().map(([id]) => id);
  assert.deepEqual(ids, [ahead, ahead + 6]);
  // A server removed from the config keeps no buffer.
  assert.ok(live.since().every(([, e]) => 'serverId' in e && e.serverId === 'gtnh'));
});

test('a Last-Event-ID from before a restart resumes after it, without duplicates', () => {
  const db = new Db(':memory:');
  const hub = hubOf('gtnh');
  const live = new LiveFeed(hub, db);
  for (const e of history) hub.emit('event', e);
  const ids = live.since().map(([id]) => id);

  const restarted = hubOf('gtnh');
  const after = new LiveFeed(restarted, db);
  restarted.emit('event', { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'after the restart' });
  const resumed = after.since(ids[2]);
  assert.deepEqual(resumed.slice(0, -1).map(([id]) => id), ids.slice(3));
  assert.deepEqual(unstamped(resumed), [...history.slice(3), { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'after the restart' }]);
  assert.ok(resumed.at(-1)![0] > ids.at(-1)!);
});

test('notices, TPS and lifecycle events are not stored', () => {
  const db = new Db(':memory:');
  const hub = hubOf('gtnh');
  const live = new LiveFeed(hub, db);
  hub.emit('event', { serverId: 'gtnh', type: 'connected' });
  hub.emit('event', { serverId: 'gtnh', type: 'tps', tps: 19.5 });
  hub.publish('gtnh', { severity: 'info', kind: 'restartNow' });
  hub.emit('event', { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' });
  assert.equal(live.since().length, 4);
  assert.deepEqual(unstamped(db.feed('gtnh')), [{ serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' }]);
  assert.deepEqual(unstamped(new LiveFeed(hubOf('gtnh'), db).since()), [{ serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' }]);
});

test('maintain keeps the newest 500 stored feed events of each server', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new Db(':memory:');
  for (let i = 1; i <= 600; i++) db.recordFeed(i * 2, { serverId: 'gtnh', type: 'chat', player: 'Steve', message: `${i}`, at: i });
  for (let i = 1; i <= 3; i++) db.recordFeed(i * 2 + 1, { serverId: 'other', type: 'join', player: 'Alex', at: i });

  db.maintain(dir);

  const kept = db.feed('gtnh', 1000).map(([id]) => id);
  assert.equal(kept.length, 500);
  assert.deepEqual([kept[0], kept.at(-1)], [202, 1200]);
  assert.deepEqual(db.feed('other', 1000).map(([id]) => id), [3, 5, 7]);
});

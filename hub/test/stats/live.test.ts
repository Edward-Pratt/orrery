import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Db } from '../../src/stats/db.ts';
import { FEED_CAP, FEED_CAP_EVERY } from '../../src/stats/feed-store.ts';
import { IDS_RESERVED, LiveFeed } from '../../src/stats/live.ts';
import { ServerHub } from '../../src/servers/servers.ts';
import type { HubEvent } from '../../src/types.ts';

/** A hub that never listens: events are emitted by hand. A "restart" is a new hub and feed on the same `Db`. */
const hubOf = (...ids: string[]) => new ServerHub(ids.map((id) => ({ id, name: id, game: 'minecraft' as const })));
const unstamped = (entries: [number, { at: number }][]) => entries.map(([, { at: _, ...e }]) => e);

const history: HubEvent[] = [
  { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' },
  { serverId: 'gtnh', type: 'join', player: 'Alex' },
  { serverId: 'gtnh', type: 'say', author: 'ed', message: 'hello', source: 'dashboard' },
  { serverId: 'gtnh', type: 'console', command: 'list', by: 'web:ed', output: ['There are 2 players'] },
  { serverId: 'gtnh', type: 'console', command: 'list', by: 'web:ed', output: ['later'], late: true },
  { serverId: 'gtnh', type: 'death', player: 'Alex', message: 'Alex fell' },
  { serverId: 'gtnh', type: 'milestone', kind: 'landing', text: 'Vulcanus', player: 'Alex', force: 'blue' },
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
  db.feed.record(ahead, { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'from the future', at: 1 });
  db.feed.record(ahead + 5, { serverId: 'gone', type: 'chat', player: 'Steve', message: 'removed server', at: 1 });
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

const afterRestart: HubEvent = { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'after the restart' };

test("a Last-Event-ID of an unstored event whose id ran ahead of the clock misses nothing after a restart", (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const db = new Db(':memory:');
  const hub = hubOf('gtnh');
  const live = new LiveFeed(hub, db);
  // 3000 events within a millisecond: ids run 3 s ahead of the clock, and none of them is stored (TPS).
  for (let i = 0; i < 3000; i++) hub.emit('event', { serverId: 'gtnh', type: 'tps', tps: 20 - (i % 2) });
  const seen = live.lastId; // what a dashboard following the stream sends as Last-Event-ID
  assert.ok(seen > Date.now());
  assert.equal(db.feed.maxId(), 0);

  const restarted = hubOf('gtnh');
  const after = new LiveFeed(restarted, db);
  restarted.emit('event', afterRestart);
  assert.deepEqual(unstamped(after.since(seen)), [afterRestart]);
});

test('a clock that stepped back across a restart: a Last-Event-ID of an unstored event still misses nothing', (t) => {
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const db = new Db(':memory:');
  const hub = hubOf('gtnh');
  const live = new LiveFeed(hub, db);
  hub.emit('event', { serverId: 'gtnh', type: 'tps', tps: 19.5 });
  const seen = live.lastId;

  t.mock.timers.setTime(start - 3_600_000);
  const restarted = hubOf('gtnh');
  const after = new LiveFeed(restarted, db);
  restarted.emit('event', afterRestart);
  assert.deepEqual(unstamped(after.since(seen)), [afterRestart]);
});

test("a feed that sent nothing: its lastId (a history's asOf) is below every id after a restart, the clock stepped back too", (t) => {
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const db = new Db(':memory:');
  const asOf = new LiveFeed(hubOf('gtnh'), db).lastId;

  t.mock.timers.setTime(start - 3_600_000);
  const restarted = hubOf('gtnh');
  const after = new LiveFeed(restarted, db);
  restarted.emit('event', afterRestart);
  assert.deepEqual(unstamped(after.since(asOf)), [afterRestart]);
});

test('ids are reserved IDS_RESERVED at a time, before they are issued, and a later restart starts at the clock again', (t) => {
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const db = new Db(':memory:');
  const hub = hubOf('gtnh');
  const live = new LiveFeed(hub, db);
  assert.equal(db.feed.reserved(), start + IDS_RESERVED);
  for (let i = 0; i < IDS_RESERVED; i++) hub.emit('event', { serverId: 'gtnh', type: 'tps', tps: 20 - (i % 2) });
  assert.equal(live.lastId, start + IDS_RESERVED - 1);
  assert.equal(db.feed.reserved(), start + IDS_RESERVED); // a whole block issued on one write
  hub.emit('event', { serverId: 'gtnh', type: 'tps', tps: 19 });
  assert.deepEqual([live.lastId, db.feed.reserved()], [start + IDS_RESERVED, start + 2 * IDS_RESERVED]);

  // Restarted at once, ids go on from the reserved one; restarted once the clock has passed it, from the clock.
  assert.equal(new LiveFeed(hubOf('gtnh'), db).lastId, start + 2 * IDS_RESERVED - 1);
  t.mock.timers.setTime(start + 60_000);
  assert.equal(new LiveFeed(hubOf('gtnh'), db).lastId, start + 60_000 - 1);
  assert.equal(db.feed.reserved(), start + 60_000 + IDS_RESERVED);
  db.feed.reserve(5); // never lowered
  assert.equal(db.feed.reserved(), start + 60_000 + IDS_RESERVED);
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
  assert.deepEqual(unstamped(db.feed.newest('gtnh')), [{ serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' }]);
  assert.deepEqual(unstamped(new LiveFeed(hubOf('gtnh'), db).since()), [{ serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' }]);
});

test('maintain keeps the newest 500 stored feed events of each server', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new Db(':memory:');
  for (let i = 1; i <= 600; i++) db.feed.record(i * 2, { serverId: 'gtnh', type: 'chat', player: 'Steve', message: `${i}`, at: i });
  for (let i = 1; i <= 3; i++) db.feed.record(i * 2 + 1, { serverId: 'other', type: 'join', player: 'Alex', at: i });

  db.maintain(dir);

  const kept = db.feed.newest('gtnh', 1000).map(([id]) => id);
  assert.equal(kept.length, 500);
  assert.deepEqual([kept[0], kept.at(-1)], [202, 1200]);
  assert.deepEqual(db.feed.newest('other', 1000).map(([id]) => id), [3, 5, 7]);
});

test("a server's stored feed is capped as it is written: past FEED_CAP, its oldest rows go every FEED_CAP_EVERY inserts", () => {
  const db = new Db(':memory:');
  const total = FEED_CAP + 2 * FEED_CAP_EVERY + 50;
  for (let i = 1; i <= total; i++) db.feed.record(i * 2, { serverId: 'space', type: 'chat', player: 'Ann', message: `${i}`, at: i });
  db.feed.record(1, { serverId: 'gtnh', type: 'join', player: 'Steve', at: 1 });
  const kept = db.feed.newest('space', 2 * FEED_CAP).map(([id]) => id);
  // Checked at each 100th insert: the last check left the newest FEED_CAP, and 50 came after it.
  assert.equal(kept.length, FEED_CAP + 50);
  assert.deepEqual([kept[0], kept.at(-1)], [(2 * FEED_CAP_EVERY + 1) * 2, total * 2]);
  assert.deepEqual(db.feed.newest('gtnh').map(([id]) => id), [1]); // another server's rows are its own
  assert.equal(db.feed.maxId(), total * 2);
});

test("a server's latest TPS is dropped when it stops, crashes or its Agent leaves", () => {
  const db = new Db(':memory:');
  const hub = hubOf('a', 'b', 'c');
  const live = new LiveFeed(hub, db);
  for (const [serverId, down] of [['a', 'stopped'], ['b', 'crashed'], ['c', 'lost']] as const) {
    hub.emit('event', { serverId, type: 'tps', tps: 50 });
    hub.emit('event', { serverId, type: down });
  }
  assert.deepEqual(unstamped(live.since()), [
    { serverId: 'a', type: 'stopped' },
    { serverId: 'b', type: 'crashed' },
    { serverId: 'c', type: 'lost' },
  ]);
  db.close();
});

test("a server's paused changes: only the latest is replayed, beside its TPS, and none after it stops, crashes or its Agent leaves", () => {
  const db = new Db(':memory:');
  const hub = hubOf('space', 'a', 'b', 'c');
  const live = new LiveFeed(hub, db);
  hub.emit('event', { serverId: 'space', type: 'tps', tps: 60 });
  for (let i = 0; i < 1000; i++) hub.emit('event', { serverId: 'space', type: 'paused', paused: i % 2 === 0 }); // no chat pushed out
  hub.emit('event', { serverId: 'space', type: 'chat', player: 'Ann', message: 'hi' });
  assert.deepEqual(unstamped(live.since()), [
    { serverId: 'space', type: 'tps', tps: 60 },
    { serverId: 'space', type: 'paused', paused: false },
    { serverId: 'space', type: 'chat', player: 'Ann', message: 'hi' },
  ]);
  assert.deepEqual(unstamped(db.feed.newest('space')), [{ serverId: 'space', type: 'chat', player: 'Ann', message: 'hi' }]);
  for (const [serverId, down] of [['a', 'stopped'], ['b', 'crashed'], ['c', 'lost']] as const) {
    hub.emit('event', { serverId, type: 'paused', paused: true });
    hub.emit('event', { serverId, type: down });
  }
  assert.deepEqual(unstamped(live.since()).slice(3), [
    { serverId: 'a', type: 'stopped' },
    { serverId: 'b', type: 'crashed' },
    { serverId: 'c', type: 'lost' },
  ]);
  db.close();
});

test('20 open dashboard streams, one listener each, raise no MaxListenersExceededWarning', async (t) => {
  const warnings: Error[] = [];
  const onWarning = (w: Error) => void (w.name === 'MaxListenersExceededWarning' && warnings.push(w));
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  const db = new Db(':memory:');
  const live = new LiveFeed(hubOf('gtnh'), db);
  const listeners = Array.from({ length: 20 }, () => () => {});
  for (const fn of listeners) live.on('event', fn);
  await new Promise((r) => setImmediate(r)); // the warning is emitted on a later tick
  assert.deepEqual(warnings, []);
  assert.equal(live.listenerCount('event'), 20);
  for (const fn of listeners) live.off('event', fn);
  db.close();
});

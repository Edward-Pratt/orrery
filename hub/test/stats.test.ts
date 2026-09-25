import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db } from '../src/db.ts';
import type { ServerHub, ServerState } from '../src/servers.ts';
import { Stats } from '../src/stats.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 100 * DAY;

const gtnh: ServerState = { id: 'gtnh', name: 'GTNH', online: true, hung: false, tps: 19.5, players: ['Steve'], dims: [] };

function setup() {
  const db = new Db(':memory:');
  const hub = { get: (id: string) => (id === 'gtnh' ? gtnh : undefined) } as unknown as Pick<ServerHub, 'get'>;
  return { db, stats: new Stats(hub, db) };
}

test('status gives the live state and 24 h / 7 d uptime', () => {
  const { db, stats } = setup();
  db.record('gtnh', 'up', 'started', NOW - 8 * DAY); // before both windows: counts from each window's start
  db.record('gtnh', 'down', 'crashed', NOW - 2 * DAY);
  db.record('gtnh', 'up', 'started', NOW - 12 * HOUR);
  const s = stats.status('gtnh', NOW);
  assert.deepEqual(s?.state, gtnh);
  assert.equal(s?.uptimeDay, 0.5);
  assert.equal(s?.uptimeWeek, (5 * DAY + 12 * HOUR) / (7 * DAY));
});

test('status with no recorded history has unknown uptime, not zero', () => {
  const { stats } = setup();
  const s = stats.status('gtnh', NOW);
  assert.equal(s?.uptimeDay, null);
  assert.equal(s?.uptimeWeek, null);
});

test('tps gives last-hour samples and hour / day averages and minimums', () => {
  const { db, stats } = setup();
  db.recordTps('gtnh', NOW - 2 * HOUR, 5, null, null); // day only
  db.recordTps('gtnh', NOW - HOUR, 10, null, null); // exactly at the hour's start: in the hour
  db.recordTps('gtnh', NOW - MIN, 20, null, null);
  db.recordTps('gtnh', NOW - DAY - MIN, 1, null, null); // outside both windows
  const t = stats.tps('gtnh', NOW);
  assert.deepEqual(t?.state, gtnh);
  assert.deepEqual(t?.lastHour, [
    { ts: NOW - HOUR, tps: 10 },
    { ts: NOW - MIN, tps: 20 },
  ]);
  assert.deepEqual(t?.hour, { avg: 15, min: 10 });
  assert.deepEqual(t?.day, { avg: 35 / 3, min: 5 });
});

test('tps without samples has no averages', () => {
  const { stats } = setup();
  const t = stats.tps('gtnh', NOW);
  assert.deepEqual(t?.lastHour, []);
  assert.equal(t?.hour, null);
  assert.equal(t?.day, null);
});

test('an unknown server is not found, not zeros', () => {
  const { stats } = setup();
  assert.equal(stats.status('nope', NOW), undefined);
  assert.equal(stats.tps('nope', NOW), undefined);
  assert.equal(stats.playtime('nope', { player: 'Steve' }, NOW), undefined);
  assert.equal(stats.top('nope', 'week', NOW), undefined);
});

test('playtime by name gives total, last 7 days and last seen; names match case-insensitively', () => {
  const { db, stats } = setup();
  db.openSession('gtnh', 'Steve', NOW - 10 * DAY);
  db.closeSession('gtnh', 'Steve', NOW - 10 * DAY + 2 * HOUR);
  db.openSession('gtnh', 'Steve', NOW - 7 * DAY - HOUR); // straddles the week's start: only its last hour counts
  db.closeSession('gtnh', 'Steve', NOW - 7 * DAY + HOUR);
  assert.deepEqual(stats.playtime('gtnh', { player: 'steve' }, NOW), {
    found: true,
    player: 'steve',
    totalMs: 4 * HOUR,
    weekMs: HOUR,
    lastSeen: NOW - 7 * DAY + HOUR,
  });
});

test('playtime by Discord user uses the linked name, and says when there is none or no input', () => {
  const { db, stats } = setup();
  db.link('123', 'Steve', 'uuid', NOW);
  db.openSession('gtnh', 'Steve', NOW - HOUR);
  assert.deepEqual(stats.playtime('gtnh', { discordId: '123' }, NOW), {
    found: true,
    player: 'Steve',
    totalMs: HOUR,
    weekMs: HOUR,
    lastSeen: { online: true },
  });
  assert.deepEqual(stats.playtime('gtnh', { discordId: '999' }, NOW), { found: false, reason: 'notLinked' });
  assert.deepEqual(stats.playtime('gtnh', {}, NOW), { found: false, reason: 'noInput' });
  assert.equal(stats.linkedPlayer('123'), 'Steve');
  assert.equal(stats.linkedPlayer('999'), undefined);
});

test('top covers the last 24 hours, the last 7 days or all time', () => {
  const { db, stats } = setup();
  const play = (player: string, start: number, ms: number) => {
    db.openSession('gtnh', player, start);
    db.closeSession('gtnh', player, start + ms);
  };
  play('Old', NOW - 30 * DAY, 10 * HOUR);
  play('Week', NOW - 3 * DAY, 5 * HOUR);
  play('Day', NOW - 2 * HOUR, HOUR);
  assert.deepEqual(stats.top('gtnh', 'day', NOW), [{ player: 'Day', ms: HOUR }]);
  assert.deepEqual(stats.top('gtnh', 'week', NOW), [
    { player: 'Week', ms: 5 * HOUR },
    { player: 'Day', ms: HOUR },
  ]);
  assert.deepEqual(
    stats.top('gtnh', 'all', NOW)?.map((r) => r.player),
    ['Old', 'Week', 'Day'],
  );
});

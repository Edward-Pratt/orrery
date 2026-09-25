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
});

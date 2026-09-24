import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeUptime, Db } from '../src/db.ts';

test('computeUptime splits time between states', () => {
  const rows = [
    { ts: 0, state: 'up' as const },
    { ts: 50, state: 'down' as const },
  ];
  assert.equal(computeUptime(rows, 0, 100), 0.5);
});

test('computeUptime excludes unknown time and clips to the window', () => {
  const rows = [
    { ts: 0, state: 'up' as const },
    { ts: 50, state: 'unknown' as const },
    { ts: 75, state: 'up' as const },
  ];
  assert.equal(computeUptime(rows, 0, 100), 1);
  assert.equal(computeUptime([{ ts: 0, state: 'down' as const }], 10, 20), 0);
});

test('computeUptime is null with no known time', () => {
  assert.equal(computeUptime([], 0, 100), null);
  assert.equal(computeUptime([{ ts: 0, state: 'unknown' as const }], 0, 100), null);
});

test('uptime carries the state from before the window', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 1000);
  db.record('s', 'down', 'crashed', 2000);
  assert.equal(db.uptime('s', 0, 3000), 0.5);
  assert.equal(db.uptime('s', 1500, 3000), 1 / 3);
  assert.equal(db.uptime('other', 0, 3000), null);
  db.close();
});

test('markHubRestart makes hub downtime unknown', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 500);
  db.touch(1000);
  db.markHubRestart(['s'], 5000);
  assert.equal(db.uptime('s', 0, 6000), 1);
  db.close();
});

test('an event after the last touch still counts as hub-alive time', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 500);
  db.touch(1000);
  db.record('s', 'down', 'stopped', 1030); // e.g. machine reboot: hub dies before its next touch
  db.markHubRestart(['s'], 5000);
  assert.equal(db.uptime('s', 1030, 5000), null); // the outage is unknown, not downtime
  db.close();
});

test('record and touch never throw, even when the database is unusable', () => {
  const db = new Db(':memory:');
  db.close();
  assert.doesNotThrow(() => db.record('s', 'up', 'connected', 1000));
  assert.doesNotThrow(() => db.touch(1000));
});

test('playtime counts only the overlap with the window, open sessions until now, names case-insensitively', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'Steve', 1000);
  db.closeSession('s', 'Steve', 5000);
  db.openSession('s', 'Steve', 8000); // still online
  assert.equal(db.playtime('s', 'steve', 0, 10_000, 10_000), 4000 + 2000);
  assert.equal(db.playtime('s', 'Steve', 2000, 4000, 10_000), 2000);
  assert.equal(db.playtime('s', 'Steve', 6000, 7000, 10_000), 0);
  assert.equal(db.playtime('other', 'Steve', 0, 10_000, 10_000), 0);
  db.close();
});

test('lastSeen: online, last session end, or never', () => {
  const db = new Db(':memory:');
  assert.equal(db.lastSeen('s', 'Alex'), null);
  db.openSession('s', 'Alex', 1000);
  assert.deepEqual(db.lastSeen('s', 'alex'), { online: true });
  db.closeSession('s', 'Alex', 3000);
  assert.equal(db.lastSeen('s', 'Alex'), 3000);
  db.close();
});

test('top ranks players by playtime in the window', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'A', 0);
  db.closeSession('s', 'A', 1000);
  db.openSession('s', 'B', 0);
  db.closeSession('s', 'B', 3000);
  db.openSession('s', 'C', 5000);
  db.closeSession('s', 'C', 6000);
  assert.deepEqual(db.top('s', 0, 4000, 10), [
    { player: 'B', ms: 3000 },
    { player: 'A', ms: 1000 },
  ]);
  assert.equal(db.top('s', 0, 10_000, 1).length, 1);
  db.close();
});

test('peaks keep the daily maximum; countEvents counts reasons in a window', () => {
  const db = new Db(':memory:');
  db.recordPeak('s', '2026-09-24', 3);
  db.recordPeak('s', '2026-09-24', 5);
  db.recordPeak('s', '2026-09-24', 2);
  assert.equal(db.peak('s', '2026-09-24'), 5);
  assert.equal(db.peak('s', '2026-09-25'), null);
  db.record('s', 'up', 'started', 100);
  db.record('s', 'down', 'crashed', 200);
  db.record('s', 'up', 'started', 300);
  assert.equal(db.countEvents('s', 'started', 0, 1000), 2);
  assert.equal(db.countEvents('s', 'crashed', 250, 1000), 0);
  db.close();
});

test('markHubRestart ends open sessions at the last stamp, not across the outage', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'Steve', 1000);
  db.touch(2000); // hub last alive
  db.markHubRestart(['s'], 100_000); // hub back much later
  assert.equal(db.lastSeen('s', 'Steve'), 2000);
  assert.equal(db.playtime('s', 'Steve', 0, 100_000, 100_000), 1000);
  db.close();
});

test('session and peak writes never throw either', () => {
  const db = new Db(':memory:');
  db.close();
  assert.doesNotThrow(() => db.openSession('s', 'a', 1));
  assert.doesNotThrow(() => db.closeSession('s', 'a', 2));
  assert.doesNotThrow(() => db.recordPeak('s', '2026-09-24', 1));
});

test('tps samples: since, average and minimum', () => {
  const db = new Db(':memory:');
  db.recordTps('s', 1000, 20, null, null);
  db.recordTps('s', 2000, 10, 'Nether', 90);
  db.recordTps('s', 3000, 15, 'Overworld', 40);
  assert.deepEqual(db.tpsSince('s', 2000), [
    { ts: 2000, tps: 10 },
    { ts: 3000, tps: 15 },
  ]);
  assert.deepEqual(db.tpsStats('s', 0, 3000), { avg: 15, min: 10 });
  assert.equal(db.tpsStats('s', 5000, 6000), null);
  db.close();
});

test('a session opened after the last stamp never ends before it started', () => {
  const db = new Db(':memory:');
  db.touch(1000); // last stamp
  db.openSession('s', 'Steve', 1030); // joined after it, then the hub stopped
  db.markHubRestart(['s'], 100_000);
  assert.equal(db.playtime('s', 'Steve', 0, 100_000, 100_000), 0);
  assert.equal(db.lastSeen('s', 'Steve'), 1030);
  db.close();
});

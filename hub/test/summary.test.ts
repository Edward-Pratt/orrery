import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db } from '../src/db.ts';
import { buildSummary, yesterday } from '../src/summary.ts';

process.env.TZ = 'Europe/London';

const H = 60 * 60_000;

test('yesterday is the previous local day, including a 25-hour DST day', () => {
  const y = yesterday(Date.UTC(2026, 8, 24, 8, 0)); // 09:00 BST on 24 Sep
  assert.equal(y.day, '2026-09-23');
  assert.equal(new Date(y.from).toISOString(), '2026-09-22T23:00:00.000Z');
  assert.equal(y.to - y.from, 24 * H);
  const dst = yesterday(Date.UTC(2026, 9, 26, 9, 0)); // 26 Oct; 25 Oct had the clocks go back
  assert.equal(dst.day, '2026-10-25');
  assert.equal(dst.to - dst.from, 25 * H);
});

test('a summary scheduled for midnight reports the day that just ended', () => {
  const y = yesterday(Date.UTC(2026, 8, 24, 23, 0)); // exactly 00:00 BST on 25 Sep
  assert.equal(y.day, '2026-09-24');
});

test('buildSummary gathers uptime, peak, unique players, playtime, top 3, starts and crashes', () => {
  const db = new Db(':memory:');
  const { from } = yesterday(Date.UTC(2026, 8, 24, 8, 0)); // yesterday = 23 Sep (local)
  db.record('s', 'up', 'started', from);
  db.record('s', 'down', 'crashed', from + 12 * H);
  db.record('s', 'up', 'started', from + 18 * H);
  for (const [p, start, hours] of [['A', 1, 3], ['B', 2, 1], ['C', 3, 2], ['D', 4, 0.5]] as const) {
    db.openSession('s', p, from + start * H);
    db.closeSession('s', p, from + (start + hours) * H);
  }
  db.recordPeak('s', '2026-09-23', 3);
  const s = buildSummary(db, 's', Date.UTC(2026, 8, 24, 8, 0));
  assert.equal(s.day, '2026-09-23');
  assert.equal(s.uptime, 18 / 24);
  assert.equal(s.peak, 3);
  assert.equal(s.unique, 4);
  assert.equal(s.totalMs, 6.5 * H);
  assert.deepEqual(s.top.map((p) => p.player), ['A', 'C', 'B']);
  assert.equal(s.starts, 2);
  assert.equal(s.crashes, 1);
  db.close();
});

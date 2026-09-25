import assert from 'node:assert/strict';
import { test } from 'node:test';
import { yesterday } from '../src/summary.ts';

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

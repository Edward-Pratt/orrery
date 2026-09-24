import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes, formatDuration, localDay } from '../src/units.ts';

test('formatDuration shows the two largest units', () => {
  assert.equal(formatDuration(0), '0 s');
  assert.equal(formatDuration(45_000), '45 s');
  assert.equal(formatDuration(192_000), '3 m 12 s');
  assert.equal(formatDuration(5 * 3600_000 + 12 * 60_000 + 30_000), '5 h 12 m');
  assert.equal(formatDuration(2 * 3600_000), '2 h');
  assert.equal(formatDuration(3 * 86_400_000 + 4 * 3600_000), '3 d 4 h');
});

test('formatBytes uses 1024-based units', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(3.2 * 1024 ** 3), '3.2 GB');
});

test('localDay uses the local calendar, not UTC', () => {
  process.env.TZ = 'Europe/London';
  assert.equal(localDay(Date.UTC(2026, 8, 24, 23, 30)), '2026-09-25'); // 00:30 BST
});

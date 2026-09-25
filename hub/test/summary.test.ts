import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerHub } from '../src/servers.ts';
import type { Stats } from '../src/stats.ts';
import { scheduleSummaries, yesterday, type Summary } from '../src/summary.ts';

process.env.TZ = 'Europe/London';

const MIN = 60_000;
const H = 60 * MIN;
const flush = () => new Promise((r) => setImmediate(r)); // setImmediate isn't mocked: lets the async answer settle

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

test('scheduleSummaries announces the Stats answer at each server\'s daily time, until cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 8, 24, 7, 0) }); // 08:00 BST
  const answer: Summary = { day: '2026-09-23', uptime: 1, peak: 3, unique: 2, totalMs: H, top: [], starts: 1, crashes: 0 };
  const asked: [string, string][] = [];
  const stats = {
    summary: async (serverId: string, at: number) => (asked.push([serverId, new Date(at).toISOString()]), answer),
  } as unknown as Pick<Stats, 'summary'>;
  const events: unknown[] = [];
  const hub = { announce: (serverId: string, a: object) => events.push({ ...a, serverId }) } as unknown as Pick<ServerHub, 'announce'>;
  const cancel = scheduleSummaries(hub, stats, [
    { id: 'gtnh', name: 'GTNH', dailySummary: '09:00' },
    { id: 'quiet', name: 'Quiet' }, // no dailySummary: never asked
  ]);
  t.mock.timers.tick(60 * MIN);
  await flush();
  assert.deepEqual(asked, [['gtnh', '2026-09-24T08:00:00.000Z']]);
  assert.deepEqual(events, [{ type: 'summary', name: 'GTNH', summary: answer, serverId: 'gtnh' }]);
  cancel();
  t.mock.timers.tick(24 * 60 * MIN);
  await flush();
  assert.equal(events.length, 1);
});

test('scheduleSummaries rejects a bad time', () => {
  const none = {} as never;
  assert.throws(() => scheduleSummaries(none, none, [{ id: 'gtnh', name: 'GTNH', dailySummary: '9am' }]), /HH:MM/);
});

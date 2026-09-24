import assert from 'node:assert/strict';
import { test } from 'node:test';
import { everyDay, nextDaily, parseDaily } from '../src/daily.ts';

process.env.TZ = 'Europe/London'; // local-time assertions are in UK time, across DST changes

const MIN = 60_000;

test('parseDaily accepts only 24-hour HH:MM', () => {
  assert.deepEqual(parseDaily('06:00'), { h: 6, m: 0 });
  assert.deepEqual(parseDaily('23:59'), { h: 23, m: 59 });
  for (const bad of ['6:00', '24:00', '06:60', '6am', '']) assert.equal(parseDaily(bad), null, bad);
});

test('nextDaily follows the local clock across the October DST change', () => {
  // 24 Oct 2026 06:00 BST (05:00 UTC). Clocks go back at 02:00 on 25 Oct.
  const now = Date.UTC(2026, 9, 24, 5, 0);
  const next = nextDaily({ h: 6, m: 0 }, 10 * MIN, now);
  assert.equal(new Date(next).toISOString(), '2026-10-25T05:50:00.000Z'); // 05:50 GMT, 25 h later
});

test('nextDaily re-applies the time after a spring-forward gap', () => {
  // 28 Mar 2027: UK clocks skip 01:00–02:00, so 01:30 that day becomes 02:30 BST. The next day must be 01:30 again.
  const after = Date.UTC(2027, 2, 28, 1, 21); // 02:21 BST, just after that day's 02:20 countdown
  assert.equal(new Date(nextDaily({ h: 1, m: 30 }, 10 * MIN, after)).toISOString(), '2027-03-29T00:20:00.000Z'); // 01:20 BST
});

test('everyDay passes the scheduled target, fires daily, and can be cancelled', (t) => {
  // 24 Sep 2026 08:00 BST (07:00 UTC).
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 8, 24, 7, 0) });
  const fired: string[] = [];
  const cancel = everyDay('09:00', 0, (target) => fired.push(new Date(target).toISOString()));
  t.mock.timers.tick(60 * MIN);
  assert.deepEqual(fired, ['2026-09-24T08:00:00.000Z']);
  t.mock.timers.tick(24 * 60 * MIN);
  assert.deepEqual(fired, ['2026-09-24T08:00:00.000Z', '2026-09-25T08:00:00.000Z']);
  cancel();
  t.mock.timers.tick(48 * 60 * MIN);
  assert.equal(fired.length, 2);
});

test('everyDay does not fire twice when a timer fires a millisecond early', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 8, 24, 7, 0) });
  const clock = Date.now.bind(Date);
  let skew = 0;
  t.mock.method(Date, 'now', () => clock() + skew);
  let fired = 0;
  const cancel = everyDay('09:00', 0, () => fired++);
  skew = -1; // real Node timers can fire ~1 ms before the Date.now() target
  t.mock.timers.tick(60 * MIN);
  t.mock.timers.tick(10); // an immediate re-arm would fire here
  assert.equal(fired, 1);
  cancel();
});

test('everyDay rejects a bad time, and a throwing task does not stop the next day', (t) => {
  assert.throws(() => everyDay('9am', 0, () => {}), /HH:MM/);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 8, 24, 7, 0) });
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  const cancel = everyDay('09:00', 0, () => {
    calls++;
    throw new Error('boom');
  });
  t.mock.timers.tick(60 * MIN);
  t.mock.timers.tick(24 * 60 * MIN); // separate ticks: a timer armed during a tick waits for the next one
  assert.equal(calls, 2);
  cancel();
});

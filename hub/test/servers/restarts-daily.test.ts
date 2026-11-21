// Daily restarts: a bad time, the countdown every day across a DST change, skipped offline or paused, an early timer,
// a second call, and a factorio server's.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIN, NOW, scheduled, setup } from './restarts-world.ts';

test('daily() rejects a bad time and keeps the earlier daily restart', (t) => {
  const { restarts, notices } = setup(t, Date.UTC(2026, 8, 24, 4, 0)); // 05:00 BST
  restarts.daily('gtnh', '06:00');
  assert.throws(() => restarts.daily('gtnh', '6am'), /must be HH:MM/);
  t.mock.timers.tick(50 * MIN); // 05:50
  assert.deepEqual(notices, [scheduled(10, 'daily')]);
});

test('daily restart counts down from 10 minutes before the time, every day', (t) => {
  // 24 Oct 2026 05:00 BST.
  const { restarts, commands, notices } = setup(t, Date.UTC(2026, 9, 24, 4, 0));
  restarts.daily('gtnh', '06:00');
  t.mock.timers.tick(49 * MIN);
  assert.deepEqual(notices, []);
  t.mock.timers.tick(1 * MIN); // 05:50 BST
  assert.deepEqual(notices, [scheduled(10, 'daily')]);
  t.mock.timers.tick(10 * MIN); // 06:00 BST
  assert.equal(commands.at(-1), 'stop');
  notices.length = 0;
  t.mock.timers.tick(24 * 60 * MIN - 10 * MIN); // 05:50 GMT would be 25 h later, not 24 h
  assert.deepEqual(notices, []);
  t.mock.timers.tick(60 * MIN);
  assert.deepEqual(notices, [scheduled(10, 'daily')]);
});

test('a skipped daily restart (server offline) still arms the next day', (t) => {
  // 24 Sep 2026 05:00 BST: no DST change in the next two days.
  const { restarts, notices, state } = setup(t, Date.UTC(2026, 8, 24, 4, 0));
  restarts.daily('gtnh', '06:00');
  state.online = false;
  t.mock.timers.tick(50 * MIN); // 05:50: skipped, logged
  assert.deepEqual(notices, []);
  state.online = true;
  t.mock.timers.tick(24 * 60 * MIN); // next day 05:50
  assert.deepEqual(notices, [scheduled(10, 'daily')]);
});

test('a daily restart is skipped while paused (a pack update runs), and arms the next day', (t) => {
  const { restarts, notices, state } = setup(t, Date.UTC(2026, 8, 24, 4, 0));
  const errors = t.mock.method(console, 'error', () => {});
  restarts.daily('gtnh', '06:00');
  state.paused = 'a pack update is running';
  t.mock.timers.tick(50 * MIN); // 05:50: skipped, logged
  assert.deepEqual(notices, []);
  assert.equal(restarts.pending('gtnh'), undefined);
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /daily restart of gtnh skipped: a pack update is running/);
  state.paused = null;
  t.mock.timers.tick(24 * 60 * MIN); // next day 05:50
  assert.deepEqual(notices, [scheduled(10, 'daily')]);
});

test('a daily timer firing a millisecond early does not double-schedule', (t) => {
  // Real Node timers can fire ~1 ms before the Date.now() target.
  const { restarts, notices } = setup(t, Date.UTC(2026, 8, 24, 4, 0));
  const clock = Date.now.bind(Date);
  let skew = 0;
  t.mock.method(Date, 'now', () => clock() + skew);
  const errors = t.mock.method(console, 'error', () => {});
  restarts.daily('gtnh', '06:00');
  skew = -1;
  t.mock.timers.tick(50 * MIN);
  t.mock.timers.tick(10); // an immediate re-arm would fire here
  assert.deepEqual(notices, [scheduled(10, 'daily')]);
  assert.equal(errors.mock.callCount(), 0);
});

test('calling daily() again replaces the earlier daily restart instead of stacking it', (t) => {
  const { restarts, notices } = setup(t, Date.UTC(2026, 8, 24, 4, 0)); // 05:00 BST
  const errors = t.mock.method(console, 'error', () => {});
  restarts.daily('gtnh', '06:00');
  restarts.daily('gtnh', '06:00');
  t.mock.timers.tick(50 * MIN); // 05:50: exactly one countdown, and no "already scheduled" skip logged
  assert.deepEqual(notices, [scheduled(10, 'daily')]);
  assert.equal(errors.mock.callCount(), 0);
});

test("a factorio server's daily restart is one countdown, then one restart, never the stop command", (t) => {
  // 24 Sep 2026 05:00 BST.
  const { restarts, commands, notices, state, restarted } = setup(t, Date.UTC(2026, 8, 24, 4, 0));
  state.game = 'factorio';
  restarts.daily('space', '06:00');
  t.mock.timers.tick(50 * MIN); // 05:50 BST
  t.mock.timers.tick(10 * MIN); // 06:00 BST
  assert.deepEqual(commands, [
    'say Server restarting in 10 minutes',
    'say Server restarting in 5 minutes',
    'say Server restarting in 1 minute',
    'say Server restarting in 30 seconds',
    'say Server restarting in 10 seconds',
  ]);
  assert.deepEqual(restarted, ['space|hub:daily']);
  assert.deepEqual(notices, [scheduled(10, 'daily'), NOW]);
  t.mock.timers.tick(60 * MIN);
  assert.equal(commands.length, 5);
  assert.equal(restarted.length, 1);
});

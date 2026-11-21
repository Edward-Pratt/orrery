// How a countdown ends: the stop command's failures, a stop countdown's own action (failing, cancelled), and a factorio
// server's restart.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failed, flush, MIN, NOW, scheduled, setup } from './restarts-world.ts';

test('stop failing with a disconnect is success; a timeout is reported', async (t) => {
  const { restarts, notices, state } = setup(t);
  state.stopError = new Error('server disconnected');
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(notices, [NOW]);
  state.stopError = new Error('command timed out — it may still run when the server responds');
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(notices.at(-1), failed('command timed out — it may still run when the server responds'));
});

test('a stop countdown warns of a stop, then runs its own action instead of the stop command', async (t) => {
  const { restarts, commands, notices, log } = setup(t);
  const fired: string[] = [];
  restarts.schedule('gtnh', 1, 'web:alex (5)', 'alex', { stop: true, fire: async () => void fired.push('systemctl stop') });
  assert.deepEqual(restarts.pending('gtnh'), { at: Date.now() + MIN, by: 'alex', stop: true });
  t.mock.timers.tick(MIN);
  assert.deepEqual(commands, ['say Server stopping in 1 minute', 'say Server stopping in 30 seconds', 'say Server stopping in 10 seconds']);
  assert.deepEqual(fired, ['systemctl stop']);
  assert.deepEqual(notices, [
    { severity: 'info', kind: 'restartScheduled', ms: MIN, by: 'alex', stop: true },
    { severity: 'info', kind: 'restartNow', stop: true },
  ]);
  assert.deepEqual(log.filter((l) => !l.includes('|command|')), []); // its own action: audited by whoever owns it
  assert.equal(restarts.pending('gtnh'), undefined);
});

test("a stop countdown's failing action is reported", async (t) => {
  const { restarts, notices } = setup(t);
  restarts.schedule('gtnh', 0, 'alice', 'alice', { stop: true, fire: () => Promise.reject(new Error('permission denied')) });
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(notices.at(-1), failed('permission denied'));
});

test('cancelling a stop countdown says the stop is cancelled', (t) => {
  const { restarts, commands } = setup(t);
  restarts.schedule('gtnh', 5, 'alice', 'alice', { stop: true, fire: async () => {} });
  restarts.cancel('gtnh', 'bob');
  t.mock.timers.tick(0);
  assert.deepEqual(commands.at(-1), 'say Stop cancelled');
  assert.equal(restarts.pending('gtnh'), undefined);
});

test("a factorio server's countdown ends in its restart, never the stop command", async (t) => {
  const { restarts, commands, notices, state, restarted } = setup(t);
  state.game = 'factorio';
  restarts.schedule('space', 1, 'discord:alice (1)', 'alice');
  t.mock.timers.tick(MIN);
  assert.deepEqual(commands, ['say Server restarting in 1 minute', 'say Server restarting in 30 seconds', 'say Server restarting in 10 seconds']);
  assert.deepEqual(restarted, ['space|discord:alice (1)']);
  assert.deepEqual(notices, [scheduled(1, 'alice'), NOW]);
  state.restartError = new Error('agent vm is not connected');
  restarts.schedule('space', 0, 'alice');
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(notices.at(-1), failed('agent vm is not connected'));
  assert.ok(!commands.includes('stop'));
});

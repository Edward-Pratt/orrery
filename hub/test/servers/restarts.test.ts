// Countdown restarts (`restarts.ts`): the warnings, the bad requests, cancel, and the audit. A server going down is in
// `restarts-down.test.ts`, daily restarts in `restarts-daily.test.ts`, how a countdown ends in `restarts-end.test.ts`,
// the shared setup in `restarts-world.ts`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelled, MIN, NOW, scheduled, setup } from './restarts-world.ts';

test('a 10 minute restart warns at 10m, 5m, 1m, 30s and 10s, then stops', (t) => {
  const { restarts, commands, notices } = setup(t);
  restarts.schedule('gtnh', 10, 'alice');
  t.mock.timers.tick(0);
  assert.deepEqual(commands, ['say Server restarting in 10 minutes']);
  assert.equal(restarts.pending('gtnh')?.by, 'alice');
  t.mock.timers.tick(10 * MIN);
  assert.deepEqual(commands, [
    'say Server restarting in 10 minutes',
    'say Server restarting in 5 minutes',
    'say Server restarting in 1 minute',
    'say Server restarting in 30 seconds',
    'say Server restarting in 10 seconds',
    'stop',
  ]);
  assert.deepEqual(notices, [scheduled(10, 'alice'), NOW]);
  assert.equal(restarts.pending('gtnh'), undefined);
});

test('shorter countdowns only use the warnings that fit; 0 stops straight away', (t) => {
  const { restarts, commands, notices } = setup(t);
  restarts.schedule('gtnh', 2, 'alice');
  t.mock.timers.tick(2 * MIN);
  assert.deepEqual(commands, [
    'say Server restarting in 1 minute',
    'say Server restarting in 30 seconds',
    'say Server restarting in 10 seconds',
    'stop',
  ]);
  commands.length = notices.length = 0;
  restarts.schedule('gtnh', 0, 'bob');
  t.mock.timers.tick(0);
  assert.deepEqual(commands, ['stop']);
  assert.deepEqual(notices, [NOW]);
});

test('rejects bad minutes, an offline server, and a second pending restart', (t) => {
  const { restarts, state } = setup(t);
  assert.throws(() => restarts.schedule('gtnh', 61, 'a'), /0 to 60/);
  assert.throws(() => restarts.schedule('gtnh', 1.5, 'a'), /whole number/);
  restarts.schedule('gtnh', 5, 'a');
  assert.throws(() => restarts.schedule('gtnh', 5, 'a'), /already scheduled/);
  state.online = false;
  assert.throws(() => restarts.schedule('other', 5, 'a'), /offline/);
});

test('cancel stops the countdown and tells players', (t) => {
  const { restarts, commands, notices } = setup(t);
  restarts.schedule('gtnh', 5, 'alice');
  assert.equal(restarts.cancel('gtnh', 'bob'), true);
  assert.equal(restarts.cancel('gtnh', 'bob'), false);
  t.mock.timers.tick(10 * MIN);
  assert.deepEqual(commands, ['say Restart cancelled']);
  assert.deepEqual(notices, [scheduled(5, 'alice'), cancelled('bob')]);
});

test('the audit name goes to stop; people see the display name', (t) => {
  const { restarts, audit, notices } = setup(t);
  restarts.schedule('gtnh', 1, 'discord:alice (123)', 'alice');
  assert.equal(restarts.pending('gtnh')?.by, 'alice');
  t.mock.timers.tick(MIN);
  assert.deepEqual(notices[0], scheduled(1, 'alice'));
  assert.equal(audit.at(-1), 'stop|discord:alice (123)');
});

test('scheduling, cancelling and the daily restart leave audit entries naming who', (t) => {
  const { restarts, log } = setup(t, Date.UTC(2026, 8, 24, 4, 0)); // 05:00 BST
  restarts.schedule('gtnh', 5, 'discord:alice (1)', 'alice');
  restarts.cancel('gtnh', 'discord:bob (2)', 'bob');
  restarts.cancel('gtnh', 'discord:bob (2)', 'bob'); // nothing pending: no entry
  assert.throws(() => restarts.schedule('gtnh', 99, 'discord:alice (1)'));
  restarts.daily('gtnh', '06:00');
  t.mock.timers.tick(50 * MIN); // 05:50: the countdown starts
  t.mock.timers.tick(10 * MIN);
  assert.deepEqual(
    log.filter((l) => !l.includes('|say ')),
    [
      'discord:alice (1)|restart|gtnh|in 5 min',
      'discord:bob (2)|restart cancel|gtnh|',
      'hub:daily|restart|gtnh|in 10 min',
      'hub:daily|command|gtnh|stop',
    ],
  );
  assert.ok(log.includes('hub:restart|command|gtnh|say Restart cancelled'));
});

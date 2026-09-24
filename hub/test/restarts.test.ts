import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { nextDaily, parseDaily, RestartScheduler } from '../src/restarts.ts';
import type { HubEvent, ServerHub, ServerState } from '../src/servers.ts';

process.env.TZ = 'Europe/London'; // daily-restart assertions are in UK local time, across a DST change

const MIN = 60_000;
const flush = () => new Promise((r) => setImmediate(r)); // setImmediate isn't mocked: lets rejections settle

function setup(t: TestContext, now = Date.UTC(2026, 8, 24, 12, 0)) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const events = new EventEmitter<{ event: [HubEvent] }>();
  const commands: string[] = [];
  const notices: string[] = [];
  const state = { online: true, stopError: null as Error | null };
  const hub = {
    on: (name: 'event', fn: (e: HubEvent) => void) => events.on(name, fn),
    get: (id: string) => (state.online ? ({ id, online: true } as ServerState) : undefined),
    runCommand: async (_id: string, command: string) => {
      commands.push(command);
      if (command === 'stop' && state.stopError) throw state.stopError;
      return [];
    },
  } as unknown as Pick<ServerHub, 'runCommand' | 'on' | 'get'>;
  const restarts = new RestartScheduler(hub, (_id, text) => notices.push(text));
  t.after(() => restarts.stop());
  return { restarts, events, commands, notices, state };
}

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
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by alice)', '🔄 Restarting now']);
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
  assert.deepEqual(notices, ['🔄 Restarting now']);
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
  assert.deepEqual(notices, ['🔄 Restart in 5 minutes (by alice)', '❎ Restart cancelled (by bob)']);
});

test('the server going down first cancels; its own stop does not', (t) => {
  const { restarts, events, commands, notices } = setup(t);
  restarts.schedule('gtnh', 5, 'alice');
  events.emit('event', { serverId: 'gtnh', type: 'crashed' });
  t.mock.timers.tick(10 * MIN);
  assert.ok(!commands.includes('stop'));
  assert.equal(notices.at(-1), '❎ Restart cancelled (server went down)');
  notices.length = 0;
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  events.emit('event', { serverId: 'gtnh', type: 'stopped' }); // caused by our own stop
  assert.deepEqual(notices, ['🔄 Restarting now']);
});

test('stop failing with a disconnect is success; a timeout is reported', async (t) => {
  const { restarts, notices, state } = setup(t);
  state.stopError = new Error('server disconnected');
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(notices, ['🔄 Restarting now']);
  state.stopError = new Error('command timed out — it may still run when the server responds');
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  await flush();
  assert.equal(notices.at(-1), '❌ Restart failed: command timed out — it may still run when the server responds');
});

test('parseDaily accepts only 24-hour HH:MM', () => {
  assert.deepEqual(parseDaily('06:00'), { h: 6, m: 0 });
  assert.deepEqual(parseDaily('23:59'), { h: 23, m: 59 });
  for (const bad of ['6:00', '24:00', '06:60', '6am', '']) assert.equal(parseDaily(bad), null, bad);
});

test('daily() rejects a bad time', (t) => {
  const { restarts } = setup(t);
  assert.throws(() => restarts.daily('gtnh', '6am'), /dailyRestart must be HH:MM/);
});

test('nextDaily follows the local clock across the October DST change', () => {
  // 24 Oct 2026 06:00 BST (05:00 UTC). Clocks go back at 02:00 on 25 Oct.
  const now = Date.UTC(2026, 9, 24, 5, 0);
  const next = nextDaily({ h: 6, m: 0 }, 10 * MIN, now);
  assert.equal(new Date(next).toISOString(), '2026-10-25T05:50:00.000Z'); // 05:50 GMT, 25 h later
});

test('daily restart counts down from 10 minutes before the time, every day', (t) => {
  // 24 Oct 2026 05:00 BST.
  const { restarts, commands, notices } = setup(t, Date.UTC(2026, 9, 24, 4, 0));
  restarts.daily('gtnh', '06:00');
  t.mock.timers.tick(49 * MIN);
  assert.deepEqual(notices, []);
  t.mock.timers.tick(1 * MIN); // 05:50 BST
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
  t.mock.timers.tick(10 * MIN); // 06:00 BST
  assert.equal(commands.at(-1), 'stop');
  notices.length = 0;
  t.mock.timers.tick(24 * 60 * MIN - 10 * MIN); // 05:50 GMT would be 25 h later, not 24 h
  assert.deepEqual(notices, []);
  t.mock.timers.tick(60 * MIN);
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
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
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
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
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
  assert.equal(errors.mock.callCount(), 0);
});

test('nextDaily re-applies the time after a spring-forward gap', () => {
  // 28 Mar 2027: UK clocks skip 01:00–02:00, so 01:30 that day becomes 02:30 BST. The next day must be 01:30 again.
  const after = Date.UTC(2027, 2, 28, 1, 21); // 02:21 BST, just after that day's 02:20 countdown
  assert.equal(new Date(nextDaily({ h: 1, m: 30 }, 10 * MIN, after)).toISOString(), '2027-03-29T00:20:00.000Z'); // 01:20 BST
});

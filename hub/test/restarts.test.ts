import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { RestartScheduler } from '../src/restarts.ts';
import { ServerHub, type HubEvent, type Notice, type ServerState } from '../src/servers.ts';

process.env.TZ = 'Europe/London'; // daily-restart assertions are in UK local time, across a DST change

const MIN = 60_000;
const flush = () => new Promise((r) => setImmediate(r)); // setImmediate isn't mocked: lets rejections settle
const scheduled = (minutes: number, by: string): Notice => ({ severity: 'info', kind: 'restartScheduled', ms: minutes * MIN, by });
const NOW: Notice = { severity: 'info', kind: 'restartNow' };
const cancelled = (by: string): Notice => ({ severity: 'info', kind: 'restartCancelled', by });
const DOWN: Notice = { severity: 'info', kind: 'restartCancelledDown' };
const failed = (error: string): Notice => ({ severity: 'problem', kind: 'restartFailed', error });

function setup(t: TestContext, now = Date.UTC(2026, 8, 24, 12, 0)) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const events = new EventEmitter<{ event: [HubEvent] }>();
  const commands: string[] = [];
  const audit: string[] = []; // "command|by"
  const log: string[] = []; // "actor|action|target|details", from hub.audit
  const notices: Notice[] = []; // published on the hub's event stream
  const state = { online: true, downs: 0, stopError: null as Error | null, paused: null as string | null, game: 'minecraft', restartError: null as Error | null };
  const restarted: string[] = []; // "serverId|by", the `restart` a factorio server's countdown ends in
  const runCommand = async (id: string, command: string, by: string) => {
    commands.push(command);
    audit.push(`${command}|${by}`);
    log.push(`${by}|command|${id}|${command}`); // ServerHub audits every command it sends
    if (command === 'stop' && state.stopError) throw state.stopError;
    return [];
  };
  const hub = {
    on: (name: 'event', fn: (e: HubEvent) => void) => events.on(name, fn),
    get: (id: string) => (state.online ? ({ id, online: true, game: state.game } as ServerState) : undefined),
    downs: () => state.downs,
    runCommand,
    // What ServerHub.broadcast does on a Mod's server.
    broadcast: async (id: string, text: string, by: string) => void (await runCommand(id, `say ${text}`, by)),
    audit: (actor: string, action: string, target: string, details = '') => void log.push(`${actor}|${action}|${target}|${details}`),
    publish: (serverId: string, notice: Notice) => {
      notices.push(notice);
      events.emit('event', { ...notice, type: 'notice', serverId });
    },
  } as unknown as Pick<ServerHub, 'runCommand' | 'broadcast' | 'on' | 'get' | 'downs' | 'publish' | 'audit'>;
  const restart = async (id: string, by: string) => {
    restarted.push(`${id}|${by}`);
    if (state.restartError) throw state.restartError;
  };
  const restarts = new RestartScheduler(hub, { paused: () => state.paused, restart });
  t.after(() => restarts.stop());
  return { restarts, events, commands, audit, log, notices, state, restarted };
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

test('the server going down (or its Agent leaving) first cancels; its own stop does not', (t) => {
  const { restarts, events, commands, notices } = setup(t);
  restarts.schedule('gtnh', 5, 'alice');
  events.emit('event', { serverId: 'gtnh', type: 'crashed' });
  t.mock.timers.tick(10 * MIN);
  assert.ok(!commands.includes('stop'));
  assert.deepEqual(notices.at(-1), DOWN);
  notices.length = 0;
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  events.emit('event', { serverId: 'gtnh', type: 'stopped' }); // caused by our own stop
  assert.deepEqual(notices, [NOW]);
  notices.length = 0;
  restarts.schedule('gtnh', 5, 'alice');
  events.emit('event', { serverId: 'gtnh', type: 'lost' }); // its Agent left: no game connection to warn through
  assert.deepEqual(notices.slice(1), [DOWN]);
  t.mock.timers.tick(10 * MIN);
  assert.equal(commands.filter((c) => c === 'stop').length, 1); // only the earlier countdown's
});

test('a server that went down with no down event (dropped over its budget) cancels at its next event, warning or the end', (t) => {
  const { restarts, events, commands, notices, state, restarted } = setup(t);
  state.game = 'factorio';
  // At the end: the last warning is out, then it goes down and back with nothing on the stream.
  restarts.schedule('space', 1, 'alice');
  t.mock.timers.tick(50_000);
  state.downs++;
  t.mock.timers.tick(10_000);
  assert.deepEqual(restarted, []);
  assert.deepEqual(notices, [scheduled(1, 'alice'), DOWN]);
  assert.equal(restarts.pending('space'), undefined);
  // At a warning: none is said.
  notices.length = 0;
  restarts.schedule('space', 5, 'alice');
  const said = commands.length;
  state.downs++;
  t.mock.timers.tick(MIN);
  assert.equal(commands.length, said);
  assert.deepEqual(notices, [scheduled(5, 'alice'), DOWN]);
  // At its next event (its `connected`), before any warning.
  notices.length = 0;
  restarts.schedule('space', 5, 'alice');
  state.downs++;
  events.emit('event', { serverId: 'space', type: 'connected' });
  assert.deepEqual(notices, [scheduled(5, 'alice'), DOWN]);
  t.mock.timers.tick(10 * MIN);
  assert.deepEqual(restarted, []);
});

test("a factorio server's countdown with its lifecycle budget spent: a crash and a reconnect, both dropped, still cancel it", async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 8, 24, 12, 0) });
  t.mock.method(console, 'error', () => {});
  const hub = new ServerHub([{ id: 'space', name: 'Space Age', game: 'factorio' }]);
  t.after(() => hub.close());
  const restarted: string[] = [];
  const restarts = new RestartScheduler(hub, { restart: async (id, by) => void restarted.push(`${id}|${by}`) });
  t.after(() => restarts.stop());
  const lifecycle: string[] = [];
  const notices: string[] = [];
  hub.on('event', (e) => (e.type === 'notice' ? notices.push(e.kind) : lifecycle.push(e.type)));
  const attach = () => {
    const socket = new PassThrough();
    socket.resume(); // the countdown's lines to the Agent go nowhere
    hub.attach(socket as unknown as Socket, 'space', '1.0.0');
    return socket;
  };
  const closed = () => new Promise((r) => setImmediate(r)); // a destroyed stream's 'close' comes on a later tick
  // An Agent's token holder churning connections spends the budget: 20 events, then none goes out.
  hub.agentUp('space');
  for (let i = 0; i < 10; i++) {
    attach(); // connected
    hub.agentDown('space'); // lost
    hub.agentUp('space');
  }
  let game = attach();
  assert.equal(lifecycle.length, 20);
  assert.equal(hub.get('space')?.online, true);

  restarts.schedule('space', 5, 'alice');
  game.destroy();
  await closed();
  t.mock.timers.tick(5_000); // crashed, once its Agent connection outlived the settle wait: dropped
  game = attach(); // back: its connected dropped too
  assert.equal(lifecycle.length, 20, 'the crash and the reconnect are over the budget');
  assert.equal(hub.get('space')?.online, true);
  t.mock.timers.tick(5 * MIN);
  assert.deepEqual(restarted, [], 'the server that came back is not restarted');
  assert.deepEqual(notices, ['restartScheduled', 'restartCancelledDown']);
  assert.equal(restarts.pending('space'), undefined);
});

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

test('the audit name goes to stop; people see the display name', (t) => {
  const { restarts, audit, notices } = setup(t);
  restarts.schedule('gtnh', 1, 'discord:alice (123)', 'alice');
  assert.equal(restarts.pending('gtnh')?.by, 'alice');
  t.mock.timers.tick(MIN);
  assert.deepEqual(notices[0], scheduled(1, 'alice'));
  assert.equal(audit.at(-1), 'stop|discord:alice (123)');
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

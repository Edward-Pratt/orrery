// A server going down cancels its countdown: its down events, its own stop not, and `ServerHub.downs` moved with no
// event (a factorio server's dropped over its lifecycle budget, on a real `ServerHub` too).

import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { RestartScheduler } from '../../src/servers/restarts.ts';
import { ServerHub } from '../../src/servers/servers.ts';
import { DOWN, MIN, NOW, scheduled, setup } from './restarts-world.ts';

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

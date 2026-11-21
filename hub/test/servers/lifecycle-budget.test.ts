// The lifecycle events and a factorio server's budget for them (`lifecycle-budget.ts`); a Minecraft server has none.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db } from '../../src/stats/db.ts';
import { online, until } from '../fake-mod.ts';
import { factorio, setup } from './server-hub.ts';

test("a factorio server's churned lifecycle stores at most its budget, and its latest state once the budget allows", async (t) => {
  const { hub, events, errors, attach, rows } = factorio(t);
  for (let i = 0; i < 200; i++) {
    hub.agentUp('space');
    attach(); // connected
    hub.agentDown('space'); // lost
    t.mock.timers.tick(18_000); // 200 cycles in an hour
  }
  // 20 at once, 20 more refilled over the hour, and the latest dropped one put through on the way
  assert.ok(events.length <= 41, `${events.length} events`);
  assert.ok(rows().length <= 41, `${rows().length} rows`);
  assert.ok(errors.mock.callCount() >= 1 && errors.mock.callCount() <= 60, `${errors.mock.callCount()} log lines`); // at most once a minute
  assert.match(String(errors.mock.calls[1].arguments[0]), /^\[hub\] space: over 20 lifecycle events an hour, dropped \d+$/);
  t.mock.timers.tick(180_000); // the next token: the latest event goes out if it hasn't
  assert.equal(events.at(-1)?.type, 'lost');
  assert.equal(rows().at(-1)?.state, 'unknown');
  assert.equal(hub.get('space')?.online, false);

  // ending on a connection: the card's online, and so is the recorded state once the budget allows
  for (let i = 0; i < 30; i++) {
    hub.agentUp('space');
    attach();
    if (i < 29) hub.agentDown('space');
  }
  assert.equal(hub.get('space')?.online, true);
  const before = events.length; // its budget is spent: the latest connection is not out yet
  t.mock.timers.tick(180_000);
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1)?.type, 'connected');
  assert.equal(rows().at(-1)?.state, 'up');
  t.mock.timers.tick(3_600_000); // nothing left to put through
  assert.equal(events.at(-1)?.type, 'connected');
});

test("a factorio server's normal use, a few starts and stops a day, is all recorded", async (t) => {
  const { hub, events, errors, attach, closed, rows } = factorio(t);
  hub.agentUp('space');
  const expected: string[] = [];
  for (let day = 0; day < 3; day++) {
    for (let run = 0; run < 4; run++) {
      const game = attach();
      game.send({ type: 'started' });
      t.mock.timers.tick(2 * 3_600_000);
      game.send({ type: 'stopping' });
      game.socket.destroy();
      await closed();
      t.mock.timers.tick(4 * 3_600_000);
      expected.push('connected', 'started', 'stopped');
    }
  }
  assert.deepEqual(
    events.map((e) => e.type),
    expected,
  );
  assert.deepEqual(
    rows().map((r) => r.reason),
    expected,
  );
  assert.equal(errors.mock.callCount(), 0);
});

test("a factorio server's bad minute, 20 lifecycle events at once, is all recorded; the 21st waits for the budget", async (t) => {
  const { hub, events, errors, attach, closed, rows } = factorio(t);
  const expected: string[] = [];
  hub.agentUp('space');
  let game = attach();
  game.send({ type: 'started' });
  expected.push('connected', 'started');
  // a restart: the game stops, and comes back
  game.send({ type: 'stopping' });
  game.socket.destroy();
  await closed();
  game = attach();
  game.send({ type: 'started' });
  expected.push('stopped', 'connected', 'started');
  // its Agent restarts, then the game crashes twice, then its Agent is lost, then the game crashes again
  const agentBack = () => {
    hub.agentDown('space');
    hub.agentUp('space');
    game = attach();
    game.send({ type: 'started' });
    expected.push('lost', 'connected', 'started');
  };
  const crash = async () => {
    game.socket.destroy();
    await closed();
    t.mock.timers.tick(5_000); // settleMs: its Agent connection stayed up
    game = attach();
    game.send({ type: 'started' });
    expected.push('crashed', 'connected', 'started');
  };
  agentBack();
  await crash();
  await crash();
  agentBack();
  await crash();
  // 20 events in 15 s: the burst takes them all, nothing dropped or logged
  assert.equal(expected.length, 20);
  assert.deepEqual(
    events.map((e) => e.type),
    expected,
  );
  assert.deepEqual(
    rows().map((r) => r.reason),
    expected,
  );
  assert.equal(errors.mock.callCount(), 0);

  // the 21st finds under a token (one comes every 3 min), so it waits, and goes out when the token comes
  hub.agentDown('space');
  assert.equal(events.length, 20);
  assert.equal(errors.mock.callCount(), 1);
  t.mock.timers.tick(180_000);
  assert.equal(events.length, 21);
  assert.equal(events.at(-1)?.type, 'lost');
  assert.equal(rows().at(-1)?.reason, 'lost');
  assert.equal(errors.mock.callCount(), 1); // putting it through is no second drop
});

test("a Minecraft server's lifecycle has no budget: every connect and crash is recorded", async (t) => {
  const { hub, port, events } = await setup(t);
  const db = new Db(':memory:');
  const from = Date.now();
  hub.on('event', (e) => db.recordLifecycle(e.serverId, e.type));
  const errors = t.mock.method(console, 'error', () => {});
  const expected: string[] = [];
  for (let i = 0; i < 30; i++) {
    const mod = await online(port);
    mod.socket.destroy();
    expected.push('connected', 'crashed');
    await until(() => events.length === expected.length);
  }
  assert.deepEqual(
    events.map((e) => e.type),
    expected,
  );
  assert.deepEqual(
    db.states('gtnh', from - 1).map((r) => r.reason),
    expected,
  );
  assert.equal(errors.mock.callCount(), 0);
});

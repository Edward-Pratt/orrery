// The event budget (200 chat events in 1 s: 30 at once, then 5 a second, the rest in one log line a minute with the
// count; one event a second all forwarded; with a fake clock and mock timers) and a flood through `GameEvents` (a
// frozen clock: 200 datagrams give 30, a second later 10 give 5, no seq gap logged, the count at `stop`). The setup is
// `events-world.ts`'s.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DROP_LOG_MS, EVENT_BURST, EVENT_RATE, EventBudget } from '../src/events-budget.ts';
import { eventually } from './fake-hub.ts';
import { BANNER, printed, setup, up } from './events-world.ts';

test('the event budget: 200 chat events in 1 s forward at most 30 at once and 5 a second after, the rest counted in one line a minute', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // the minute of the log; the budget's own clock is `now`
  const log = t.mock.method(console, 'log', () => {});
  let now = 0;
  const budget = new EventBudget(() => now);
  const passed: number[] = [];
  for (let i = 0; i < 200; i++) {
    now = i * 5; // 200 in [0, 1 s)
    if (budget.take()) passed.push(now);
    assert.ok(passed.length <= EVENT_BURST + Math.floor((now * EVENT_RATE) / 1000), `${passed.length} by ${now} ms`);
  }
  assert.equal(passed.filter((at) => at < 150).length, EVENT_BURST, 'the burst: 30 at once');
  assert.equal(passed.length, 34, 'then 5 a second');

  // Still flooded, 50 a second for 10 s: exactly 5 in each second.
  const perSecond = new Array<number>(10).fill(0);
  for (now = 1000; now < 11_000; now += 20) if (budget.take()) perSecond[Math.floor(now / 1000) - 1]!++;
  assert.deepEqual(perSecond, new Array(10).fill(EVENT_RATE));
  const dropped = 200 - passed.length + 500 - 50;

  assert.deepEqual(printed(log), [], 'nothing logged before the minute is up');
  t.mock.timers.tick(DROP_LOG_MS);
  assert.deepEqual(printed(log), [`[events] dropped ${dropped} game events in the last minute: over 5 a second (30 at once)`]);
  t.mock.timers.tick(5 * DROP_LOG_MS);
  assert.equal(printed(log).length, 1, 'one line, not one per minute while quiet');

  // Normal play, one event a second (after a quiet minute): every one goes, nothing is logged.
  now += DROP_LOG_MS;
  for (let i = 0; i < 120; i++, now += 1000) assert.equal(budget.take(), true, `event ${i}`);
  t.mock.timers.tick(DROP_LOG_MS);
  assert.equal(printed(log).length, 1);

  // A full burst comes back after a quiet 6 s; `flush` logs what is counted at once.
  now += 6000;
  for (let i = 0; i < EVENT_BURST; i++) assert.equal(budget.take(), true, `burst ${i}`);
  assert.equal(budget.take(), false);
  budget.flush();
  assert.equal(printed(log)[1], '[events] dropped 1 game event in the last minute: over 5 a second (30 at once)');
});

test('GameEvents forwards within the budget: a chat flood from Factorio’s port is cut to 30, then 5 a second; the count is logged at stop', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  let now = 0; // frozen: the first 200 come at once
  const s = await setup(t, { now: () => now });
  await s.start([BANNER, up(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on', 2000, 'the gate');
  /**
   * Sends chat datagrams `from` to `to` (seq), then `last` from the same socket: processed after them, the line it
   * logs (`says`; a drop is logged once per start, the hello too) shows they all were.
   */
  const flood = async (from: number, to: number, last: object | Buffer, says: string) => {
    for (let seq = from; seq <= to; seq++) await s.send(s.factorio, { seq, t: 'chat', player: 'Alice', message: `spam ${seq}` });
    await s.send(s.factorio, last);
    await eventually(() => printed(log).some((l) => l.startsWith(says)), 2000, `datagrams up to ${to}`);
  };
  const budgetLines = () => printed(log).filter((l) => /game events? (lost|in the last minute)|went back/.test(l));
  await flood(1, 200, { seq: 200, t: 'hello' }, "[events] the mod's hello came: seq 200");
  assert.equal(s.got.length, EVENT_BURST);
  assert.deepEqual(s.got.at(-1), { type: 'chat', player: 'Alice', message: 'spam 30' });
  now += 1000;
  await flood(201, 210, Buffer.from('not json'), '[events] dropped a datagram: not JSON');
  assert.equal(s.got.length, EVENT_BURST + EVENT_RATE, '5 more a second later');
  assert.deepEqual(s.got.slice(EVENT_BURST).map((e) => e.type === 'chat' && e.message), ['spam 201', 'spam 202', 'spam 203', 'spam 204', 'spam 205']);
  assert.deepEqual(budgetLines(), [], 'no seq gap for what the budget dropped; no count before the minute');

  s.events.stop();
  assert.deepEqual(budgetLines(), ['[events] dropped 175 game events in the last minute: over 5 a second (30 at once)']);
});

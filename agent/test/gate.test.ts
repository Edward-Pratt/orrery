import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GOOD_WITHIN_MS, StartGate, failedStart } from '../src/gate.ts';
import type { UnitState } from '../src/service.ts';

/** A clock in whole seconds, as systemd's change times are. */
const T0 = Math.floor(Date.now() / 1000) * 1000;
const state = (active: string, sub: string, since: number, result = 'success'): UnitState => ({ unit: 'factorio.service', active, sub, since, result });

function gate(armedAt: number | null = null) {
  let now = T0;
  const g = new StartGate({ armedAt, now: () => now });
  const seen: string[] = [];
  g.on('start', (since) => seen.push(`start ${since - T0}`));
  g.on('good', (since, gated) => seen.push(`good ${since - T0}${gated ? ' gated' : ''}`));
  g.on('failed', (s) => seen.push(`failed ${s.active} ${s.sub}`));
  return { g, seen, at: (ms: number) => (now = T0 + ms) };
}

test('failedStart: failed, or an auto-restart after a run that did not succeed', () => {
  assert.equal(failedStart(state('failed', 'failed', 0, 'exit-code')), true);
  assert.equal(failedStart(state('activating', 'auto-restart', 0, 'exit-code')), true);
  assert.equal(failedStart(state('activating', 'auto-restart-queued', 0, 'exit-code')), true);
  assert.equal(failedStart(state('activating', 'auto-restart', 0, 'success')), false);
  assert.equal(failedStart(state('activating', 'start', 0, 'exit-code')), false);
  assert.equal(failedStart(state('inactive', 'dead', 0, 'success')), false);
  assert.equal(failedStart(state('deactivating', 'stop-post', 0, 'exit-code')), false);
});

test('every start is reported; one RCON answers within 300 s of is good, once; one the agent came to late is never judged', () => {
  const { g, seen, at } = gate();
  g.service(state('active', 'running', T0));
  g.service(state('active', 'running', T0)); // the same run
  at(10_000);
  g.rconUp();
  g.rconUp();
  g.service(state('deactivating', 'stop-sigterm', T0 + 20_000));
  g.service(state('inactive', 'dead', T0 + 30_000));
  at(40_000);
  g.service(state('active', 'running', T0 + 40_000));
  at(40_000 + GOOD_WITHIN_MS + 1);
  g.rconUp(); // too late: the start isn't judged
  // A restart between two readings: the change time moved while active.
  g.service(state('active', 'running', T0 + 400_000));
  at(400_000 + GOOD_WITHIN_MS);
  g.rconUp();
  assert.deepEqual(seen, ['start 0', 'good 0', 'start 40000', 'start 400000', 'good 400000']);
});

test('armed: the next start RCON answers in disarms it; a failed one is reported once, then it is disarmed', () => {
  const { g, seen, at } = gate();
  at(5_000);
  g.arm();
  assert.equal(g.armedAt, T0 + 5_000);
  g.service(state('active', 'running', T0 + 6_000));
  at(7_000);
  g.rconUp();
  assert.equal(g.armedAt, null);
  assert.deepEqual(seen, ['start 6000', 'good 6000 gated']);

  at(10_000);
  g.arm();
  g.service(state('activating', 'auto-restart', T0 + 12_000, 'exit-code'));
  g.service(state('activating', 'auto-restart', T0 + 24_000, 'exit-code'));
  assert.deepEqual(seen.slice(2), ['failed activating auto-restart'], 'once: then disarmed');
  assert.equal(g.armedAt, null);
});

test('armed while a run goes on: that run crashing is not the watched start, the next one failing is', () => {
  const { g, seen, at } = gate();
  g.service(state('active', 'running', T0));
  at(1_000);
  g.rconUp();
  at(60_000);
  g.arm(); // a live write to the running server
  g.service(state('deactivating', 'stop-post', T0 + 70_000, 'exit-code'));
  g.service(state('activating', 'auto-restart', T0 + 71_000, 'exit-code'));
  assert.equal(g.armedAt, T0 + 60_000, 'still armed');
  g.service(state('activating', 'auto-restart', T0 + 82_000, 'exit-code')); // the restart failed too: the watched start
  assert.deepEqual(seen, ['start 0', 'good 0', 'failed activating auto-restart']);
});

test('armed: a state from before the write, a clean stop and a start that is still loading decide nothing', () => {
  const { g, seen, at } = gate();
  g.service(state('failed', 'failed', T0, 'exit-code'));
  at(5_000);
  g.arm();
  g.service(state('failed', 'failed', T0 + 4_000, 'exit-code')); // changed in the second before the write's
  g.service(state('inactive', 'dead', T0 + 6_000));
  g.service(state('active', 'running', T0 + 7_000));
  assert.deepEqual(seen, ['start 7000']);
  assert.equal(g.armedAt, T0 + 5_000);
  g.service(state('activating', 'auto-restart', T0 + 9_000, 'exit-code')); // exited while loading: RCON never answered
  assert.deepEqual(seen, ['start 7000', 'failed activating auto-restart']);
});

test('the arming time is kept across restarts: a new gate armed then watches the same start', () => {
  const { g, seen } = gate(T0 - 30_000);
  g.service(state('activating', 'auto-restart', T0 - 10_000, 'exit-code'));
  assert.deepEqual(seen, ['failed activating auto-restart']);
});

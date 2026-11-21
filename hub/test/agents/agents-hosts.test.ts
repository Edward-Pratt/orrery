// An Agent's Host (`dispatch.ts`'s host samples, `host.ts`'s monitor): its samples go to its own Host, at most one
// stored per 10 s with the hub's clock, its first 32 mounts watched by its own limits, and a clock stepping back.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { until } from '../fake-mod.ts';
import { agentUp, hubSides, LIMITS_VM, readAll, SAMPLE, setup } from './agent-port.ts';

test("each Agent's host samples go to its own Host's monitor", async (t) => {
  const { hosts, port } = await setup(t);
  const own = hosts.add({ id: 'oracle', mounts: ['/'], ...LIMITS_VM });
  const agent = await agentUp(port);
  agent.send({ type: 'hostSample', sample: SAMPLE });
  await until(() => hosts.get('vm')!.latest() !== null);
  assert.equal(own.latest(), null);
  assert.deepEqual(hosts.get('vm')!.history(1).map((s) => s.cpu), [SAMPLE.cpu]);
  assert.deepEqual(own.history(1), []);
});

test("host samples: at most one stored per 10 s per Agent, reconnecting or not, with the hub's clock as its ts", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'error', () => {});
  const { hosts, db, port } = await setup(t);
  const sides = hubSides(t, port);
  const far = { ...SAMPLE, ts: 8.64e15 }; // the year 275760: the nightly prune by age would never remove it
  const flood = async (agent: Awaited<ReturnType<typeof agentUp>>, n: number) => {
    for (let i = 0; i < n; i++) agent.send({ type: 'hostSample', sample: { ...far, cpu: i / n } });
    await readAll(sides.at(-1)!, agent.socket);
  };
  const start = Date.now();
  const agent = await agentUp(port);
  await flood(agent, 50);
  t.mock.timers.tick(9_999);
  await flood(agent, 10);
  assert.deepEqual(db.hostSamples('vm', 0).map((s) => [s.ts, s.cpu]), [[start, 0]]); // the first one, stamped now
  t.mock.timers.tick(1);
  await flood(agent, 10);
  const again = await agentUp(port); // a new Agent connection gets no fresh sample either
  await flood(again, 10);
  assert.deepEqual(db.hostSamples('vm', 0).map((s) => s.ts), [start, start + 10_000]);
  assert.equal(db.hostSamples('vm', Date.now() + 1).length, 0); // nothing from the Agent's clock
  assert.equal(hosts.get('vm')!.latest()!.ts, start + 10_000);
  t.mock.timers.tick(10_000);
  await flood(again, 1);
  assert.equal(db.hostSamples('vm', 0).length, 3);
});

test("an Agent's Host watches the first 32 mounts its samples name, by its own limits, each one's change told at most once per 10 min", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { hosts, targets } = await setup(t);
  const vm = hosts.get('vm')!;
  const GB = 1024 ** 3;
  const told = () => targets.flatMap((e) => (e.type === 'notice' ? [`${e.kind} ${'mount' in e ? e.mount : ''}`] : []));
  const disks = (free: number, n = 32) => Array.from({ length: n }, (_, i) => ({ mount: `/m${i}`, free, total: 100 * GB }));
  const record = (free: number, n?: number) => vm.record({ ...SAMPLE, ts: Date.now(), disks: disks(free, n) });
  record(10 * GB); // at its diskMinFreeGB (10, from agents[].host): not low
  record(9.9 * GB, 40); // eight more names than it watches
  assert.equal(told().length, 32);
  assert.ok(told().every((n, i) => n === `diskLow /m${i}`));
  assert.deepEqual(targets.find((e) => e.type === 'notice'), { target: 'host', id: 'vm', type: 'notice', severity: 'warning', kind: 'diskLow', mount: '/m0', free: 9.9 * GB, minFreeGB: 10 });
  record(0, 40);
  for (let minute = 1; minute < 10; minute++) {
    t.mock.timers.tick(60_000);
    record(minute % 2 ? 50 * GB : 0); // flapping: each change waits out the 10 min
  }
  assert.equal(told().length, 32);
  t.mock.timers.tick(60_000); // 10 min on, and ok since the last sample: told now, once per mount
  record(50 * GB, 40);
  assert.equal(told().length, 64);
  assert.ok(told().slice(32).every((n, i) => n === `diskOk /m${i}`));
  t.mock.timers.tick(10_000);
  record(0); // low again 10 s on: waits
  t.mock.timers.tick(10 * 60_000);
  record(50 * GB); // and ok again before it was told: nothing to tell
  assert.equal(told().length, 64);
});

test('a clock stepping back neither refuses a handshake nor drops host samples for the length of the step', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { db, port } = await setup(t, { agents: { handshakeMs: 5_000 } });
  const sides = hubSides(t, port);
  const start = Date.now();
  const agent = await agentUp(port);
  agent.send({ type: 'hostSample', sample: SAMPLE });
  await readAll(sides.at(-1)!, agent.socket);
  t.mock.timers.setTime(start - 60_000); // the hub's clock stepped back a minute (NTP)
  const again = await agentUp(port); // welcomed, not "reconnecting too fast"
  await agent.closed;
  again.send({ type: 'hostSample', sample: SAMPLE });
  await readAll(sides.at(-1)!, again.socket);
  assert.deepEqual(db.hostSamples('vm', 0).map((s) => s.ts).sort((a, b) => a - b), [start - 60_000, start]);
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Agents, AgentStatus } from '../src/agents.ts';
import type { RestartScheduler } from '../src/restarts.ts';
import type { TargetEvent } from '../src/servers.ts';
import { FAILED_NOTICE_MS, Services, type Run } from '../src/services.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an agent-backed service's failures are a notice at most once per 10 min; a local unit's each time", async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const targets: TargetEvent[] = [];
  const hub = { publishTarget: (e: TargetEvent) => void targets.push(e), audit: () => {}, get: () => undefined };
  const agents = new EventEmitter() as EventEmitter & Pick<Agents, 'list' | 'request'>;
  const vm: AgentStatus = { id: 'vm', name: 'Factorio VM', server: 'space', connected: true, version: null };
  Object.assign(agents, { list: () => [vm], request: () => Promise.reject(new Error('not asked')) });
  let local = 'active';
  const run: Run = async () => `ActiveState=${local}\nSubState=${local === 'failed' ? 'failed' : 'running'}\n`;
  const services = new Services(
    hub,
    {} as RestartScheduler,
    [
      { id: 'factorio', unit: 'factorio.service' },
      { id: 'gtnh', unit: 'gtnh.service' },
    ],
    [
      { id: 'space', service: 'factorio' },
      { id: 'gtnh', service: 'gtnh' },
    ],
    [],
    run,
    agents as unknown as Pick<Agents, 'list' | 'request' | 'on'>,
  );
  services.start();
  t.after(() => services.stop());
  const failed = (id: string) => targets.filter((e) => e.type === 'notice' && e.kind === 'serviceFailed' && e.id === id).length;
  const push = (active: string) =>
    agents.emit('serviceState', 'vm', { type: 'serviceState', unit: 'factorio.service', active, sub: active === 'failed' ? 'failed' : 'running', since: Date.now(), result: 'success' });
  await sleep(1); // the local unit's first round
  for (let i = 0; i < 20; i++) {
    push(i % 2 ? 'active' : 'failed'); // into failed every other push, every 30 s
    local = i % 2 ? 'active' : 'failed';
    t.mock.timers.tick(30_000); // the local unit's next watch round reads it
    await sleep(1);
  }
  assert.equal(FAILED_NOTICE_MS, 20 * 30_000);
  assert.equal(failed('factorio'), 1); // 10 failures in its 10 min
  assert.equal(failed('gtnh'), 10);
  assert.equal(targets.filter((e) => e.type === 'state' && e.id === 'factorio').length, 20); // the stream has every one
  push('failed'); // 10 min since the first notice: a notice again
  assert.equal(failed('factorio'), 2);
});

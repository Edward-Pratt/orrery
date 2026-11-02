// with `fakeSystemctl` (`test/fake-systemctl.ts`: first on `PATH`; `show` prints the state a test sets and
// `list-units` the lines it sets, other calls are recorded, or refused like polkit), a real `ServiceWatch` and
// `HubClient` against the fake hub: `serviceAct` argv exactly `[verb, '--no-block', '--', 'factorio.service']`
// whatever else the request carries, a refusal answered `ok: false`; `stopping` only for a stop the agent started
// (and no new game connection while the old Factorio still answers), another stop waiting for the final state
// (`deactivating` decides nothing), a crash through `deactivating (stop-post)` to `auto-restart`, and `failed`,
// closed with no `stopping`; `RunWatch`'s sequences; `parseShow` and the watch itself.

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { HubClient } from '../src/hub.ts';
import { RunWatch, ServiceWatch, parseShow, showArgs, systemctl, type UnitState } from '../src/service.ts';
import type { Reading } from '../src/status.ts';
import { eventually, fakeHub, type HubConn } from './fake-hub.ts';
import { fakeSystemctl } from './fake-systemctl.ts';

const SHOW = 'ActiveState=active\nSubState=running\nStateChangeTimestamp=@1793475924\nResult=success\n';

test('parseShow reads systemctl show, the change time as epoch ms', () => {
  assert.deepEqual(parseShow('factorio.service', SHOW), {
    unit: 'factorio.service',
    active: 'active',
    sub: 'running',
    since: 1_793_475_924_000,
    result: 'success',
  });
  assert.equal(parseShow('x.service', 'ActiveState=inactive\nSubState=dead\nStateChangeTimestamp=\nResult=success\n').since, 0, 'never changed');
  assert.equal(parseShow('x.service', `ActiveState=${'a'.repeat(300)}\n`).active.length, 256, 'cut to the wire limit');
});

test('systemctl runs through execFile with only the agent argv: show, its properties, --, the unit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-systemctl-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, 'systemctl');
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\nprintf '${SHOW.replaceAll('\n', '\\n')}'\n`);
  await chmod(fake, 0o755);
  const out = await systemctl(fake)(showArgs('factorio.service'));
  assert.equal(out, SHOW);
  assert.deepEqual((await readFile(join(dir, 'argv'), 'utf8')).trimEnd().split('\n'), [
    'show',
    '--timestamp=unix',
    '--property=ActiveState,SubState,Result,StateChangeTimestamp',
    '--',
    'factorio.service',
  ]);
});

test('the watch emits the first state and each change, keeps the last state through a failed read', async (t) => {
  const outputs: (string | Error)[] = [SHOW, SHOW, SHOW.replace('running', 'stop-sigterm').replace('active\n', 'deactivating\n'), new Error('Failed to connect to bus')];
  let calls = 0;
  const watch = new ServiceWatch(
    'factorio.service',
    async (args) => {
      assert.deepEqual(args, showArgs('factorio.service'));
      const out = outputs[Math.min(calls++, outputs.length - 1)]!;
      if (out instanceof Error) throw out;
      return out;
    },
    10,
  );
  t.after(() => watch.stop());
  const changes: UnitState[] = [];
  watch.on('change', (s) => changes.push(s));
  t.mock.method(console, 'error', () => {});
  watch.start();
  await eventually(() => calls >= 6);
  assert.deepEqual(
    changes.map((s) => `${s.active}/${s.sub}`),
    ['active/running', 'deactivating/stop-sigterm'],
  );
  assert.equal(watch.state?.active, 'deactivating', 'a failed read keeps the last state');
  assert.equal((console.error as unknown as { mock: { callCount(): number } }).mock.callCount(), 1, 'the failure logged once');
});

// ---- serviceAct and the stopping rule, with a fake systemctl first on PATH, the fake hub and a real ServiceWatch.

const READING: Reading = { ups: 60, players: ['alice'], paused: false, modVersion: '0.1.0' };
const T0 = 1_793_475_900_000;
const types = (conn: HubConn) => conn.lines.map((m) => m.type);

/** The agent's unit and hub connections as index.ts wires them, its systemctl the fake on PATH, polled every 10 ms. */
async function world(t: TestContext) {
  const sc = await fakeSystemctl(t);
  const hub = await fakeHub();
  const root = await mkdtemp(join(tmpdir(), 'orrery-agent-'));
  const watch = new ServiceWatch('factorio.service', systemctl(), 10);
  const server = { id: 'factorio', unit: 'factorio.service', install: '/opt/factorio', data: '/srv/factorio', rconPort: 1, factorioUdpPort: 34198, agentUdpPort: 34199 };
  const client = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server, token: 'agent-token-'.padEnd(40, 'x'), root, state: join(root, 'state') },
    version: 'agent-v1.2.3',
    handlers: { serviceAct: ({ action }) => watch.act(action) },
  });
  watch.on('change', (s) => client.service(s));
  watch.on('stopping', () => client.stopping());
  t.after(async () => {
    watch.stop();
    await client.stop();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  client.start();
  watch.start();
  await eventually(() => client.connected);
  const agent = hub.of('agentHello')[0]!;
  /** The unit's state, once the watch has read it. */
  const unit = async (s: Omit<UnitState, 'unit'>) => {
    await sc.set(s);
    await eventually(() => watch.state?.active === s.active && watch.state.sub === s.sub && watch.state.since === s.since, 2000, `${s.active}/${s.sub}`);
  };
  /** RCON answers: the game connection opens; resolves once it is up and the hub has its `started`. */
  const game = async (n: number) => {
    client.status(READING);
    const conn = await eventually(() => hub.of('hello')[n], 2000, `game connection ${n + 1}`);
    await eventually(() => types(conn).includes('started'), 2000, 'started');
    return conn;
  };
  /** Sends a request on the Agent connection and resolves with its reply. */
  const request = async (msg: Record<string, unknown>) => {
    agent.send(msg);
    return eventually(() => agent.lines.find((m) => m.type === 'reply' && m.id === msg.id), 2000, `the reply to ${String(msg.id)}`);
  };
  return { sc, hub, client, agent, unit, game, request };
}

test('serviceAct runs systemctl <verb> --no-block -- factorio.service from PATH: only its own unit, nothing else from the hub', async (t) => {
  const w = await world(t);
  for (const action of ['start', 'stop', 'restart']) {
    // A unit or argv in the request is not a documented field: it never reaches systemctl.
    assert.deepEqual(await w.request({ type: 'serviceAct', id: action, action, unit: 'sshd.service', args: ['--force'] }), { type: 'reply', id: action, ok: true });
  }
  assert.deepEqual(await w.sc.calls(), [
    ['start', '--no-block', '--', 'factorio.service'],
    ['stop', '--no-block', '--', 'factorio.service'],
    ['restart', '--no-block', '--', 'factorio.service'],
  ]);
  await w.sc.refuse(true); // polkit says no: the error goes back, and there was no stop to announce
  const refused = await w.request({ type: 'serviceAct', id: 'refused', action: 'stop' });
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /^systemctl stop factorio\.service failed: .*Access denied/s);
  assert.deepEqual(w.agent.invalid, []);
});

test('stopping goes out only for a stop the agent started; another stop waits for the final state, deactivating decides nothing', async (t) => {
  const w = await world(t);
  await w.unit({ active: 'active', sub: 'running', since: T0, result: 'success' });
  const first = await w.game(0);

  // The agent's own stop: stopping at once, then the close; no new game connection while Factorio saves and goes.
  assert.equal((await w.request({ type: 'serviceAct', id: 's', action: 'stop' })).ok, true);
  await eventually(() => first.closed, 2000, 'the game connection closed');
  assert.deepEqual(types(first), ['hello', 'started', 'stopping']);
  w.client.status(READING); // the old Factorio still answers while it saves
  await w.unit({ active: 'deactivating', sub: 'stop-sigterm', since: T0 + 1000, result: 'success' });
  await w.unit({ active: 'inactive', sub: 'dead', since: T0 + 2000, result: 'success' });
  w.client.status(READING);
  await sleep(50);
  assert.equal(w.hub.of('hello').length, 1, 'no game connection until the next run');

  // A stop the agent didn't start (a console /quit, a stop by hand): RCON goes, the connection waits for the unit.
  await w.unit({ active: 'active', sub: 'running', since: T0 + 10_000, result: 'success' });
  const second = await w.game(1);
  w.client.down();
  await w.unit({ active: 'deactivating', sub: 'stop-sigterm', since: T0 + 20_000, result: 'success' });
  await sleep(50);
  assert.equal(second.closed, false, 'deactivating alone decides nothing');
  assert.deepEqual(types(second), ['hello', 'started']);
  await w.unit({ active: 'inactive', sub: 'dead', since: T0 + 21_000, result: 'success' });
  await eventually(() => second.closed, 2000, 'closed at the final state');
  assert.deepEqual(types(second), ['hello', 'started', 'stopping'], 'Result success: stopped');
  assert.deepEqual(w.hub.conns.flatMap((c) => c.invalid), []);
});

test('a crash passing through deactivating (stop-post) is reported as a crash: the close with no stopping', async (t) => {
  const w = await world(t);
  await w.unit({ active: 'active', sub: 'running', since: T0, result: 'success' });
  const first = await w.game(0);
  w.client.down(); // Factorio died: RCON is gone
  await w.unit({ active: 'deactivating', sub: 'stop-post', since: T0 + 1000, result: 'exit-code' });
  await sleep(50);
  assert.equal(first.closed, false, 'deactivating decides nothing, even with a failed Result');
  await w.unit({ active: 'activating', sub: 'auto-restart', since: T0 + 2000, result: 'exit-code' });
  await eventually(() => first.closed, 2000, 'closed at the auto-restart');
  assert.deepEqual(types(first), ['hello', 'started'], 'no stopping: a crash');

  // systemd's restart is a new run, announced again; one that ends failed (killed) is a crash too.
  await w.unit({ active: 'active', sub: 'running', since: T0 + 12_000, result: 'success' });
  const second = await w.game(1);
  w.client.down();
  await w.unit({ active: 'failed', sub: 'failed', since: T0 + 13_000, result: 'signal' });
  await eventually(() => second.closed, 2000, 'closed when failed');
  assert.deepEqual(types(second), ['hello', 'started']);
  assert.deepEqual(w.hub.conns.flatMap((c) => c.invalid), []);
});

test('RunWatch: a run ends at inactive, failed or an auto-restart, by Result; deactivating and a plain activating decide nothing', () => {
  const s = (active: string, sub: string, since: number, result = 'success'): UnitState => ({ unit: 'factorio.service', active, sub, since, result });
  const ends = (...states: UnitState[]) => {
    const w = new RunWatch();
    return states.map((st) => w.next(st));
  };
  assert.deepEqual(ends(s('active', 'running', 1), s('deactivating', 'stop-sigterm', 2), s('inactive', 'dead', 3)), [null, null, { how: 'stopped', since: 1 }]);
  assert.deepEqual(ends(s('active', 'running', 1), s('deactivating', 'stop-post', 2, 'exit-code'), s('activating', 'auto-restart', 3, 'exit-code')), [
    null,
    null,
    { how: 'crashed', since: 1 },
  ]);
  assert.deepEqual(ends(s('active', 'running', 1), s('activating', 'auto-restart-queued', 2, 'signal')), [null, { how: 'crashed', since: 1 }], 'newer systemd');
  assert.deepEqual(ends(s('active', 'running', 1), s('failed', 'failed', 2, 'timeout')), [null, { how: 'crashed', since: 1 }]);
  assert.deepEqual(ends(s('active', 'running', 1), s('inactive', 'dead', 2, 'exit-code')), [null, { how: 'crashed', since: 1 }], 'inactive, but not success');
  assert.deepEqual(ends(s('active', 'running', 1), s('active', 'running', 9)), [null, { how: 'stopped', since: 1 }], 'a restart between two readings');
  assert.deepEqual(ends(s('active', 'running', 1), s('activating', 'start', 2), s('active', 'running', 3)), [null, null, { how: 'stopped', since: 1 }]);
  assert.deepEqual(ends(s('inactive', 'dead', 1), s('activating', 'start', 2), s('failed', 'failed', 3, 'exit-code')), [null, null, null], 'no run seen: nothing to end');
  assert.deepEqual(ends(s('active', 'running', 1), s('active', 'running', 1), s('inactive', 'dead', 2), s('inactive', 'dead', 2)), [null, null, { how: 'stopped', since: 1 }, null], 'once');
});

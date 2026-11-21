// An Agent's service (`agentServicesHub`): its pushed state served and streamed, start, stop and restart as its
// `serviceAct`, its journal logs, a stop or a daily restart with a player online counting down in game first; a
// factorio server's console commands and logs through its Agent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AuditLog,
  CommandOutput,
  ServerCard,
  ServerDetail,
  ServerLog,
  ServerLogFiles,
  ServiceActionAnswer,
  ServiceLogs,
  ServiceStatus,
  TargetEvent,
} from '../src/api.ts';
import { until } from './fake-mod.ts';
import { ACTOR } from './web/web-hub.ts';
import { unstamped, post, webAudit, flush, eventually, agentServicesHub, asked } from './start-hub.ts';

test("an Agent's service: its pushed state is served and streamed, and start, stop and restart are its serviceAct, audited", async (t) => {
  const { app, cookie, get, agent, answer, live } = await agentServicesHub(t, []);
  const states: TargetEvent[] = [];
  live.on('event', (_, fed) => {
    const e = unstamped(fed);
    if ('target' in e && e.target === 'service' && e.id === 'factorio') states.push(e);
  });
  const service = async () => (await get<ServiceStatus[]>('/api/services')).find((s) => s.id === 'factorio');
  assert.deepEqual(await service(), { id: 'factorio', unit: 'factorio.service', state: null, sub: null, checks: [] });
  agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since: 1, result: 'success' });
  await until(() => states.length === 1);
  assert.deepEqual(await service(), { id: 'factorio', unit: 'factorio.service', state: 'active', sub: 'running', checks: [] });
  assert.deepEqual((await get<ServerCard[]>('/api/servers')).find((c) => c.id === 'space')!.service, { id: 'factorio', state: 'active' });
  agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since: 1, result: 'success' }); // no change
  agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'failed', sub: 'failed', since: 2, result: 'exit-code' });
  await until(() => states.length === 3);
  assert.deepEqual(states, [
    { target: 'service', id: 'factorio', type: 'state', state: 'active', sub: 'running' },
    { target: 'service', id: 'factorio', type: 'state', state: 'failed', sub: 'failed' },
    { target: 'service', id: 'factorio', type: 'notice', severity: 'problem', kind: 'serviceFailed', unit: 'factorio.service' },
  ]);

  // Nobody online: each acts at once.
  for (const action of ['start', 'stop', 'restart']) {
    const pending = post(app, cookie, `/api/services/factorio/${action}`);
    assert.deepEqual(asked(await answer()), { type: 'serviceAct', action });
    const res = await pending;
    assert.equal(res.status, 200, action);
    assert.deepEqual(await res.json(), { at: null } satisfies ServiceActionAnswer);
  }
  assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
    { actor: ACTOR, action: 'service restart', target: 'factorio', details: 'factorio.service' },
    { actor: ACTOR, action: 'service stop', target: 'factorio', details: 'factorio.service' },
    { actor: ACTOR, action: 'service start', target: 'factorio', details: 'factorio.service' },
  ]);

  const refused = post(app, cookie, '/api/services/factorio/start');
  const req = (await agent.next()) as { id: string };
  agent.send({ type: 'reply', id: req.id, ok: false, error: 'Access denied' });
  const res = await refused;
  assert.equal(res.status, 502);
  assert.equal(await res.text(), 'systemctl failed: Access denied');
});

test("an Agent's service logs are its journal request for the configured unit; 502 when the Agent can't answer", async (t) => {
  const { app, cookie, agent, answer } = await agentServicesHub(t, []);
  const logs = app.request('/api/services/factorio/logs', { headers: { cookie } });
  assert.deepEqual(asked(await answer({ lines: ['0.000 Factorio 2.1.24', '1.000 Loading map'] })), { type: 'journal', unit: 'factorio.service' });
  const res = await logs;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { lines: ['0.000 Factorio 2.1.24', '1.000 Loading map'] } satisfies ServiceLogs);
  agent.send({ type: 'bye' });
  await agent.closed;
  const gone = await app.request('/api/services/factorio/logs', { headers: { cookie } });
  assert.equal(gone.status, 502);
  assert.equal(await gone.text(), 'journalctl failed: agent vm is not connected');
});

test("stopping an Agent's service with a player online counts down in game through notices, then sends its serviceAct stop", async (t) => {
  const { app, cookie, get, game, agentGot, gameGot, answer } = await agentServicesHub(t, ['Ann']);
  t.mock.timers.enable({ apis: ['setTimeout'] }); // after the Agent connected: its silence timer stays real
  try {
    const res = await post(app, cookie, '/api/services/factorio/stop');
    assert.equal(res.status, 200);
    const { at } = (await res.json()) as ServiceActionAnswer;
    assert.ok(at! > Date.now());
    assert.deepEqual((await get<ServerCard[]>('/api/servers')).find((c) => c.id === 'space')!.restart, { at, by: 'alex', stop: true });
    t.mock.timers.tick(0);
    assert.deepEqual(await game.next(), { type: 'notice', message: 'Server stopping in 5 minutes' });
    await flush();
    assert.deepEqual(agentGot, []); // nothing until the countdown ends
    t.mock.timers.tick(5 * 60_000);
    assert.deepEqual(
      [await game.next(), await game.next(), await game.next()],
      ['1 minute', '30 seconds', '10 seconds'].map((left) => ({ type: 'notice', message: `Server stopping in ${left}` })),
    );
    await eventually(async () => agentGot.length === 1);
    assert.deepEqual(asked(await answer()), { type: 'serviceAct', action: 'stop' });
    await flush();
    assert.equal(agentGot.length, 1);
    assert.ok(!gameGot.some((m) => (m as { type: string }).type === 'cmd')); // never the game's own stop
    assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
      { actor: ACTOR, action: 'service stop', target: 'factorio', details: 'factorio.service, after a 5 min countdown' },
    ]);
  } finally {
    t.mock.timers.reset(); // before the hub closes: closing waits on real timers
  }
});

test('a daily restart of a factorio server with a player online is one countdown, then one restart of its service, never a stop', async (t) => {
  const { get, game, agentGot, gameGot, answer, restarts } = await agentServicesHub(t, ['Ann']);
  t.mock.timers.enable({ apis: ['setTimeout'] }); // after the Agent connected: its silence timer stays real
  try {
    // Due in 11 to 12 minutes: its 10-minute countdown starts within the next 2.
    const due = new Date(Date.now() + 12 * 60_000);
    restarts.daily('space', `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`);
    t.mock.timers.tick(2 * 60_000);
    t.mock.timers.tick(0);
    assert.deepEqual(await game.next(), { type: 'notice', message: 'Server restarting in 10 minutes' });
    t.mock.timers.tick(10 * 60_000);
    const countdown = ['5 minutes', '1 minute', '30 seconds', '10 seconds'].map((left) => ({ type: 'notice', message: `Server restarting in ${left}` }));
    assert.deepEqual([await game.next(), await game.next(), await game.next(), await game.next()], countdown);
    await eventually(async () => agentGot.length === 1); // at once, not after a second countdown
    assert.deepEqual(asked(await answer()), { type: 'serviceAct', action: 'restart' });
    const hubAudit = async () => (await get<AuditLog>('/api/audit')).entries.filter((e) => e.actor === 'hub:daily').map(({ ts: _, id: __, ...e }) => e);
    await eventually(async () => (await hubAudit()).length === 2); // the reply is in, before time moves on
    // Nothing more: no second countdown (the player is still online), no other request, no stop in game.
    t.mock.timers.tick(15 * 60_000);
    await flush();
    assert.deepEqual(agentGot.map(asked), [{ type: 'serviceAct', action: 'restart' }]);
    assert.deepEqual(gameGot, [{ type: 'notice', message: 'Server restarting in 10 minutes' }, ...countdown]);
    assert.equal((await get<ServerCard[]>('/api/servers')).find((c) => c.id === 'space')!.restart, null);
    assert.deepEqual(await hubAudit(), [
      { actor: 'hub:daily', action: 'service restart', target: 'factorio', details: 'factorio.service' },
      { actor: 'hub:daily', action: 'restart', target: 'space', details: 'in 10 min' },
    ]);
  } finally {
    t.mock.timers.reset(); // before the hub closes: closing waits on real timers
  }
});

test("a factorio server's console command keeps its leading slash; control characters are still taken out", async (t) => {
  const { app, cookie, game } = await agentServicesHub(t, []);
  const pending = post(app, cookie, '/api/servers/space/command', { command: ' /players\u0007online ' });
  const cmd = (await game.next()) as { id: string; command: string };
  assert.equal(cmd.command, '/players online');
  game.send({ type: 'cmdResult', id: cmd.id, output: ['Online players (1):', '  Ann (online)'] });
  assert.deepEqual(await (await pending).json(), { output: ['Online players (1):', '  Ann (online)'] } satisfies CommandOutput);
});

test("a factorio console command over the Agent's 256 characters is refused with why, before it is audited or sent", async (t) => {
  const { app, cookie, get, game } = await agentServicesHub(t, []);
  const long = `/c ${'x'.repeat(254)}`; // 257
  const res = await post(app, cookie, '/api/servers/space/command', { command: ` ${long}\u0007 ` }); // what is cut is not counted
  assert.equal(res.status, 400);
  assert.equal(await res.text(), 'A Factorio console command is at most 256 characters');
  assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')).filter((e) => e.action === 'command'), []);
  const pending = post(app, cookie, '/api/servers/space/command', { command: long.slice(0, 256) });
  const cmd = (await game.next()) as { id: string; command: string }; // the first the game connection gets
  assert.equal(cmd.command, long.slice(0, 256));
  game.send({ type: 'cmdResult', id: cmd.id, output: [] });
  assert.equal((await pending).status, 200);
});

test("a factorio server's logs are the files its Agent serves, newest first; a log is read only by a name it lists", async (t) => {
  const { app, cookie, get, agent, agentGot, answer } = await agentServicesHub(t, []);
  const request = (path: string) => app.request(path, { headers: { cookie } });
  assert.equal((await get<ServerDetail>('/api/servers/space')).logs, true);
  const files = [
    { name: 'agent.log', size: 10, modified: 2 },
    { name: 'factorio-current.log', size: 30, modified: 3 },
    { name: 'factorio-previous.log', size: 20, modified: 1 },
  ];
  const listing = request('/api/servers/space/logs');
  assert.deepEqual(asked(await answer({ files })), { type: 'logs' });
  assert.deepEqual(await (await listing).json(), [files[1], files[0], files[2]] satisfies ServerLogFiles);

  const tail = request('/api/servers/space/logs/factorio-current.log');
  assert.deepEqual(asked(await answer({ files })), { type: 'logs' });
  assert.deepEqual(asked(await answer({ lines: ['0.000 Factorio 2.1.24'] })), { type: 'log', name: 'factorio-current.log' });
  assert.deepEqual(await (await tail).json(), { lines: ['0.000 Factorio 2.1.24'] } satisfies ServerLog);

  for (const name of ['..%2F..%2Fetc%2Fpasswd', 'server-settings.json']) {
    const unlisted = request(`/api/servers/space/logs/${name}`);
    assert.deepEqual(asked(await answer({ files })), { type: 'logs' });
    assert.equal((await unlisted).status, 404, name);
  }
  await flush();
  assert.equal(agentGot.filter((r) => (r as { type: string }).type === 'log').length, 1); // never asked for an unlisted name

  agent.send({ type: 'bye' });
  await agent.closed;
  const gone = await request('/api/servers/space/logs');
  assert.equal(gone.status, 502);
  assert.equal(await gone.text(), 'Listing the logs failed: agent vm is not connected');
  assert.equal((await request('/api/servers/space/logs/agent.log')).status, 502);
});

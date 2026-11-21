// Service actions from the dashboard (`actionsHub`: `gtnh` runs as the service `gtnh`, `caddy` is linked to nothing):
// start, stop and restart through systemctl, audited; 404, 403 and 502; a stop with nobody online is immediate, with
// players online it counts down in game first.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AuditLog, ServerCard, ServiceActionAnswer } from '../src/api.ts';
import { startHub } from '../src/start.ts';
import { online, sleep } from './fake-mod.ts';
import { ACTOR, config, loginCookie, WEB } from './web/web-hub.ts';
import { MINECRAFT, post, webAudit, UNITS, fakeSystemd } from './start-hub.ts';

/** A Minecraft + web hub whose server `gtnh` runs as the service `gtnh`; `caddy` is linked to nothing. */
async function actionsHub(t: TestContext) {
  const cfg = config(t, { minecraft: MINECRAFT, web: WEB, systemd: UNITS });
  delete cfg.healthcheckUrl;
  cfg.servers = [{ ...cfg.servers[0]!, service: 'gtnh' }];
  const systemd = fakeSystemd();
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
    run: systemd.run,
  });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  const get = async <T>(path: string) => (await app.request(path, { headers: { cookie } })).json() as Promise<T>;
  /** The start/stop/restart calls systemctl got. */
  const actions = () => systemd.calls.filter((c) => c[0] === 'systemctl' && c[1] !== 'show');
  return { app, cookie, get, systemd, actions, port: handle.port! };
}

test('start, stop and restart each run systemctl once, without blocking, and are audited', async (t) => {
  const { app, cookie, get, actions } = await actionsHub(t);
  for (const verb of ['start', 'stop', 'restart']) {
    const res = await post(app, cookie, `/api/services/caddy/${verb}`);
    assert.equal(res.status, 200, verb);
    assert.deepEqual(await res.json(), { at: null } satisfies ServiceActionAnswer);
  }
  assert.equal((await post(app, cookie, '/api/services/gtnh/stop')).status, 200); // its server is offline: at once
  assert.deepEqual(actions(), [
    ['systemctl', 'start', '--no-block', '--', 'caddy.service'],
    ['systemctl', 'stop', '--no-block', '--', 'caddy.service'],
    ['systemctl', 'restart', '--no-block', '--', 'caddy.service'],
    ['systemctl', 'stop', '--no-block', '--', 'gtnh.service'],
  ]);
  assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
    { actor: ACTOR, action: 'service stop', target: 'gtnh', details: 'gtnh.service' },
    { actor: ACTOR, action: 'service restart', target: 'caddy', details: 'caddy.service' },
    { actor: ACTOR, action: 'service stop', target: 'caddy', details: 'caddy.service' },
    { actor: ACTOR, action: 'service start', target: 'caddy', details: 'caddy.service' },
  ]);
});

test('an action on an unlisted service is 404 and never run, one that is no verb 403; a failing systemctl is 502', async (t) => {
  const { app, cookie, systemd, actions } = await actionsHub(t);
  for (const path of ['nope/stop', 'gtnh.service/stop', 'toString/start']) {
    assert.equal((await post(app, cookie, `/api/services/${path}`)).status, 404, path);
  }
  // No route, so no permission rule: the default deny refuses them before routing.
  for (const path of ['gtnh/kill', 'gtnh/logs']) assert.equal((await post(app, cookie, `/api/services/${path}`)).status, 403, path);
  assert.deepEqual(actions(), []);
  assert.equal((await post(app, cookie, '/api/services/caddy/stop', undefined, { origin: 'https://evil.example' })).status, 403);
  systemd.fails = true;
  const res = await post(app, cookie, '/api/services/caddy/restart');
  assert.equal(res.status, 502);
  assert.equal(await res.text(), 'systemctl failed: permission denied');
});

test('stopping a service whose server has nobody online is immediate', async (t) => {
  const { app, cookie, actions, port } = await actionsHub(t);
  const mod = await online(port);
  mod.send({ type: 'heartbeat', tps: 20, players: [] });
  await sleep(20);
  assert.deepEqual(await (await post(app, cookie, '/api/services/gtnh/stop')).json(), { at: null });
  assert.deepEqual(actions(), [['systemctl', 'stop', '--no-block', '--', 'gtnh.service']]);
});

test('stopping a service whose server has players online counts down in game first, then stops it for good', async (t) => {
  const { app, cookie, get, actions, port } = await actionsHub(t);
  const mod = await online(port);
  mod.send({ type: 'heartbeat', tps: 20, players: ['Steve'] });
  await sleep(20);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    /** Answers the mod's next command and returns it. */
    const command = async () => {
      const cmd = (await mod.next()) as { id: string; command: string };
      mod.send({ type: 'cmdResult', id: cmd.id, output: [] });
      return cmd.command;
    };

    const res = await post(app, cookie, '/api/services/gtnh/stop');
    assert.equal(res.status, 200);
    const { at } = (await res.json()) as ServiceActionAnswer;
    assert.ok(at! > Date.now());
    assert.deepEqual((await get<ServerCard[]>('/api/servers'))[0]!.restart, { at, by: 'alex', stop: true });
    assert.equal((await post(app, cookie, '/api/services/gtnh/restart')).status, 409); // one countdown at a time
    t.mock.timers.tick(0);
    assert.equal(await command(), 'say Server stopping in 5 minutes');
    assert.deepEqual(actions(), []);
    t.mock.timers.tick(5 * 60_000);
    assert.deepEqual(
      [await command(), await command(), await command()],
      ['say Server stopping in 1 minute', 'say Server stopping in 30 seconds', 'say Server stopping in 10 seconds'],
    );
    await new Promise((r) => setImmediate(r)); // setTimeout is mocked here
    assert.deepEqual(actions(), [['systemctl', 'stop', '--no-block', '--', 'gtnh.service']]); // not `stop` in game
    // systemd's ExecStop saves and stops the server; nothing brings it back.
    mod.send({ type: 'stopping' });
    mod.socket.end();
    await mod.closed;
    t.mock.timers.tick(60 * 60_000);
    await new Promise((r) => setImmediate(r)); // setTimeout is mocked here
    assert.equal(actions().length, 1);
    assert.equal((await get<ServerCard[]>('/api/servers'))[0]!.restart, null);
    assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
      { actor: ACTOR, action: 'service stop', target: 'gtnh', details: 'gtnh.service, after a 5 min countdown' },
    ]);
  } finally {
    t.mock.timers.reset(); // before the hub closes: closing waits on real timers
  }
});

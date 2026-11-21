// The systemd integration's watch (`servicesHub`, two services and a check linked to `caddy`): state served with linked
// checks, a state change as one live event (a failure also a notice), recent logs from journald (502 when journalctl
// fails); nothing run without systemd.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { CheckStatus, Integrations, ServiceLogs, ServiceStatus, TargetEvent } from '../src/api.ts';
import { startHub } from '../src/start.ts';
import { until } from './fake-mod.ts';
import { config, loginCookie, WEB } from './web/web-hub.ts';
import { unstamped, SITE, UP, UNITS, fakeSystemd } from './start-hub.ts';

/** A web hub watching two services, with a check linked to `caddy`. `next` runs one watch round. */
async function servicesHub(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, { web: WEB, systemd: UNITS, checks: [{ ...SITE, service: 'caddy' }] });
  delete cfg.healthcheckUrl;
  const systemd = fakeSystemd();
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: async () => UP,
    run: systemd.run,
  });
  t.after(() => handle.close());
  const events: TargetEvent[] = [];
  handle.live.on('event', (_, fed) => {
    const e = unstamped(fed);
    if ('target' in e && e.target === 'service') events.push(e);
  });
  const shows = () => systemd.calls.filter((c) => c[0] === 'systemctl').length;
  await until(() => shows() === 2);
  const next = async () => {
    const n = shows() + 2;
    t.mock.timers.tick(5_000);
    await until(() => shows() === n);
    await new Promise((r) => setImmediate(r));
  };
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  const request = (path: string) => app.request(path, { headers: { cookie } });
  return { systemd, events, next, request };
}

test('services: state is served with linked checks, and a check names its service', async (t) => {
  const { request } = await servicesHub(t);
  assert.deepEqual(await (await request('/api/services')).json(), [
    { id: 'gtnh', unit: 'gtnh.service', state: 'active', sub: 'running', checks: [] },
    { id: 'caddy', unit: 'caddy.service', state: 'active', sub: 'running', checks: ['site'] },
  ] satisfies ServiceStatus[]);
  assert.equal(((await (await request('/api/checks')).json()) as CheckStatus[])[0]!.service, 'caddy');
  assert.equal(((await (await request('/api/integrations')).json()) as Integrations).systemd, true);
});

test('a service state change is one live event, and a failure is also a notice', async (t) => {
  const { systemd, events, next, request } = await servicesHub(t);
  await next();
  assert.deepEqual(events, []);
  systemd.states['gtnh.service'] = ['inactive', 'dead'];
  await next();
  await next();
  assert.deepEqual(events, [{ target: 'service', id: 'gtnh', type: 'state', state: 'inactive', sub: 'dead' }]);
  systemd.states['gtnh.service'] = ['failed', 'failed'];
  await next();
  assert.deepEqual(events.slice(1), [
    { target: 'service', id: 'gtnh', type: 'state', state: 'failed', sub: 'failed' },
    { target: 'service', id: 'gtnh', type: 'notice', severity: 'problem', kind: 'serviceFailed', unit: 'gtnh.service' },
  ]);
  assert.equal(((await (await request('/api/services')).json()) as ServiceStatus[])[0]!.state, 'failed');
});

test("a service's recent logs come from journald; an unlisted id is 404 and never run", async (t) => {
  const { systemd, request } = await servicesHub(t);
  const res = await request('/api/services/gtnh/logs');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    lines: ['2026-09-27T10:00:00+0000 host gtnh[1]: one', '2026-09-27T10:00:01+0000 host gtnh[1]: two'],
  } satisfies ServiceLogs);
  assert.deepEqual(systemd.calls.at(-1), ['journalctl', '--unit=gtnh.service', '--lines=200', '--no-pager', '--output=short-iso']);
  for (const id of ['nope', 'gtnh.service', '..', 'toString']) {
    assert.equal((await request(`/api/services/${id}/logs`)).status, 404, id);
  }
  assert.deepEqual(new Set(systemd.units()), new Set(['gtnh.service', 'caddy.service']));
});

test('logs answer 502 when journalctl fails', async (t) => {
  const { systemd, request } = await servicesHub(t);
  systemd.fails = true;
  const res = await request('/api/services/gtnh/logs');
  assert.equal(res.status, 502);
  assert.equal(await res.text(), 'journalctl failed: permission denied');
});

test('without systemd nothing is run and there is no services API', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const handle = await startHub(config(t, { web: WEB }), {
    startFrontend: () => assert.fail('Discord is off'),
    get: async () => UP,
    run: () => assert.fail('nothing to run'),
  });
  t.after(() => handle.close());
  t.mock.timers.tick(60 * 60_000);
  const cookie = await loginCookie(handle.web!);
  assert.equal((await handle.web!.app.request('/api/services', { headers: { cookie } })).status, 404);
  const on = (await (await handle.web!.app.request('/api/integrations', { headers: { cookie } })).json()) as Integrations;
  assert.equal(on.systemd, false);
});

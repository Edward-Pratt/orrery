// The permission each route needs (`src/web/permit.ts`) on a whole hub with two servers (`gtnh`, linked to the
// `gtnh` service, and `tfc`) and an unlinked service (`caddy`): a viewer's writes are 403 naming what is missing and
// never run, the three gated reads too (HEAD as GET), the default deny for a write without a rule; an operator
// scoped to `gtnh` acts on `gtnh` and its service only; an owner passes every rule.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Me, RoleView } from '../../src/api.ts';
import type { Run } from '../../src/services/services.ts';
import { startHub } from '../../src/start.ts';
import { config, dashboard, loginAs, WEB } from './web-hub.ts';

/** A web and systemd hub; `acted` lists the systemctl actions run. */
async function permitHub(t: TestContext) {
  const cfg = config(t, { web: WEB, systemd: [{ id: 'gtnh', unit: 'gtnh.service' }, { id: 'caddy', unit: 'caddy.service' }] });
  delete cfg.healthcheckUrl;
  cfg.servers = [{ ...cfg.servers[0]!, service: 'gtnh' }, { ...cfg.servers[0]!, id: 'tfc', name: 'TFC' }];
  const acted: string[] = [];
  const run: Run = async (command, args) => {
    if (command === 'journalctl') return '2026-11-06T10:00:00+0000 host unit[1]: a line\n';
    if (args[0] !== 'show') acted.push(`${args[0]} ${args.at(-1)}`);
    return 'ActiveState=inactive\nSubState=dead\n';
  };
  const handle = await startHub(cfg, { startFrontend: () => assert.fail('Discord is off'), get: () => assert.fail('nothing to request'), run });
  t.after(() => handle.close());
  const web = handle.web!;
  const owner = await loginAs(web);
  const roles = (await (await web.app.request('/api/roles', { headers: { cookie: owner.cookie } })).json()) as RoleView[];
  const role = (name: string) => roles.find((r) => r.name === name)!.id;
  /** Sends a request as `cookie`'s user; answers the status and text. */
  const call = async (cookie: string, method: string, path: string, body: object = {}) => {
    const res = await web.app.request(`/api${path}`, { method, headers: dashboard(cookie), body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body) });
    return [res.status, await res.text()] as const;
  };
  return { web, owner, role, call, acted };
}

test("a viewer's writes are 403 naming the permission and never run; reads but three pass", async (t) => {
  const { web, role, call, acted } = await permitHub(t);
  const { cookie } = await loginAs(web, { username: 'vic', grants: [{ roleId: role('Viewer') }] });
  const refused: [string, string, string][] = [
    ['POST', '/servers/gtnh/chat', 'Needs servers.chat on gtnh'],
    ['POST', '/servers/gtnh/command', 'Needs servers.console on gtnh'],
    ['POST', '/servers/gtnh/restart', 'Needs servers.control on gtnh'],
    ['POST', '/servers/gtnh/restore', 'Needs servers.restore on gtnh'],
    ['PUT', '/servers/gtnh/pack/runtime', 'Needs servers.pack on gtnh'],
    ['POST', '/servers/gtnh/moderation', 'Needs servers.moderation on gtnh'],
    ['POST', '/services/gtnh/stop', 'Needs services.control on gtnh'],
    ['POST', '/services/caddy/stop', 'Needs services.control'],
    ['POST', '/deploys', 'Needs deploys'],
    ['DELETE', '/library/packs/1', 'Needs library'],
    ['POST', '/uploads', 'Needs library, or servers.control on a server'],
    ['POST', '/users', 'Needs users'],
    ['POST', '/roles', 'Needs an owner'],
    ['POST', '/nothing-here', 'No permission allows this request'],
    ['PATCH', '/servers/gtnh', 'No permission allows this request'],
    ['GET', '/audit', 'Needs audit'],
    ['GET', '/servers/gtnh/logs', 'Needs servers.logs on gtnh'],
    ['GET', '/servers/gtnh/logs/latest.log', 'Needs servers.logs on gtnh'],
    ['GET', '/servers/gtnh/settings', 'Needs servers.settings on gtnh'],
    ['GET', '/services/gtnh/logs', 'Needs services.logs on gtnh'],
    ['GET', '/users', 'Needs users'],
  ];
  for (const [method, path, why] of refused) assert.deepEqual(await call(cookie, method, path), [403, why], `${method} ${path}`);
  assert.equal((await call(cookie, 'HEAD', '/audit'))[0], 403);
  assert.deepEqual(acted, []);
  for (const path of ['/servers', '/servers/gtnh', '/services', '/integrations', '/me']) assert.equal((await call(cookie, 'GET', path))[0], 200, path);
  assert.deepEqual(JSON.parse((await call(cookie, 'GET', '/me'))[1]).permissions, []);
  assert.equal((await call(cookie, 'POST', '/logout'))[0], 204); // the session alone
});

test('an operator scoped to gtnh acts on gtnh and its linked service, and nowhere else', async (t) => {
  const { web, role, call, acted } = await permitHub(t);
  const { cookie } = await loginAs(web, { username: 'oli', grants: [{ roleId: role('Operator'), servers: ['gtnh'] }] });
  const me = JSON.parse((await call(cookie, 'GET', '/me'))[1]) as Me;
  const held = ['servers.chat', 'servers.control', 'servers.moderation', 'services.control', 'services.logs'];
  assert.deepEqual(me.permissions, held.map((permission) => ({ permission, servers: ['gtnh'] })));
  assert.deepEqual(await call(cookie, 'POST', '/servers/gtnh/restart', { minutes: 5 }), [409, 'GTNH is offline']); // past the rule
  assert.deepEqual(await call(cookie, 'POST', '/servers/tfc/restart', { minutes: 5 }), [403, 'Needs servers.control on tfc']);
  assert.equal((await call(cookie, 'POST', '/services/gtnh/start'))[0], 200);
  assert.equal((await call(cookie, 'GET', '/services/gtnh/logs'))[0], 200);
  assert.deepEqual(await call(cookie, 'POST', '/services/caddy/restart'), [403, 'Needs services.control']);
  assert.deepEqual(await call(cookie, 'GET', '/services/caddy/logs'), [403, 'Needs services.logs']);
  assert.deepEqual(acted, ['start gtnh.service']);
  assert.equal((await call(cookie, 'POST', '/uploads'))[0], 404); // a save's upload: past the rule (no uploads on this hub)
  assert.deepEqual(await call(cookie, 'POST', '/servers/gtnh/command'), [403, 'Needs servers.console on gtnh']);
  assert.deepEqual(await call(cookie, 'GET', '/audit'), [403, 'Needs audit']);
});

test('an owner passes every rule', async (t) => {
  const { owner, call, acted } = await permitHub(t);
  assert.equal((await call(owner.cookie, 'POST', '/services/caddy/restart'))[0], 200);
  assert.equal((await call(owner.cookie, 'GET', '/audit'))[0], 200);
  assert.equal((await call(owner.cookie, 'GET', '/servers/gtnh/settings'))[0], 404); // no game settings here: past the rule
  assert.deepEqual(await call(owner.cookie, 'POST', '/servers/tfc/restart', { minutes: 5 }), [409, 'TFC is offline']);
  assert.deepEqual(acted, ['restart caddy.service']);
});

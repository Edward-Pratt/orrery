// The reads without a session (`src/web/web-public.ts`): the Status page's `GET /api/public/status` (only the listed
// servers, in order, field by field, kept 15 s; without `integrations.web.status` it is unknown, so 401 like any route
// behind the session), the state it shows
// (`publicState`), and that every other route still needs a session.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { PublicStatus } from '../../src/api.ts';
import { startHub } from '../../src/start.ts';
import { publicState } from '../../src/web/web-public.ts';
import { online, TOKEN, until } from '../fake-mod.ts';
import { config, fakeOAuth, WEB, webHub } from './web-hub.ts';

const FIELDS = ['game', 'name', 'players', 'state', 'uptimeMonth', 'uptimeWeek'];

/** A hub with the Mod port and the Status page listing `tfc` then `gtnh`; `hidden` is configured but not listed. */
async function statusHub(t: TestContext) {
  const cfg = config(t, { minecraft: { listenPort: 0, tokens: { gtnh: TOKEN } }, web: { ...WEB, status: { servers: ['tfc', 'gtnh'] } } });
  const [gtnh] = cfg.servers;
  cfg.servers.push({ ...gtnh!, id: 'hidden', name: 'Hidden' }, { ...gtnh!, id: 'tfc', name: 'TerraFirmaCraft' });
  const handle = await startHub(cfg, { startFrontend: () => assert.fail('Discord is off'), get: async () => ({ ok: true, status: 200 }), oauth: fakeOAuth().oauth });
  t.after(() => handle.close());
  return { app: handle.web!.app, port: handle.port!, live: handle.live };
}

test('publicState: down when offline, hung, paused, else up', () => {
  assert.equal(publicState({ online: false, hung: true, paused: true }), 'down');
  assert.equal(publicState({ online: true, hung: true, paused: true }), 'hung');
  assert.equal(publicState({ online: true, hung: false, paused: true }), 'paused');
  assert.equal(publicState({ online: true, hung: false, paused: false }), 'up');
});

test('the Status page answers without a session: the listed servers only, in order, with exactly its six fields', async (t) => {
  const { app } = await statusHub(t);
  const res = await app.request('/api/public/status');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=15');
  const { servers } = (await res.json()) as PublicStatus;
  assert.deepEqual(servers.map((s) => s.name), ['TerraFirmaCraft', 'GTNH']);
  for (const s of servers) assert.deepEqual(Object.keys(s).sort(), FIELDS);
  assert.deepEqual(servers[1], { name: 'GTNH', game: 'minecraft', state: 'down', players: [], uptimeWeek: null, uptimeMonth: null });
});

test('the Status page keeps its answer for 15 s: a server that came up since still reads as before', async (t) => {
  const { app, port, live } = await statusHub(t);
  const state = async () => ((await (await app.request('/api/public/status')).json()) as PublicStatus).servers[1]!.state;
  assert.equal(await state(), 'down');
  await online(port);
  await until(() => live.since().some(([, e]) => 'serverId' in e && e.serverId === 'gtnh' && e.type === 'connected'));
  assert.equal(await state(), 'down');
});

test('without integrations.web.status there is no Status page, and every other read but the Environment still needs a session', async (t) => {
  const app = await webHub(t, fakeOAuth().oauth);
  assert.equal((await app.request('/api/public/status')).status, 401);
  assert.equal((await app.request('/api/environment')).status, 200);
  assert.equal((await app.request('/api/servers')).status, 401);
});

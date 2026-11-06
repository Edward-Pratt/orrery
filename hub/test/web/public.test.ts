// The reads without a session (`src/web/web-public.ts`): the Status page's `GET /api/public/status` (only the listed
// servers, in order, field by field; kept 15 s, checked on an injected clock; without `integrations.web.status` it is
// an unknown path, so 401 like any route behind the session), the state it shows (`publicState`), and that every
// other route still needs a session.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Hono } from 'hono';
import type { PublicStatus } from '../../src/api.ts';
import type { ServerHub, ServerState } from '../../src/servers/servers.ts';
import { startHub } from '../../src/start.ts';
import type { Stats } from '../../src/stats/stats.ts';
import { publicRoutes, publicState } from '../../src/web/web-public.ts';
import type { Env } from '../../src/web/web.ts';
import { TOKEN } from '../fake-mod.ts';
import { config, WEB, webHub } from './web-hub.ts';

const FIELDS = ['game', 'name', 'players', 'state', 'uptimeMonth', 'uptimeWeek'];

/** A hub with the Mod port and the Status page listing `tfc` then `gtnh`; `hidden` is configured but not listed. */
async function statusHub(t: TestContext) {
  const cfg = config(t, { minecraft: { listenPort: 0, tokens: { gtnh: TOKEN } }, web: { ...WEB, status: { servers: ['tfc', 'gtnh'] } } });
  const [gtnh] = cfg.servers;
  cfg.servers.push({ ...gtnh!, id: 'hidden', name: 'Hidden' }, { ...gtnh!, id: 'tfc', name: 'TerraFirmaCraft' });
  const handle = await startHub(cfg, { startFrontend: () => assert.fail('Discord is off'), get: async () => ({ ok: true, status: 200 }) });
  t.after(() => handle.close());
  return handle.web!.app;
}

test('publicState: down when offline, hung, paused, else up', () => {
  assert.equal(publicState({ online: false, hung: true, paused: true }), 'down');
  assert.equal(publicState({ online: true, hung: true, paused: true }), 'hung');
  assert.equal(publicState({ online: true, hung: false, paused: true }), 'paused');
  assert.equal(publicState({ online: true, hung: false, paused: false }), 'up');
});

test('the Status page answers without a session: the listed servers only, in order, with exactly its six fields', async (t) => {
  const app = await statusHub(t);
  const res = await app.request('/api/public/status');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=15');
  const { servers } = (await res.json()) as PublicStatus;
  assert.deepEqual(servers.map((s) => s.name), ['TerraFirmaCraft', 'GTNH']);
  for (const s of servers) assert.deepEqual(Object.keys(s).sort(), FIELDS);
  assert.deepEqual(servers[1], { name: 'GTNH', game: 'minecraft', state: 'down', players: [], uptimeWeek: null, uptimeMonth: null });
});

test('the Status page keeps its answer for 15 s, then reads the servers and their uptime afresh', async () => {
  const server: ServerState = { id: 'gtnh', name: 'GTNH', game: 'minecraft', online: false, hung: false, paused: false, tps: null, players: [], dims: [] };
  const hub = { get: (id: string) => (id === 'gtnh' ? server : undefined) } as unknown as ServerHub;
  const asked: number[] = [];
  const stats = { uptime: (_id: string, days: number) => (asked.push(days), 0.5) } as unknown as Stats;
  let clock = 1_000_000;
  const app = new Hono<Env>().basePath('/api');
  publicRoutes(app, { environment: 'production', status: { servers: ['gtnh'] }, hub, stats }, () => clock);
  const read = async () => ((await (await app.request('/api/public/status')).json()) as PublicStatus).servers[0]!;
  assert.deepEqual(await read(), { name: 'GTNH', game: 'minecraft', state: 'down', players: [], uptimeWeek: 0.5, uptimeMonth: 0.5 });
  assert.deepEqual(asked, [7, 30]);
  Object.assign(server, { online: true, players: ['Steve'] });
  clock += 14_999;
  assert.equal((await read()).state, 'down');
  assert.deepEqual(asked, [7, 30]);
  clock += 1;
  assert.deepEqual(await read(), { name: 'GTNH', game: 'minecraft', state: 'up', players: ['Steve'], uptimeWeek: 0.5, uptimeMonth: 0.5 });
  assert.deepEqual(asked, [7, 30, 7, 30]);
});

test('without integrations.web.status there is no Status page, and every other read but the Environment still needs a session', async (t) => {
  const { app } = await webHub(t);
  assert.equal((await app.request('/api/public/status')).status, 401);
  assert.equal((await app.request('/api/environment')).status, 200);
  assert.equal((await app.request('/api/servers')).status, 401);
});

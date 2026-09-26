import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { Config } from '../src/config.ts';
import type { HubEvent } from '../src/servers.ts';
import { startHub } from '../src/start.ts';
import type { OAuth, WebApi } from '../src/web.ts';
import { online, TOKEN, until } from './fake-mod.ts';

const MINECRAFT = { listenPort: 0, tokens: { gtnh: TOKEN } };
const DISCORD = { guildId: '1'.repeat(18), adminRoleId: '2'.repeat(18), channels: { gtnh: '3'.repeat(18) } };

function config(t: TestContext, integrations: Config['integrations']): Config {
  const dir = mkdtempSync(join(tmpdir(), 'hub-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dbPath: join(dir, 'hub.db'),
    healthcheckUrl: 'https://example.invalid/ping',
    servers: [
      { id: 'gtnh', name: 'GTNH', backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' },
    ],
    integrations,
  };
}

/** The mod lifecycle rows the hub wrote, read after it closed its database. */
function lifecycle(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT state, reason FROM events WHERE reason = 'connected'").all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

test('a started hub relays mod chat to the frontend and shuts down cleanly', async (t) => {
  const cfg = config(t, { minecraft: MINECRAFT, discord: DISCORD });
  const seen: HubEvent[] = [];
  let given: unknown;
  let stopped = false;
  const handle = await startHub(cfg, {
    startFrontend: async (hub, _stats, _restarts, _links, discord) => {
      given = discord;
      hub.on('event', (e) => seen.push(e));
      return { stop: () => void (stopped = true) };
    },
    get: () => assert.fail('no ping within a test'),
  });
  assert.deepEqual(given, DISCORD);
  assert.ok(handle.port);

  const mod = await online(handle.port);
  mod.send({ type: 'chat', player: 'Steve', message: 'hi' });
  await until(() => seen.some((e) => e.type === 'chat'));
  assert.deepEqual(
    seen.find((e) => e.type === 'chat'),
    { type: 'chat', serverId: 'gtnh', player: 'Steve', message: 'hi' },
  );

  await handle.close();
  assert.ok(stopped);
  await mod.closed;
  await assert.rejects(
    new Promise((resolve, reject) => connect(handle.port!, '127.0.0.1').on('connect', resolve).on('error', reject)),
    /ECONNREFUSED/,
  );
  assert.deepEqual(lifecycle(cfg.dbPath), [{ state: 'up', reason: 'connected' }]);
});

test('with Discord off the hub starts no frontend, still records mods, and pings while it runs', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, { minecraft: MINECRAFT });
  const pings: string[] = [];
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: async (url) => {
      pings.push(url);
      return { ok: true, status: 200 };
    },
  });
  const mod = await online(handle.port!);
  t.mock.timers.tick(60_000);
  assert.deepEqual(pings, ['https://example.invalid/ping']);
  await handle.close();
  await mod.closed;
  assert.deepEqual(lifecycle(cfg.dbPath), [{ state: 'up', reason: 'connected' }]);
});

test('with Minecraft off the hub opens no mod port', async (t) => {
  const handle = await startHub(config(t, { discord: DISCORD }), {
    startFrontend: async () => ({ stop: () => {} }),
    get: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(handle.port, undefined);
  await handle.close();
});

test('startup with Discord configured and no DISCORD_TOKEN fails with a clear message', (t) => {
  const cfg = config(t, { discord: DISCORD });
  const path = join(dirname(cfg.dbPath), 'config.json');
  writeFileSync(path, JSON.stringify({ ...cfg, servers: [{ id: 'gtnh', name: 'GTNH' }] }));
  const env = { ...process.env };
  delete env.DISCORD_TOKEN;
  assert.throws(
    () => execFileSync(process.execPath, ['src/index.ts', path], { env, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 }),
    (err: { status: number; stderr: string }) =>
      err.status === 1 && /integrations\.discord is configured but DISCORD_TOKEN is not set/.test(err.stderr),
  );
});

const WEB = { listenPort: 0, publicUrl: 'https://dash.orrery.run', clientId: '4'.repeat(18), sessionDays: 7 };
const ADMIN = { id: '5'.repeat(18), username: 'alex', roles: ['9'.repeat(18), DISCORD.adminRoleId] };
const PLAYER = { id: '6'.repeat(18), username: 'sam', roles: ['9'.repeat(18)] };

/** A fake Discord OAuth backend: code `admin`/`player` logs in that member; records every call. */
function fakeOAuth() {
  const calls: string[] = [];
  const oauth: OAuth = {
    token: async (code, redirectUri) => {
      calls.push(`token ${code}`);
      assert.equal(redirectUri, 'https://dash.orrery.run/api/callback');
      return `access-${code}`;
    },
    member: async (accessToken, guildId) => {
      calls.push(`member ${accessToken}`);
      assert.equal(guildId, DISCORD.guildId);
      return { admin: ADMIN, player: PLAYER }[accessToken.slice('access-'.length)];
    },
  };
  return { oauth, calls };
}

async function webHub(t: TestContext, oauth: OAuth) {
  const handle = await startHub(config(t, { discord: DISCORD, web: WEB }), {
    startFrontend: async () => ({ stop: () => {} }),
    get: async () => ({ ok: true, status: 200 }),
    oauth,
  });
  t.after(() => handle.close());
  assert.ok(handle.web);
  return handle.web.app;
}

/** The `name=value` pairs a response sets, as a Cookie header. */
const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

/** Starts a login and returns Discord's authorize URL and the state cookie. */
async function startLogin(app: WebApi) {
  const res = await app.request('/api/login');
  assert.equal(res.status, 302);
  return { authorize: new URL(res.headers.get('location')!), cookie: cookies(res) };
}

async function login(app: WebApi, code: string) {
  const { authorize, cookie } = await startLogin(app);
  const state = authorize.searchParams.get('state');
  return app.request(`/api/callback?code=${code}&state=${state}`, { headers: { cookie } });
}

async function loginCookie(app: WebApi) {
  const res = await login(app, 'admin');
  assert.equal(res.status, 302);
  return cookies(res).split('; ').find((c) => c.startsWith('session='))!;
}

test('an admin logs in with Discord and /api/me returns them', async (t) => {
  const app = await webHub(t, fakeOAuth().oauth);
  const { authorize } = await startLogin(app);
  assert.equal(authorize.origin + authorize.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(authorize.searchParams.get('client_id'), WEB.clientId);
  assert.equal(authorize.searchParams.get('scope'), 'identify guilds.members.read');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://dash.orrery.run/api/callback');

  const res = await login(app, 'admin');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://dash.orrery.run/');
  const session = res.headers.getSetCookie().find((c) => c.startsWith('session='))!;
  assert.match(session, /HttpOnly/);
  assert.match(session, /Secure/);
  assert.match(session, /SameSite=Lax/);

  const me = await app.request('/api/me', { headers: { cookie: session.split(';')[0] } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { id: ADMIN.id, username: 'alex' });
});

test('without a session every other /api route answers 401', async (t) => {
  const app = await webHub(t, fakeOAuth().oauth);
  for (const path of ['/api/me', '/api/nothing-here']) assert.equal((await app.request(path)).status, 401);
  assert.equal((await app.request('/api/me', { headers: { cookie: 'session=made-up' } })).status, 401);
});

test('a member without the admin role is not allowed in', async (t) => {
  const app = await webHub(t, fakeOAuth().oauth);
  const res = await login(app, 'player');
  assert.equal(res.status, 403);
  assert.match(await res.text(), /not allowed/);
  assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('session=')));
});

test('a callback with a bad or missing state is refused before Discord is asked', async (t) => {
  const { oauth, calls } = fakeOAuth();
  const app = await webHub(t, oauth);
  const { cookie } = await startLogin(app);
  const wrong = await app.request('/api/callback?code=admin&state=guessed', { headers: { cookie } });
  assert.equal(wrong.status, 400);
  const { authorize } = await startLogin(app);
  const noCookie = await app.request(`/api/callback?code=admin&state=${authorize.searchParams.get('state')}`);
  assert.equal(noCookie.status, 400);
  assert.deepEqual(calls, []);
});

test('an expired session gets 401', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const app = await webHub(t, fakeOAuth().oauth);
  const cookie = await loginCookie(app);
  t.mock.timers.tick(7 * 24 * 60 * 60_000 - 1);
  assert.equal((await app.request('/api/me', { headers: { cookie } })).status, 200);
  t.mock.timers.tick(1);
  assert.equal((await app.request('/api/me', { headers: { cookie } })).status, 401);
});

test('logging out ends the session on the hub', async (t) => {
  const app = await webHub(t, fakeOAuth().oauth);
  const cookie = await loginCookie(app);
  const out = await app.request('/api/logout', { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 204);
  assert.equal((await app.request('/api/me', { headers: { cookie } })).status, 401);
});

test('with web off the hub has no HTTP API and needs no OAuth', async (t) => {
  const handle = await startHub(config(t, { minecraft: MINECRAFT }), {
    startFrontend: () => assert.fail('Discord is off'),
    get: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(handle.web, undefined);
  await handle.close();
});

test('startup with web configured and no DISCORD_CLIENT_SECRET fails with a clear message', (t) => {
  const cfg = config(t, { discord: DISCORD, web: { ...WEB, listenPort: 25581 } });
  const path = join(dirname(cfg.dbPath), 'config.json');
  writeFileSync(path, JSON.stringify({ ...cfg, servers: [{ id: 'gtnh', name: 'GTNH' }] }));
  const env: NodeJS.ProcessEnv = { ...process.env, DISCORD_TOKEN: 'set' };
  delete env.DISCORD_CLIENT_SECRET;
  assert.throws(
    () => execFileSync(process.execPath, ['src/index.ts', path], { env, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 }),
    (err: { status: number; stderr: string }) =>
      err.status === 1 && /integrations\.web is configured but DISCORD_CLIENT_SECRET is not set/.test(err.stderr),
  );
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { AuditLog, CommandOutput, Integrations, PlayerAnswer, ServerCard, ServerDetail } from '../src/api.ts';
import type { Config } from '../src/config.ts';
import { Db } from '../src/db.ts';
import type { RestartScheduler } from '../src/restarts.ts';
import type { HubEvent, ServerHub } from '../src/servers.ts';
import { startHub } from '../src/start.ts';
import type { OAuth, WebApi } from '../src/web.ts';
import { online, sleep, TOKEN, until } from './fake-mod.ts';

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

test('a command run through the hub lands in its audit log', async (t) => {
  const cfg = config(t, { minecraft: MINECRAFT, discord: DISCORD });
  let hub: ServerHub | undefined;
  const handle = await startHub(cfg, {
    startFrontend: async (h) => {
      hub = h;
      return { stop: () => {} };
    },
    get: () => assert.fail('no ping within a test'),
  });
  const mod = await online(handle.port!);
  const result = hub!.runCommand('gtnh', 'list', 'discord:alice (123)');
  const cmd = (await mod.next()) as { id: string };
  mod.send({ type: 'cmdResult', id: cmd.id, output: [] });
  await result;
  await handle.close();
  const db = new Db(cfg.dbPath);
  t.after(() => db.close());
  assert.deepEqual(
    db.auditLog(10).map(({ ts: _, ...e }) => e),
    [{ actor: 'discord:alice (123)', action: 'command', target: 'gtnh', details: 'list' }],
  );
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

const WEB = {
  listenPort: 0,
  publicUrl: 'https://dash.orrery.run',
  clientId: '4'.repeat(18),
  guildId: '7'.repeat(18),
  adminRoleId: '8'.repeat(18),
  sessionDays: 7,
};
const ADMIN = { id: '5'.repeat(18), username: 'alex', roles: ['9'.repeat(18), WEB.adminRoleId] };
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
      assert.equal(guildId, WEB.guildId);
      return { admin: ADMIN, player: PLAYER }[accessToken.slice('access-'.length)];
    },
  };
  return { oauth, calls };
}

/** A hub with only the web integration: no bot is started. */
async function webHub(t: TestContext, oauth: OAuth) {
  const handle = await startHub(config(t, { web: WEB }), {
    startFrontend: () => assert.fail('Discord is off'),
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
  const out = await app.request('/api/logout', {
    method: 'POST',
    headers: { cookie, origin: 'https://dash.orrery.run', 'content-type': 'application/json' },
  });
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
  const cfg = config(t, { web: { ...WEB, listenPort: 25581 } });
  const path = join(dirname(cfg.dbPath), 'config.json');
  writeFileSync(path, JSON.stringify({ ...cfg, servers: [{ id: 'gtnh', name: 'GTNH' }] }));
  const env = { ...process.env };
  delete env.DISCORD_TOKEN; // web alone needs no bot token
  delete env.DISCORD_CLIENT_SECRET;
  assert.throws(
    () => execFileSync(process.execPath, ['src/index.ts', path], { env, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 }),
    (err: { status: number; stderr: string }) =>
      err.status === 1 && /integrations\.web is configured but DISCORD_CLIENT_SECRET is not set/.test(err.stderr),
  );
});

/** A web + Minecraft hub with a logged-in admin: its API, session cookie, hub and mod port. */
async function liveHub(t: TestContext) {
  let hub: ServerHub | undefined;
  const handle = await startHub(config(t, { minecraft: MINECRAFT, discord: DISCORD, web: WEB }), {
    startFrontend: async (h) => {
      hub = h;
      return { stop: () => {} };
    },
    get: async () => ({ ok: true, status: 200 }),
    oauth: fakeOAuth().oauth,
  });
  t.after(() => handle.close());
  const app = handle.web!.app;
  return { app, cookie: await loginCookie(app), hub: hub!, live: handle.live, port: handle.port! };
}

type Sse = { id: number; data: HubEvent };

/** Opens /api/events and reads its frames (comments skipped) as they arrive. */
async function openStream(app: WebApi, cookie: string, lastEventId?: number) {
  const headers: Record<string, string> = { cookie };
  if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId);
  const res = await app.request('/api/events', { headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: Sse[] = [];
  let buf = '';
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += value;
      let end;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, end).split('\n');
        buf = buf.slice(end + 2);
        const field = (name: string) => frame.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
        const data = field('data');
        if (data) events.push({ id: Number(field('id')), data: JSON.parse(data) });
      }
    }
  })();
  return { events, close: async () => (await reader.cancel(), await pump) };
}

test('chat, commands and lifecycle changes reach an open event stream', async (t) => {
  const { app, cookie, hub, port } = await liveHub(t);
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  const mod = await online(port);
  mod.send({ type: 'chat', player: 'Steve', message: 'hi' });
  await until(() => stream.events.length === 2);
  hub.say('gtnh', 'alex', 'hello back');
  const result = hub.runCommand('gtnh', 'list', 'web:alex (5)');
  assert.equal(((await mod.next()) as { type: string }).type, 'say');
  const run = (await mod.next()) as { id: string };
  mod.send({ type: 'cmdResult', id: run.id, output: ['There are 0 players'] });
  await result;
  mod.send({ type: 'cmdLate', id: run.id, output: ['later'] });
  await until(() => stream.events.length >= 5);
  assert.deepEqual(
    stream.events.map((e) => e.data),
    [
      { serverId: 'gtnh', type: 'connected' },
      { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' },
      { serverId: 'gtnh', type: 'say', author: 'alex', message: 'hello back' },
      { serverId: 'gtnh', type: 'console', command: 'list', by: 'web:alex (5)', output: ['There are 0 players'] },
      { serverId: 'gtnh', type: 'console', command: 'list', by: 'web:alex (5)', output: ['later'], late: true },
    ],
  );
  const ids = stream.events.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
});

test('a new stream replays recent events first, and Last-Event-ID resumes after that id', async (t) => {
  const { app, cookie, port } = await liveHub(t);
  const mod = await online(port);
  for (const message of ['one', 'two', 'three']) mod.send({ type: 'chat', player: 'Steve', message });
  const first = await openStream(app, cookie);
  await until(() => first.events.length === 4);
  await first.close();
  const chats = first.events.filter((e) => e.data.type === 'chat');
  assert.deepEqual(chats.map((e) => (e.data as { message: string }).message), ['one', 'two', 'three']);

  mod.send({ type: 'chat', player: 'Steve', message: 'four' });
  const resumed = await openStream(app, cookie, chats[1]!.id);
  t.after(() => resumed.close());
  await until(() => resumed.events.length === 2);
  assert.deepEqual(resumed.events.map((e) => (e.data as { message: string }).message), ['three', 'four']);
});

test('the replay buffer keeps the last 500 events per server', async (t) => {
  const { app, cookie, port } = await liveHub(t);
  const mod = await online(port);
  for (let i = 1; i <= 510; i++) mod.send({ type: 'chat', player: 'Steve', message: String(i) });
  const probe = await openStream(app, cookie);
  await until(() => probe.events.some((e) => (e.data as { message?: string }).message === '510'));
  await probe.close();
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  await until(() => stream.events.length === 500);
  assert.equal((stream.events[0]!.data as { message: string }).message, '11');
});

test('the event stream needs a session, and a closed stream leaves no listener on the hub', async (t) => {
  const { app, cookie, live } = await liveHub(t);
  assert.equal((await app.request('/api/events')).status, 401);
  const stream = await openStream(app, cookie);
  assert.equal(live.listenerCount('event'), 1);
  await stream.close();
  await until(() => live.listenerCount('event') === 0);
});

/**
 * A Minecraft + Discord + web hub with a logged-in admin and two servers: `gtnh` (with the mod and a Backup folder
 * holding two backups a day apart) and `web` (no mod token).
 */
async function apiHub(t: TestContext) {
  const cfg = config(t, { minecraft: MINECRAFT, discord: DISCORD, web: WEB });
  const backupDir = join(dirname(cfg.dbPath), 'backups');
  mkdirSync(backupDir);
  for (const [name, bytes, mtime] of [
    ['2026-09-24-06-00-00.zip', 100, Date.now() - 24 * 60 * 60_000],
    ['2026-09-25-06-00-00.zip', 300, Date.now()],
  ] as const) {
    writeFileSync(join(backupDir, name), 'x'.repeat(bytes));
    utimesSync(join(backupDir, name), mtime / 1000, mtime / 1000);
  }
  cfg.servers = [{ ...cfg.servers[0]!, backupDir }, { ...cfg.servers[0]!, id: 'web', name: 'Website' }];
  let hub: ServerHub | undefined;
  let restarts: RestartScheduler | undefined;
  const handle = await startHub(cfg, {
    startFrontend: async (h, _s, r) => {
      hub = h;
      restarts = r;
      return { stop: () => {} };
    },
    get: async () => ({ ok: true, status: 200 }),
    oauth: fakeOAuth().oauth,
  });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const cookie = await loginCookie(app);
  const get = async <T>(path: string): Promise<T> => {
    const res = await app.request(path, { headers: { cookie } });
    assert.equal(res.status, 200, path);
    return res.json() as Promise<T>;
  };
  return { app, cookie, get, hub: hub!, restarts: restarts!, port: handle.port! };
}

const MOD = { chat: true, tps: true, quests: true };
const NO_MOD = { chat: false, tps: false, quests: false };

test('the API says which integrations are on, and nothing else about them', async (t) => {
  const { get } = await apiHub(t);
  assert.deepEqual(await get<Integrations>('/api/integrations'), { minecraft: true, discord: true, web: true });
});

test('server cards while offline: features only for the server with the mod', async (t) => {
  const { get } = await apiHub(t);
  const offline = { online: false, hung: false, tps: null, players: [], uptimeDay: null, restart: null };
  assert.deepEqual(await get<ServerCard[]>('/api/servers'), [
    { id: 'gtnh', name: 'GTNH', ...offline, features: MOD },
    { id: 'web', name: 'Website', ...offline, features: NO_MOD },
  ]);
});

test('a connected server card shows TPS, players, uptime and a pending restart', async (t) => {
  const { get, hub, restarts, port } = await apiHub(t);
  const mod = await online(port);
  mod.send({ type: 'heartbeat', tps: 19.5, players: ['Steve'] });
  await until(() => hub.get('gtnh')?.tps === 19.5);
  restarts.schedule('gtnh', 10, 'discord:alice (1)', 'alice');
  const [card] = await get<ServerCard[]>('/api/servers');
  const { uptimeDay, restart, ...rest } = card!;
  assert.deepEqual(rest, { id: 'gtnh', name: 'GTNH', online: true, hung: false, tps: 19.5, players: ['Steve'], features: MOD });
  assert.equal(uptimeDay, 1);
  assert.equal(restart?.by, 'alice');
  assert.ok(restart!.at > Date.now());
});

test('one server: status, TPS, top players per period and backups', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] }); // playtime syncs on a 10 s interval
  const { get, hub, port } = await apiHub(t);
  const offline = await get<ServerDetail>('/api/servers/gtnh');
  assert.equal(offline.card.online, false);
  assert.deepEqual(offline.status, { state: { id: 'gtnh', name: 'GTNH', online: false, hung: false, tps: null, players: [], dims: [] }, uptimeDay: null, uptimeWeek: null });
  assert.deepEqual(offline.tps, { state: offline.status.state, lastHour: [], hour: null, day: null });
  assert.deepEqual(offline.top, { day: [], week: [], all: [] });
  assert.ok(offline.backups.configured);
  assert.deepEqual(offline.backups.backups.map((b) => [b.name, b.size]), [
    ['2026-09-25-06-00-00.zip', 300],
    ['2026-09-24-06-00-00.zip', 100],
  ]);
  assert.equal(offline.backups.growth, 200);
  assert.equal(typeof offline.backups.free, 'number');

  const mod = await online(port);
  mod.send({ type: 'heartbeat', tps: 20, players: ['Steve'] });
  await until(() => hub.get('gtnh')?.players.length === 1);
  t.mock.timers.tick(10_000);
  await sleep(5); // a session needs a millisecond of playtime to count
  const detail = await get<ServerDetail>('/api/servers/gtnh');
  assert.equal(detail.status.state.online, true);
  assert.deepEqual(detail.top.day.map((p) => p.player), ['Steve']);
  const steve = await get<PlayerAnswer>('/api/servers/gtnh/players/Steve');
  assert.ok(steve.found);
  assert.deepEqual(steve.lastSeen, { online: true });
});

test('a server without the mod has no TPS and no Backup folder', async (t) => {
  const { get } = await apiHub(t);
  const detail = await get<ServerDetail>('/api/servers/web');
  assert.deepEqual(detail.card.features, NO_MOD);
  assert.equal(detail.tps, null);
  assert.deepEqual(detail.backups, { configured: false });
});

test('the audit log reads newest first, for all servers or one', async (t) => {
  const { get, restarts, port } = await apiHub(t);
  await online(port);
  restarts.schedule('gtnh', 10, 'discord:alice (1)', 'alice');
  restarts.cancel('gtnh', 'discord:bob (2)', 'bob');
  // Not the hub's own in-game warnings, whose timing varies.
  const byPeople = (log: AuditLog) => log.filter((e) => e.actor.startsWith('discord:'));
  const log = byPeople(await get<AuditLog>('/api/audit'));
  assert.deepEqual(log.map(({ ts: _, ...e }) => e), [
    { actor: 'discord:bob (2)', action: 'restart cancel', target: 'gtnh', details: '' },
    { actor: 'discord:alice (1)', action: 'restart', target: 'gtnh', details: 'in 10 min' },
  ]);
  assert.deepEqual(byPeople(await get<AuditLog>('/api/audit?server=gtnh')), log);
  assert.deepEqual(await get<AuditLog>('/api/audit?server=web'), []);
});

test('unknown servers and players get 404, and every read needs a session', async (t) => {
  const { app, cookie } = await apiHub(t);
  for (const path of ['/api/servers/nope', '/api/servers/nope/players/Steve', '/api/servers/gtnh/players/Nobody', '/api/audit?server=nope']) {
    assert.equal((await app.request(path, { headers: { cookie } })).status, 404, path);
  }
  for (const path of ['/api/integrations', '/api/servers', '/api/servers/gtnh', '/api/servers/gtnh/players/Steve', '/api/audit']) {
    assert.equal((await app.request(path)).status, 401, path);
  }
});

const ORIGIN = 'https://dash.orrery.run';
const ACTOR = `web:alex (${ADMIN.id})`;

/** A POST the way the dashboard sends it: same origin, JSON. */
function post(app: WebApi, cookie: string, path: string, body?: object, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: body && JSON.stringify(body),
  });
}

const webAudit = (log: AuditLog) => log.filter((e) => e.actor.startsWith('web:')).map(({ ts: _, ...e }) => e);

test('chat from the dashboard reaches the mod, appears on the stream and is audited', async (t) => {
  const { app, cookie, get, port } = await apiHub(t);
  const mod = await online(port);
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  const res = await post(app, cookie, '/api/servers/gtnh/chat', { message: 'hi §cthere' });
  assert.equal(res.status, 204);
  assert.deepEqual(await mod.next(), { type: 'say', author: 'alex', message: 'hi there' });
  await until(() => stream.events.some((e) => e.data.type === 'say'));
  assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
    { actor: ACTOR, action: 'chat', target: 'gtnh', details: 'hi there' },
  ]);
  for (const body of [{}, [], { message: 42 }, { message: '§c ' }]) {
    assert.equal((await post(app, cookie, '/api/servers/gtnh/chat', body)).status, 400, JSON.stringify(body));
  }
  const bad = await app.request('/api/servers/gtnh/chat', {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
});

test('a console command answers with its output, and late output arrives on the stream', async (t) => {
  const { app, cookie, get, port } = await apiHub(t);
  const mod = await online(port);
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  const pending = post(app, cookie, '/api/servers/gtnh/command', { command: '/spark profiler' });
  const cmd = (await mod.next()) as { id: string; command: string };
  assert.equal(cmd.command, 'spark profiler');
  mod.send({ type: 'cmdResult', id: cmd.id, output: ['Profiler started'] });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { output: ['Profiler started'] } satisfies CommandOutput);
  mod.send({ type: 'cmdLate', id: cmd.id, output: ['https://spark.lucko.me/abc'] });
  await until(() => stream.events.some((e) => e.data.type === 'console' && e.data.late));
  assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
    { actor: ACTOR, action: 'command', target: 'gtnh', details: 'spark profiler' },
  ]);
  assert.equal((await post(app, cookie, '/api/servers/gtnh/command', { command: ' ' })).status, 400);
});

test('a restart is scheduled with a countdown and cancelled from the dashboard', async (t) => {
  const { app, cookie, get, port } = await apiHub(t);
  const mod = await online(port);
  assert.equal((await post(app, cookie, '/api/servers/gtnh/restart', { minutes: 10 })).status, 204);
  assert.equal(((await mod.next()) as { command: string }).command, 'say Server restarting in 10 minutes');
  assert.deepEqual((await get<ServerCard[]>('/api/servers'))[0]!.restart?.by, 'alex');
  assert.equal((await post(app, cookie, '/api/servers/gtnh/restart', { minutes: 5 })).status, 409);
  assert.equal((await post(app, cookie, '/api/servers/gtnh/restart/cancel')).status, 204);
  assert.equal(((await mod.next()) as { command: string }).command, 'say Restart cancelled');
  assert.equal((await post(app, cookie, '/api/servers/gtnh/restart/cancel')).status, 409);
  for (const body of [{}, { minutes: 61 }, { minutes: 1.5 }, { minutes: '5' }]) {
    assert.equal((await post(app, cookie, '/api/servers/gtnh/restart', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
    { actor: ACTOR, action: 'restart cancel', target: 'gtnh', details: '' },
    { actor: ACTOR, action: 'restart', target: 'gtnh', details: 'in 10 min' },
  ]);
});

test('a backup start sends the command and answers with its output', async (t) => {
  const { app, cookie, get, port } = await apiHub(t);
  const mod = await online(port);
  const pending = post(app, cookie, '/api/servers/gtnh/backup');
  const cmd = (await mod.next()) as { id: string; command: string };
  assert.equal(cmd.command, 'backup start');
  mod.send({ type: 'cmdResult', id: cmd.id, output: ['Backup started'] });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { output: ['Backup started'] });
  assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
    { actor: ACTOR, action: 'command', target: 'gtnh', details: 'backup start' },
  ]);
});

test('actions on an offline or unknown server get a clear error', async (t) => {
  const { app, cookie } = await apiHub(t);
  for (const [path, body] of [
    ['chat', { message: 'hi' }],
    ['command', { command: 'list' }],
    ['restart', { minutes: 5 }],
    ['restart/cancel', undefined],
    ['backup', undefined],
  ] as const) {
    const res = await post(app, cookie, `/api/servers/web/${path}`, body);
    assert.equal(res.status, 409, path);
    assert.equal(await res.text(), 'Website is offline');
    assert.equal((await post(app, cookie, `/api/servers/nope/${path}`, body)).status, 404, path);
  }
});

test('a state-changing request needs a session, the dashboard origin and JSON', async (t) => {
  const { app, cookie, port } = await apiHub(t);
  const mod = await online(port);
  const chat = (headers: Record<string, string>, withCookie = cookie) =>
    post(app, withCookie, '/api/servers/gtnh/chat', { message: 'hi' }, headers);
  assert.equal((await chat({}, '')).status, 401);
  assert.equal((await chat({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await chat({ origin: '' })).status, 403);
  assert.equal((await chat({ 'content-type': 'text/plain' })).status, 415);
  assert.equal((await chat({ 'content-type': 'application/json; charset=utf-8' })).status, 204);
  assert.deepEqual(await mod.next(), { type: 'say', author: 'alex', message: 'hi' });
  assert.equal((await app.request('/api/logout', { method: 'POST', headers: { cookie } })).status, 403);
});

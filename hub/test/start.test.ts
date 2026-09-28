import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type {
  AuditLog,
  CheckStatus,
  CommandOutput,
  HostNow,
  HostSample,
  Integrations,
  LiveEvent,
  PlayerAnswer,
  ServerCard,
  ServerDetail,
  ServerHistory,
  ServiceActionAnswer,
  ServiceLogs,
  ServiceStatus,
  TargetEvent,
} from '../src/api.ts';
import type { Config } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { postTargets } from '../src/discord.ts';
import { formatTargetEvent, type Post } from '../src/format.ts';
import type { RestoreEnv, RunRestore } from '../src/restore.ts';
import type { Run } from '../src/services.ts';
import type { RestartScheduler } from '../src/restarts.ts';
import type { HubEvent, ServerHub } from '../src/servers.ts';
import { HISTORY_POINTS } from '../src/host.ts';
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
const ADMIN = { id: '5'.repeat(18), username: 'alex', avatar: 'a1b2c3', roles: ['9'.repeat(18), WEB.adminRoleId] };
const PLAYER = { id: '6'.repeat(18), username: 'sam', avatar: null, roles: ['9'.repeat(18)] };

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
  assert.deepEqual(await me.json(), { id: ADMIN.id, username: 'alex', avatar: 'a1b2c3' });
});

test('without a session every other /api route answers 401', async (t) => {
  const app = await webHub(t, fakeOAuth().oauth);
  for (const path of ['/api/me', '/api/nothing-here']) assert.equal((await app.request(path)).status, 401);
  assert.equal((await app.request('/api/me', { headers: { cookie: 'session=made-up' } })).status, 401);
});

test('a member without the admin role is not allowed in', async (t) => {
  const app = await webHub(t, fakeOAuth().oauth);
  const res = await login(app, 'player');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://dash.orrery.run/?login=admin');
  assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('session=')));
});

test('a callback with a bad or missing state is refused before Discord is asked', async (t) => {
  const { oauth, calls } = fakeOAuth();
  const app = await webHub(t, oauth);
  const { cookie } = await startLogin(app);
  const wrong = await app.request('/api/callback?code=admin&state=guessed', { headers: { cookie } });
  assert.equal(wrong.headers.get('location'), 'https://dash.orrery.run/?login=state');
  const { authorize } = await startLogin(app);
  const noCookie = await app.request(`/api/callback?code=admin&state=${authorize.searchParams.get('state')}`);
  assert.equal(noCookie.headers.get('location'), 'https://dash.orrery.run/?login=state');
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

type Sse = { id: number; data: LiveEvent };

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

test('heartbeats put TPS on the stream, and an hour of them evicts no chat and replays only the latest', async (t) => {
  const { app, cookie, port } = await liveHub(t);
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  const mod = await online(port);
  mod.send({ type: 'chat', player: 'Steve', message: 'before' });
  mod.send({ type: 'heartbeat', tps: 19.5, players: ['Steve'] });
  mod.send({ type: 'heartbeat', tps: 19.52, players: ['Steve'] }); // not a noticeable change
  mod.send({ type: 'heartbeat', tps: 12, players: ['Steve'] });
  await until(() => stream.events.filter((e) => e.data.type === 'tps').length === 2);
  assert.deepEqual(
    stream.events.filter((e) => e.data.type === 'tps').map((e) => e.data),
    [
      { serverId: 'gtnh', type: 'tps', tps: 19.5 },
      { serverId: 'gtnh', type: 'tps', tps: 12 },
    ],
  );

  for (let i = 0; i < 720; i++) mod.send({ type: 'heartbeat', tps: 10 + (i % 100) / 10, players: [] }); // 5 s apart
  mod.send({ type: 'heartbeat', tps: 18, players: [] });
  await until(() => (stream.events.at(-1)!.data as { tps?: number }).tps === 18);
  const replay = await openStream(app, cookie);
  t.after(() => replay.close());
  await until(() => replay.events.length === 3);
  assert.deepEqual(
    replay.events.map((e) => e.data),
    [
      { serverId: 'gtnh', type: 'connected' },
      { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'before' },
      { serverId: 'gtnh', type: 'tps', tps: 18 },
    ],
  );
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
  return { app, cookie, get, hub: hub!, restarts: restarts!, port: handle.port!, live: handle.live };
}

const MOD = { chat: true, tps: true, quests: true };
const NO_MOD = { chat: false, tps: false, quests: false };

test('the API says which integrations are on, and nothing else about them', async (t) => {
  const { get } = await apiHub(t);
  assert.deepEqual(await get<Integrations>('/api/integrations'), { minecraft: true, discord: true, web: true, checks: false, host: false, systemd: false });
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
  assert.equal(offline.backups.minFree, 10 * 1024 ** 3); // the server's backupMinFreeGB, for the low-space warning
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

test("a server's history: TPS samples, player counts from sessions, and up/down periods", async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] }); // TPS is sampled each minute, sessions synced every 10 s
  const { get, hub, port, live } = await apiHub(t);
  let lastId = 0;
  live.on('event', (id) => void (lastId = id));
  const beat = async (tps: number, players: string[]) => {
    mod.send({ type: 'heartbeat', tps, players });
    await until(() => hub.get('gtnh')?.tps === tps);
    t.mock.timers.tick(60_000);
    await sleep(5); // the next change lands on a later millisecond
  };
  let mod = await online(port);
  await beat(19.5, ['Steve']);
  await beat(12, ['Steve', 'Alex']);
  mod.send({ type: 'stopping' });
  mod.socket.end();
  await until(() => hub.get('gtnh')?.online === false);
  t.mock.timers.tick(10_000);
  await sleep(5);
  mod = await online(port);
  mod.send({ type: 'heartbeat', tps: 20, players: ['Alex'] });
  await until(() => hub.get('gtnh')?.players.length === 1);

  const history = await get<ServerHistory>('/api/servers/gtnh/history?hours=1');
  assert.deepEqual(history.tps!.map((p) => p.tps), [19.5, 12]);
  // From nobody an hour ago, up to the live count (Alex's session isn't synced yet).
  assert.deepEqual(history.players.map((p) => p.count), [0, 1, 2, 0, 1]);
  assert.deepEqual(history.uptime.map((p) => p.state), ['unknown', 'up', 'down', 'up']);
  for (const series of [history.tps!, history.players, history.uptime]) {
    assert.ok(series.every((p, i) => i === 0 || p.ts >= series[i - 1]!.ts));
  }
  assert.equal(history.asOf, lastId);
  const day = await get<ServerHistory>('/api/servers/gtnh/history'); // 24 h by default
  assert.deepEqual(day.uptime.map((p) => p.state), ['unknown', 'up', 'down', 'up']);
});

test('a server without the mod has no TPS history; unknown servers are 404 and bad periods 400', async (t) => {
  const { get, app, cookie } = await apiHub(t);
  const history = await get<ServerHistory>('/api/servers/web/history');
  assert.equal(history.tps, null);
  assert.deepEqual(history.players.map((p) => p.count), [0, 0]);
  assert.equal((await app.request('/api/servers/nope/history', { headers: { cookie } })).status, 404);
  for (const hours of ['0', '2161', 'x', '1.5']) {
    assert.equal((await app.request(`/api/servers/gtnh/history?hours=${hours}`, { headers: { cookie } })).status, 400, hours);
  }
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
  for (const body of [{ command: ' /' }, { command: '\u0001' }, {}]) {
    assert.equal((await post(app, cookie, '/api/servers/gtnh/command', body)).status, 400, JSON.stringify(body));
  }
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

test('a notice about a check reaches the stream, its replay and a resume, keyed apart from servers', async (t) => {
  const { app, cookie, hub } = await liveHub(t);
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  const down = (n: number) => ({ severity: 'problem', kind: 'checkDown', url: `https://site.example/${n}`, error: 'HTTP 503' }) as const;
  // Named like the server: a check's events are its own, never the server's.
  for (const n of [1, 2, 3]) hub.publishTarget({ target: 'check', id: 'gtnh', type: 'notice', ...down(n) });
  await until(() => stream.events.length === 3);
  assert.deepEqual(stream.events[0]!.data, { target: 'check', id: 'gtnh', type: 'notice', ...down(1) });

  const replay = await openStream(app, cookie);
  t.after(() => replay.close());
  await until(() => replay.events.length === 3);
  assert.deepEqual(replay.events, stream.events);
  const resumed = await openStream(app, cookie, stream.events[1]!.id);
  t.after(() => resumed.close());
  await until(() => resumed.events.length === 1);
  assert.deepEqual(resumed.events, [stream.events[2]]);
});

const SITE = { id: 'site', url: 'https://site.example', intervalSeconds: 60 };
type Answer = { ok: boolean; status: number } | Error;
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

/** A web hub with one check (no health ping); `answers` are the check's results in order, the first at startup. */
async function checksHub(t: TestContext, answers: Answer[]) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, { web: WEB, checks: [SITE] });
  delete cfg.healthcheckUrl;
  const requests: string[] = [];
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: async (url) => {
      requests.push(url);
      const answer = answers[requests.length - 1] ?? assert.fail('no more answers');
      if (answer instanceof Error) throw answer;
      return answer;
    },
    oauth: fakeOAuth().oauth,
  });
  t.after(() => handle.close());
  const notices: TargetNotice[] = [];
  const add = (e: LiveEvent) => void ('target' in e && e.type === 'notice' && notices.push(e));
  handle.live.since().forEach(([, e]) => add(e)); // from the startup request
  handle.live.on('event', (_, e) => add(e));
  const app = handle.web!.app;
  const cookie = await loginCookie(app);
  /** Waits for the check's `n`th request to be answered. */
  const answered = async (n: number) => (await until(() => requests.length === n), await new Promise((r) => setImmediate(r)));
  const next = async () => {
    const n = requests.length + 1;
    t.mock.timers.tick(60_000);
    await answered(n);
  };
  const checks = async () => (await app.request('/api/checks', { headers: { cookie } })).json() as Promise<CheckStatus[]>;
  await answered(1);
  return { requests, notices, next, checks, app, cookie };
}

const UP = { ok: true, status: 200 };
type TargetNotice = Extract<TargetEvent, { type: 'notice' }>;
const kinds = (notices: TargetNotice[]) => notices.map((n) => [n.id, n.kind, n.kind === 'checkDown' ? n.error : null]);

test('a check that goes down publishes one notice, and one when it is back up', async (t) => {
  const { requests, notices, next, checks } = await checksHub(t, [UP, UP, { ok: false, status: 503 }, { ok: false, status: 500 }, refused(), { ok: true, status: 204 }, UP]);
  const [first] = await checks();
  assert.deepEqual({ ...first, ms: typeof first!.ms, checkedAt: typeof first!.checkedAt }, {
    id: 'site',
    url: 'https://site.example',
    up: true,
    ms: 'number',
    error: null,
    checkedAt: 'number',
    service: null,
  });
  await next();
  assert.equal(notices.length, 0); // up at startup and still up: nothing to say
  await next();
  assert.deepEqual(kinds(notices), [['site', 'checkDown', 'HTTP 503']]);
  assert.deepEqual(notices[0], { target: 'check', id: 'site', type: 'notice', severity: 'problem', kind: 'checkDown', url: SITE.url, error: 'HTTP 503' });
  assert.equal((await checks())[0]!.up, false);
  await next();
  await next();
  assert.equal(notices.length, 1); // still down, however it fails
  assert.equal((await checks())[0]!.error, 'ECONNREFUSED');
  await next();
  assert.deepEqual(kinds(notices), [['site', 'checkDown', 'HTTP 503'], ['site', 'checkUp', null]]);
  assert.equal(notices[1]!.severity, 'good');
  await next();
  assert.equal(notices.length, 2);
  assert.deepEqual((await checks()).map((c) => [c.up, c.error]), [[true, null]]);
  assert.deepEqual(new Set(requests), new Set([SITE.url]));
});

test('a check that times out or cannot connect is down', async (t) => {
  const { notices, next } = await checksHub(t, [timeout(), UP, refused()]);
  await next();
  await next();
  assert.deepEqual(kinds(notices), [['site', 'checkDown', 'timed out'], ['site', 'checkUp', null], ['site', 'checkDown', 'ECONNREFUSED']]);
});

test('without checks nothing is requested and there is no checks API', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, { web: WEB });
  delete cfg.healthcheckUrl;
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
    oauth: fakeOAuth().oauth,
  });
  t.after(() => handle.close());
  t.mock.timers.tick(60 * 60_000);
  const cookie = await loginCookie(handle.web!.app);
  assert.equal((await handle.web!.app.request('/api/checks', { headers: { cookie } })).status, 404);
  const on = (await (await handle.web!.app.request('/api/integrations', { headers: { cookie } })).json()) as Integrations;
  assert.equal(on.checks, false);
});

const GB = 1024 ** 3;

/**
 * A web hub measuring host `oracle` (mount `/`, memory warning at 90% for 2 minutes, disk at 10 GB) with fake readers;
 * `use` sets what they read next. `next` takes one sample.
 */
async function hostHub(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, {
    web: WEB,
    host: { id: 'oracle', mounts: ['/'], memoryMaxPercent: 90, memoryMinutes: 2, diskMinFreeGB: 10 },
  });
  delete cfg.healthcheckUrl;
  const now = { busy: 0, idle: 0, memUsed: 1 * GB, free: 50 * GB };
  const use = (next: Partial<typeof now>) => Object.assign(now, next);
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
    oauth: fakeOAuth().oauth,
    host: {
      cpu: () => ({ idle: now.idle, total: now.idle + now.busy }),
      load: () => [0.5, 0.25, 0.125],
      memory: async () => ({ total: 16 * GB, available: 16 * GB - now.memUsed }),
      disk: async (mount) => ({ free: mount === '/' ? now.free : assert.fail(mount), total: 100 * GB }),
    },
  });
  t.after(() => handle.close());
  const events: TargetEvent[] = [];
  handle.live.on('event', (_, e) => void ('target' in e && events.push(e)));
  const samples = () => events.filter((e) => e.type === 'sample').length;
  const next = async () => {
    const n = samples() + 1;
    t.mock.timers.tick(60_000);
    await until(() => samples() === n);
  };
  const notices = () => events.flatMap((e) => (e.type === 'notice' ? [e.kind] : []));
  const app = handle.web!.app;
  const cookie = await loginCookie(app);
  const get = async <T>(path: string) => {
    const res = await app.request(path, { headers: { cookie } });
    assert.equal(res.status, 200, path);
    return res.json() as Promise<T>;
  };
  return { use, next, notices, events, get, app, cookie, dbPath: cfg.dbPath };
}

test('a host sample is stored, served as the latest and in the history, and streamed', async (t) => {
  const { use, next, events, get } = await hostHub(t);
  assert.deepEqual(await get<HostNow>('/api/host'), { id: 'oracle', sample: null });
  use({ busy: 30, idle: 70, memUsed: 4 * GB });
  await next();
  const { sample } = await get<HostNow>('/api/host');
  assert.deepEqual({ ...sample!, ts: typeof sample!.ts }, {
    ts: 'number',
    cpu: 0.3,
    load: [0.5, 0.25, 0.125],
    memory: { used: 4 * GB, total: 16 * GB },
    disks: [{ mount: '/', free: 50 * GB, total: 100 * GB }],
  });
  assert.deepEqual(events, [{ target: 'host', id: 'oracle', type: 'sample', sample }]);
  use({ busy: 40, idle: 160 }); // 10 busy of 100 since the last sample
  await next();
  const history = await get<HostSample[]>('/api/host/samples?hours=1');
  assert.deepEqual(history.map((s) => s.cpu), [0.3, 0.1]);
  assert.deepEqual(await get<HostSample[]>('/api/host/samples'), history); // 24 hours by default
  assert.deepEqual((await get<Integrations>('/api/integrations')).host, true);
});

test('a long history period is averaged into at most HISTORY_POINTS buckets; short ones stay raw', async (t) => {
  const { get, dbPath } = await hostHub(t);
  // A week of minutes, busy and idle in turn, disk free 0 and 2 GB in turn.
  const db = new Db(dbPath);
  const now = Date.now();
  for (let k = 7 * 24 * 60 - 1; k >= 0; k--) {
    const on = k % 2;
    db.recordHostSample('oracle', {
      ts: now - k * 60_000 - 30_000,
      cpu: on,
      load: [on, 2 * on, 3 * on],
      memory: { used: on * GB, total: 16 * GB },
      disks: [{ mount: '/', free: 2 * on * GB, total: 100 * GB }],
    });
  }
  db.close();
  assert.equal((await get<HostSample[]>('/api/host/samples?hours=1')).length, 60);
  const day = await get<HostSample[]>('/api/host/samples?hours=24');
  assert.equal(day.length, 24 * 60);
  assert.deepEqual(new Set(day.map((s) => s.cpu)), new Set([0, 1]));

  const week = await get<HostSample[]>('/api/host/samples?hours=168');
  const width = Math.ceil((168 * 60) / HISTORY_POINTS); // minutes in a bucket: 7, so 3 or 4 of them busy
  assert.ok(week.length <= HISTORY_POINTS);
  assert.ok(Math.abs(week.length - (168 * 60) / width) <= 1, String(week.length)); // 1440, or one more split at the ends
  for (const b of week.slice(1, -1)) {
    const busy = Math.round(b.cpu * width);
    assert.ok(busy === 3 || busy === 4, String(b.cpu));
    const share = busy / width;
    assert.deepEqual(b.load.map((l) => +(l / share).toFixed(9)), [1, 2, 3]);
    assert.equal(+(b.memory.used / GB / share).toFixed(9), 1);
    assert.equal(b.memory.total, 16 * GB);
    assert.deepEqual(b.disks.map((d) => [d.mount, +(d.free / GB / share).toFixed(9), d.total]), [['/', 2, 100 * GB]]);
  }
  assert.ok(week.every((b, i) => i === 0 || b.ts > week[i - 1].ts));
});

test('a bad history period is refused', async (t) => {
  const { app, cookie } = await hostHub(t);
  for (const hours of ['0', '2161', 'x', '1.5']) {
    assert.equal((await app.request(`/api/host/samples?hours=${hours}`, { headers: { cookie } })).status, 400, hours);
  }
});

test('sustained high memory warns once and recovers once', async (t) => {
  const { use, next, notices } = await hostHub(t);
  use({ memUsed: 15 * GB }); // 94%
  await next();
  assert.deepEqual(notices(), []); // one minute is not sustained
  await next();
  await next();
  assert.deepEqual(notices(), ['memoryHigh']);
  use({ memUsed: 8 * GB });
  await next();
  await next();
  assert.deepEqual(notices(), ['memoryHigh', 'memoryOk']);
});

test('low disk on a mount warns once and recovers once', async (t) => {
  const { use, next, notices, events } = await hostHub(t);
  use({ free: 5 * GB });
  await next();
  await next();
  assert.deepEqual(notices(), ['diskLow']);
  assert.deepEqual(events.find((e) => e.type === 'notice'), {
    target: 'host',
    id: 'oracle',
    type: 'notice',
    severity: 'warning',
    kind: 'diskLow',
    mount: '/',
    free: 5 * GB,
    minFreeGB: 10,
  });
  use({ free: 20 * GB });
  await next();
  await next();
  assert.deepEqual(notices(), ['diskLow', 'diskOk']);
});

test("a stream's replay holds only the host's latest sample", async (t) => {
  const { use, next, app, cookie } = await hostHub(t);
  use({ free: 5 * GB });
  for (let i = 0; i < 3; i++) await next();
  const replay = await openStream(app, cookie);
  t.after(() => replay.close());
  await until(() => replay.events.length === 2);
  assert.deepEqual(replay.events.map((e) => ('kind' in e.data ? e.data.kind : e.data.type)), ['diskLow', 'sample']);
});

test('without the host integration nothing is sampled and there is no host API', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, { web: WEB });
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: async () => ({ ok: true, status: 200 }),
    oauth: fakeOAuth().oauth,
    host: { cpu: () => assert.fail(), load: () => assert.fail(), memory: () => assert.fail(), disk: () => assert.fail() },
  });
  t.after(() => handle.close());
  t.mock.timers.tick(60 * 60_000);
  const cookie = await loginCookie(handle.web!.app);
  assert.equal((await handle.web!.app.request('/api/host', { headers: { cookie } })).status, 404);
});

const UNITS = [
  { id: 'gtnh', unit: 'gtnh.service' },
  { id: 'caddy', unit: 'caddy.service' },
];

/** A fake systemctl/journalctl: `states` holds each listed unit's ActiveState and SubState; every call is recorded. */
function fakeSystemd() {
  const states: Record<string, [string, string]> = { 'gtnh.service': ['active', 'running'], 'caddy.service': ['active', 'running'] };
  const calls: string[][] = [];
  const fake = { fails: false };
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (fake.fails) throw new Error('permission denied');
    if (command === 'journalctl') return '2026-09-27T10:00:00+0000 host gtnh[1]: one\n2026-09-27T10:00:01+0000 host gtnh[1]: two\n';
    const [active, sub] = states[args.at(-1)!] ?? assert.fail(`unlisted unit ${args.at(-1)}`);
    return `ActiveState=${active}\nSubState=${sub}\n`;
  };
  /** The units every call named. */
  const units = () => calls.map((c) => (c[0] === 'journalctl' ? c.find((a) => a.startsWith('--unit='))!.slice(7) : c.at(-1)!));
  return Object.assign(fake, { run, calls, states, units });
}

/** A web hub watching two services, with a check linked to `caddy`. `next` runs one watch round. */
async function servicesHub(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, { web: WEB, systemd: UNITS, checks: [{ ...SITE, service: 'caddy' }] });
  delete cfg.healthcheckUrl;
  const systemd = fakeSystemd();
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: async () => UP,
    oauth: fakeOAuth().oauth,
    run: systemd.run,
  });
  t.after(() => handle.close());
  const events: TargetEvent[] = [];
  handle.live.on('event', (_, e) => void ('target' in e && e.target === 'service' && events.push(e)));
  const shows = () => systemd.calls.filter((c) => c[0] === 'systemctl').length;
  await until(() => shows() === 2);
  const next = async () => {
    const n = shows() + 2;
    t.mock.timers.tick(5_000);
    await until(() => shows() === n);
    await new Promise((r) => setImmediate(r));
  };
  const app = handle.web!.app;
  const cookie = await loginCookie(app);
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
    oauth: fakeOAuth().oauth,
    run: () => assert.fail('nothing to run'),
  });
  t.after(() => handle.close());
  t.mock.timers.tick(60 * 60_000);
  const cookie = await loginCookie(handle.web!.app);
  assert.equal((await handle.web!.app.request('/api/services', { headers: { cookie } })).status, 404);
  const on = (await (await handle.web!.app.request('/api/integrations', { headers: { cookie } })).json()) as Integrations;
  assert.equal(on.systemd, false);
});

const BACKUP = '2026-09-26-06-00-00.zip';

/**
 * A Minecraft + web hub whose server `gtnh` (folder, one backup) runs as the service `gtnh` (unless `linked` is
 * false), with a fake restore script: `runs` has each call, `fake.fails` makes it fail, `fake.gate` holds it.
 * `stopService` stops `gtnh.service` and waits until the hub has read that.
 */
async function restoreHub(t: TestContext, linked = true) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, { minecraft: MINECRAFT, web: WEB, systemd: UNITS });
  delete cfg.healthcheckUrl;
  const dir = join(dirname(cfg.dbPath), 'gtnh');
  const backupDir = join(dir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, BACKUP), 'zip');
  cfg.servers = [{ ...cfg.servers[0]!, dir, backupDir, ...(linked && { service: 'gtnh' }) }];
  const systemd = fakeSystemd();
  const runs: [string, RestoreEnv][] = [];
  const fake = { fails: false, gate: Promise.resolve() };
  const restore: RunRestore = async (name, env) => {
    runs.push([name, env]);
    await fake.gate;
    if (fake.fails) throw new Error("restore-backup: can't read 2026-09-26-06-00-00.zip (corrupt?)");
    return `Restored ${name} into ${dir}/World.\nNext: sudo systemctl start gtnh.service, then join and check the world.\n`;
  };
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
    oauth: fakeOAuth().oauth,
    run: systemd.run,
    restore,
  });
  t.after(() => handle.close());
  const shows = () => systemd.calls.length;
  await until(() => shows() === 2);
  const stopService = async () => {
    systemd.states['gtnh.service'] = ['inactive', 'dead'];
    const n = shows() + 2;
    t.mock.timers.tick(5_000);
    await until(() => shows() === n);
    await new Promise((r) => setImmediate(r));
  };
  const app = handle.web!.app;
  const cookie = await loginCookie(app);
  const restoreOf = (name: unknown, server = 'gtnh') => post(app, cookie, `/api/servers/${server}/restore`, { name });
  const audit = async () =>
    webAudit((await (await app.request('/api/audit', { headers: { cookie } })).json()) as AuditLog).filter((e) => e.action === 'restore');
  return { runs, fake, stopService, restoreOf, audit, dir, backupDir };
}

test('a restore with the linked service stopped runs the script with its settings, answers its output and is audited', async (t) => {
  const { runs, stopService, restoreOf, audit, dir, backupDir } = await restoreHub(t);
  await stopService();
  const res = await restoreOf(BACKUP);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    output: [`Restored ${BACKUP} into ${dir}/World.`, 'Next: sudo systemctl start gtnh.service, then join and check the world.'],
  } satisfies CommandOutput);
  assert.deepEqual(runs, [[BACKUP, { GTNH_DIR: dir, BACKUP_DIR: backupDir, GTNH_SERVICE: 'gtnh.service' }]]);
  assert.deepEqual(await audit(), [{ actor: ACTOR, action: 'restore', target: 'gtnh', details: `${BACKUP}: done` }]);
});

test('a restore is refused while the service runs, and for an unknown server', async (t) => {
  const { runs, restoreOf, audit } = await restoreHub(t);
  const running = await restoreOf(BACKUP);
  assert.equal(running.status, 409);
  assert.equal(await running.text(), 'gtnh.service is active: stop it first.');
  assert.equal((await restoreOf(BACKUP, 'nope')).status, 404);
  assert.deepEqual(runs, []);
  assert.deepEqual(await audit(), [{ actor: ACTOR, action: 'restore', target: 'gtnh', details: `${BACKUP}: refused: gtnh.service is active: stop it first.` }]);
});

test('a server without a linked service is never restored from the dashboard', async (t) => {
  const unlinked = await restoreHub(t, false);
  const res = await unlinked.restoreOf(BACKUP);
  assert.equal(res.status, 409);
  assert.match(await res.text(), /no linked service/);
  assert.deepEqual(unlinked.runs, []);
});

test('only a listed backup is ever passed to the script', async (t) => {
  const { runs, stopService, restoreOf } = await restoreHub(t);
  await stopService();
  for (const name of ['../x.zip', `../backups/${BACKUP}`, '2026-09-25-06-00-00.zip', 'latest', '']) {
    assert.equal((await restoreOf(name)).status, 404, name);
  }
  for (const name of [undefined, 42, [BACKUP]]) assert.equal((await restoreOf(name)).status, 400, String(name));
  assert.deepEqual(runs, []);
});

test('a failing restore answers 502 with its error output and is audited', async (t) => {
  const { fake, stopService, restoreOf, audit } = await restoreHub(t);
  await stopService();
  fake.fails = true;
  const res = await restoreOf(BACKUP);
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "The restore failed: restore-backup: can't read 2026-09-26-06-00-00.zip (corrupt?)");
  assert.deepEqual(await audit(), [
    { actor: ACTOR, action: 'restore', target: 'gtnh', details: `${BACKUP}: failed: restore-backup: can't read 2026-09-26-06-00-00.zip (corrupt?)` },
  ]);
});

test('a second restore while one runs is refused', async (t) => {
  const { runs, fake, stopService, restoreOf } = await restoreHub(t);
  await stopService();
  let release!: () => void;
  fake.gate = new Promise((r) => (release = r));
  const first = restoreOf(BACKUP);
  await until(() => runs.length === 1);
  const second = await restoreOf(BACKUP);
  assert.equal(second.status, 409);
  assert.equal(await second.text(), 'A restore is already running on GTNH.');
  release();
  assert.equal((await first).status, 200);
  assert.equal(runs.length, 1);
});

/** A Minecraft + web hub whose server `gtnh` runs as the service `gtnh`; `caddy` is linked to nothing. */
async function actionsHub(t: TestContext) {
  const cfg = config(t, { minecraft: MINECRAFT, web: WEB, systemd: UNITS });
  delete cfg.healthcheckUrl;
  cfg.servers = [{ ...cfg.servers[0]!, service: 'gtnh' }];
  const systemd = fakeSystemd();
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
    oauth: fakeOAuth().oauth,
    run: systemd.run,
  });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const cookie = await loginCookie(app);
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

test('an action on an unlisted service is 404 and never run; a failing systemctl is 502', async (t) => {
  const { app, cookie, systemd, actions } = await actionsHub(t);
  for (const path of ['nope/stop', 'gtnh.service/stop', 'toString/start', 'gtnh/kill', 'gtnh/logs']) {
    assert.equal((await post(app, cookie, `/api/services/${path}`)).status, 404, path);
  }
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

test("Discord posts a check's notices only in the alerts channel, and without one posts nothing", async (t) => {
  for (const alertsChannel of ['4'.repeat(18), undefined]) {
    const cfg = config(t, { minecraft: MINECRAFT, discord: { ...DISCORD, alertsChannel }, checks: [{ ...SITE, id: 'gtnh' }] });
    delete cfg.healthcheckUrl;
    const posted: [string, Post][] = [];
    const handle = await startHub(cfg, {
      startFrontend: async (hub, _s, _r, _l, discord) => {
        postTargets(hub, discord, async (channelId, message) => void posted.push([channelId, message]));
        return { stop: () => {} };
      },
      get: async () => ({ ok: false, status: 503 }),
    });
    await until(() => handle.live.since().some(([, e]) => 'target' in e && e.type === 'notice'));
    await handle.close();
    // Named like the server, still only in the alerts channel (the server's channel is 3…).
    assert.deepEqual(posted, alertsChannel ? [[alertsChannel, formatTargetEvent({ target: 'check', id: 'gtnh', type: 'notice', severity: 'problem', kind: 'checkDown', url: SITE.url, error: 'HTTP 503' })]] : []);
  }
});

test("each check result is streamed, and a replay holds only a check's latest", async (t) => {
  const { next, app, cookie } = await checksHub(t, [UP, { ok: false, status: 503 }, UP]);
  await next();
  await next();
  const replay = await openStream(app, cookie);
  t.after(() => replay.close());
  await until(() => replay.events.length === 3);
  const checked = replay.events.filter((e) => e.data.type === 'checked');
  assert.equal(checked.length, 1);
  assert.deepEqual((checked[0]!.data as { status: CheckStatus }).status.up, true);
  assert.deepEqual(
    replay.events.map((e) => ('kind' in e.data ? e.data.kind : e.data.type)),
    ['checkDown', 'checked', 'checkUp'], // a result, then what it changed
  );
});

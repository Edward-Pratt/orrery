// `startHub` with each integration on or off: a Minecraft + Discord hub relays mod chat to its frontend, audits a
// command and shuts down cleanly; with Minecraft off there is no Mod port (a minecraft server's uptime stays unknown);
// with Discord off no frontend starts and the hub still pings; Discord without `DISCORD_TOKEN` fails at startup; a web
// + host hub with an offline demo server starts without a bot; with web off there is no HTTP API.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Integrations, ServerCard, ServerDetail } from '../src/api.ts';
import type { Config } from '../src/config.ts';
import { Db } from '../src/stats/db.ts';
import type { HubEvent, ServerHub } from '../src/servers/servers.ts';
import { startHub } from '../src/start.ts';
import { online, sleep, until } from './fake-mod.ts';
import { config, loginCookie, WEB } from './web/web-hub.ts';
import { MINECRAFT, DISCORD, GB } from './start-hub.ts';

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

test("with integrations.minecraft off, a minecraft server's uptime stays unknown: no Mod port, so no grace 'down'", async (t) => {
  const rows = async (integrations: Config['integrations']) => {
    const cfg = config(t, integrations);
    const handle = await startHub(cfg, { startFrontend: async () => ({ stop() {} }), get: () => assert.fail('no ping within a test'), hub: { graceMs: 50 } });
    await sleep(200);
    await handle.close();
    const db = new DatabaseSync(cfg.dbPath);
    try {
      return db.prepare("SELECT state, reason FROM events WHERE reason != 'hub start'").all().map((r) => ({ ...r }));
    } finally {
      db.close();
    }
  };
  assert.deepEqual(await rows({ discord: DISCORD }), []);
  assert.deepEqual(await rows({ minecraft: MINECRAFT }), [{ state: 'down', reason: 'offline' }]); // its Mod could have connected
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
    db.auditLog(10).map(({ ts: _, id: __, ...e }) => e),
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

test("a hub with web and host only and an offline demo server starts without a bot and shows demo with nothing to act on", async (t) => {
  const { healthcheckUrl: _, ...base } = config(t, { web: WEB, host: { id: 'oracle', mounts: ['/'], memoryMaxPercent: 90, memoryMinutes: 5, diskMinFreeGB: 10 } });
  const cfg: Config = {
    ...base,
    servers: [{ id: 'demo', name: 'Demo', game: 'minecraft', backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' }],
  };
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('no health ping or checks'),
    host: {
      cpu: () => ({ idle: 1, total: 2 }),
      load: () => [0, 0, 0],
      memory: async () => ({ total: 16 * GB, available: 8 * GB }),
      disk: async () => ({ free: 50 * GB, total: 100 * GB }),
    },
  });
  t.after(() => handle.close());
  assert.equal(handle.port, undefined);
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  const get = async (path: string) => (await app.request(path, { headers: { cookie } })).json();
  const [demo] = (await get('/api/servers')) as ServerCard[];
  assert.equal(demo!.id, 'demo');
  assert.equal(demo!.online, false);
  assert.equal(demo!.tps, null);
  assert.equal(demo!.service, null);
  assert.equal(demo!.packUpdate, null);
  assert.deepEqual(demo!.features, { chat: false, tps: false, quests: false, console: false, update: false, settings: false, upload: false });
  assert.deepEqual(((await get('/api/servers/demo')) as ServerDetail).backups, { configured: false });
  assert.deepEqual(await get('/api/integrations'), {
    minecraft: false, discord: false, web: true, checks: false, host: true, systemd: false, github: false, agents: false, library: false, newServer: false,
  } satisfies Integrations);
});

test('with web off the hub has no HTTP API', async (t) => {
  const handle = await startHub(config(t, { minecraft: MINECRAFT }), {
    startFrontend: () => assert.fail('Discord is off'),
    get: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(handle.web, undefined);
  await handle.close();
});

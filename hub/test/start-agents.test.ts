// The agents integration: a factorio server's card (with and without game updates), an Agent's server watched for hangs
// without Minecraft, an Agent's bye and a lost Agent's host notice, each Agent's Host served without the host
// integration, a hub starting while the Agent port waits for its address, and links redeemed in each game.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { HostNow, HostSample } from '../src/api.ts';
import { postTargets } from '../src/discord/discord.ts';
import { formatEvent, type Post } from '../src/discord/format.ts';
import { formatTargetEvent } from '../src/discord/format-target.ts';
import type { Links } from '../src/servers/links.ts';
import { startHub } from '../src/start.ts';
import { online, sleep, until } from './fake-mod.ts';
import { ADMIN, loginCookie, WEB } from './web/web-hub.ts';
import { MINECRAFT, DISCORD, cardsOf, post, AGENTS, agentConfig, agentOnline, FACTORIO_UNIT } from './start-hub.ts';

test("a factorio server's card has its game and the UPS rate, the game connection's chat, rate and console, and game updates", async (t) => {
  const cfg = agentConfig(t, { web: WEB, systemd: [FACTORIO_UNIT] });
  cfg.servers.find((s) => s.id === 'space')!.service = 'factorio';
  const handle = await startHub(cfg, { startFrontend: async () => ({ stop: () => {} }), get: async () => ({ ok: true, status: 200 }), run: async () => '' });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const cards = await cardsOf(app, await loginCookie(handle.web!));
  const card = cards.find((c) => c.id === 'space');
  assert.deepEqual(
    { game: card!.game, rate: card!.rate, tps: card!.tps, features: card!.features },
    // Over its Agent's game connection; game updates only through an Agent, with GameUpdates (systemd on). Quests are the Mod's alone.
    { game: 'factorio', rate: { label: 'UPS', max: 60 }, tps: null, features: { chat: true, tps: true, quests: false, console: true, update: true, settings: true, upload: true } },
  );
  assert.equal(cards.find((c) => c.id === 'gtnh')!.features.update, false); // no Agent runs it
});

test("without GameUpdates (no systemd, so no Services to stop it), an Agent's server has no game updates", async (t) => {
  const cfg = agentConfig(t, { web: WEB });
  const handle = await startHub(cfg, { startFrontend: async () => ({ stop: () => {} }), get: async () => ({ ok: true, status: 200 }) });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  assert.equal((await cardsOf(app, cookie)).find((c) => c.id === 'space')!.features.update, false);
  assert.equal((await app.request('/api/servers/space/game', { headers: { cookie } })).status, 404);
});

test("with agents but no Minecraft integration, an Agent's server is watched for hangs", async (t) => {
  const cfg = agentConfig(t, {});
  delete cfg.healthcheckUrl;
  const handle = await startHub(cfg, { startFrontend: () => assert.fail('Discord is off'), get: () => assert.fail('nothing to request'), hub: { hungMs: 200 } });
  t.after(() => handle.close());
  assert.equal(handle.port, undefined); // no Mod port
  const { agent, game } = await agentOnline(await handle.agentPort!);
  game.send({ type: 'heartbeat', tps: 60, players: ['Ann'] });
  const pings = setInterval(() => agent.send({ type: 'ping' }), 50);
  t.after(() => clearInterval(pings));
  const types = () => handle.live.since().flatMap(([, e]) => ('serverId' in e && e.serverId === 'space' ? [e.type] : []));
  await until(() => types().includes('hung'));
  assert.deepEqual(types(), ['connected', 'tps', 'hung']);
});

test("an Agent's bye records its server lost, as unknown, and posts nothing; a lost Agent posts one host notice", async (t) => {
  const cfg = agentConfig(t, { discord: { ...DISCORD, channels: { ...DISCORD.channels, space: '9'.repeat(18) }, alertsChannel: '4'.repeat(18) } });
  delete cfg.healthcheckUrl;
  const posted: [string, Post][] = [];
  const handle = await startHub(cfg, {
    startFrontend: async (hub, _s, _r, _l, discord) => {
      // What the Discord frontend posts: server events in their channel, the rest in the alerts channel.
      hub.on('event', (e) => {
        const post = formatEvent(e);
        if (post) posted.push([discord.channels[e.serverId]!, post]);
      });
      postTargets(hub, discord, async (channelId, message) => void posted.push([channelId, message]));
      return { stop: () => {} };
    },
    get: () => assert.fail('nothing to request'),
    agents: { handshakeMs: 0 }, // it reconnects at once
  });
  const port = await handle.agentPort!;
  const first = await agentOnline(port);
  first.agent.send({ type: 'bye' });
  await first.game.closed;
  const second = await agentOnline(port);
  second.agent.socket.destroy(); // lost
  await second.game.closed;
  await until(() => posted.length === 1);
  await agentOnline(port); // back
  await until(() => posted.length === 2);
  await handle.close();
  assert.deepEqual(posted, [
    ['4'.repeat(18), formatTargetEvent({ target: 'host', id: 'vm', type: 'notice', severity: 'warning', kind: 'agentLost', name: 'Factorio VM' })!],
    ['4'.repeat(18), formatTargetEvent({ target: 'host', id: 'vm', type: 'notice', severity: 'good', kind: 'agentBack', name: 'Factorio VM' })!],
  ]);
  const db = new DatabaseSync(cfg.dbPath);
  t.after(() => db.close());
  const rows = db.prepare("SELECT state, reason FROM events WHERE server_id = 'space' AND reason NOT LIKE 'hub %' ORDER BY ts, rowid").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { state: 'up', reason: 'connected' },
    { state: 'unknown', reason: 'lost' },
    { state: 'up', reason: 'connected' },
    { state: 'unknown', reason: 'lost' },
    { state: 'up', reason: 'connected' },
  ]);
});

test("with agents but no host integration, each Agent's Host is served with its own samples, and /api/host is not", async (t) => {
  const cfg = agentConfig(t, { web: WEB });
  const handle = await startHub(cfg, { startFrontend: () => assert.fail('Discord is off'), get: async () => ({ ok: true, status: 200 }) });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  const get = async <T>(path: string) => {
    const res = await app.request(path, { headers: { cookie } });
    assert.equal(res.status, 200, path);
    return res.json() as Promise<T>;
  };
  assert.deepEqual(await get<HostNow[]>('/api/hosts'), [{ id: 'vm', sample: null, node: null }]);
  const { agent } = await agentOnline(await handle.agentPort!);
  const sample: HostSample = { ts: Date.now(), cpu: 0.5, load: [1, 1, 1], memory: { used: 2, total: 8 }, disks: [{ mount: '/', free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 }] };
  agent.send({ type: 'hostSample', sample });
  await until(() => handle.hosts.get('vm')!.latest() !== null);
  const stored = handle.hosts.get('vm')!.latest()!; // stamped with the hub's clock
  assert.ok(stored.ts >= sample.ts && stored.ts <= Date.now());
  assert.deepEqual(stored, { ...sample, ts: stored.ts });
  assert.deepEqual(await get<HostNow[]>('/api/hosts'), [{ id: 'vm', sample: stored, node: null }]);
  assert.deepEqual(await get<HostSample[]>('/api/hosts/vm/samples?hours=1'), [stored]);
  assert.equal((await app.request('/api/host', { headers: { cookie } })).status, 404);
  assert.equal((await app.request('/api/hosts/oracle/samples', { headers: { cookie } })).status, 404);
});

test('the hub starts while the Agent port waits for its address, and closes without it', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const cfg = agentConfig(t, {});
  cfg.integrations.agents = { ...AGENTS, listen: { host: '192.0.2.1', port: 0 } }; // TEST-NET-1: never this machine's
  delete cfg.healthcheckUrl;
  const handle = await startHub(cfg, { startFrontend: () => assert.fail('Discord is off'), get: () => assert.fail('nothing to request'), agents: { bindRetryMs: 20 } });
  assert.equal(await Promise.race([handle.agentPort!, sleep(100).then(() => 'waiting')]), 'waiting');
  await handle.close();
  assert.deepEqual(errors.mock.calls.map((c) => c.arguments[0]), ['[agents] 192.0.2.1 is not on this machine yet: trying again every 0.02 s']);
});

test("a link is redeemed in each game, chat from the dashboard names the user by the server's game, and /unlink clears both", async (t) => {
  const cfg = agentConfig(t, { minecraft: MINECRAFT, discord: DISCORD, web: WEB });
  delete cfg.healthcheckUrl;
  let links: Links | undefined;
  const handle = await startHub(cfg, {
    startFrontend: async (_h, _s, _r, l) => {
      links = l;
      return { stop: () => {} };
    },
    get: () => assert.fail('nothing to request'),
  });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  const mod = await online(handle.port!);
  const { game } = await agentOnline(await handle.agentPort!);

  mod.send({ type: 'link', player: 'Steve', uuid: 'u1', code: links!.issue(ADMIN.id, 'alex') });
  assert.deepEqual(await mod.next(), { type: 'linkResult', player: 'Steve', ok: true, message: 'Linked to alex on Discord.' });
  game.send({ type: 'link', player: 'engineer', uuid: '', code: links!.issue(ADMIN.id, 'alex') });
  assert.deepEqual(await game.next(), { type: 'linkResult', player: 'engineer', ok: true, message: 'Linked to alex on Discord.' });

  const chat = async (server: string, conn: { next: () => Promise<unknown> }) => {
    assert.equal((await post(app, cookie, `/api/servers/${server}/chat`, { message: 'hi' })).status, 204);
    return ((await conn.next()) as { author: string }).author;
  };
  assert.equal(await chat('gtnh', mod), 'Steve');
  assert.equal(await chat('space', game), 'engineer');

  assert.equal(links!.unlinkDiscord(ADMIN.id), true); // Discord's /unlink
  assert.equal(await chat('gtnh', mod), 'alex');
  assert.equal(await chat('space', game), 'alex');
});

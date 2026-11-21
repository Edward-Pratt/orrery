// The web API's integrations and server cards on `apiHub`: features with and without the mod, TPS, players, uptime and
// a pending restart, lagging, no service with systemd off, and one server's status, TPS, top players per period and
// backups.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Integrations, PlayerAnswer, ServerCard, ServerDetail } from '../src/api.ts';
import { online, sleep, until } from './fake-mod.ts';
import { apiHub } from './start-hub.ts';

const MOD = { chat: true, tps: true, quests: true, console: true, update: false, settings: false, upload: false };
const NO_MOD = { chat: false, tps: false, quests: false, console: false, update: false, settings: false, upload: false };

test('the API says which integrations are on, and nothing else about them', async (t) => {
  const { get } = await apiHub(t);
  assert.deepEqual(await get<Integrations>('/api/integrations'), { minecraft: true, discord: true, web: true, checks: false, host: false, systemd: false, github: false, agents: false, library: false, newServer: false });
});

test('server cards while offline: features only for the server with the mod', async (t) => {
  const { get } = await apiHub(t);
  const offline = { online: false, hung: false, paused: false, tps: null, players: [], uptimeDay: null, restart: null, lagging: false, service: null };
  assert.deepEqual(await get<ServerCard[]>('/api/servers'), [
    { id: 'gtnh', name: 'GTNH', game: 'minecraft', rate: { label: 'TPS', max: 20 }, ...offline, features: MOD, packUpdate: null },
    { id: 'web', name: 'Website', game: 'minecraft', rate: { label: 'TPS', max: 20 }, ...offline, features: NO_MOD, packUpdate: null },
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
  assert.deepEqual(rest, { id: 'gtnh', name: 'GTNH', game: 'minecraft', rate: { label: 'TPS', max: 20 }, online: true, hung: false, paused: false, tps: 19.5, players: ['Steve'], lagging: false, service: null, features: MOD, packUpdate: null });
  assert.equal(uptimeDay, 1);
  assert.equal(restart?.by, 'alice');
  assert.ok(restart!.at > Date.now());
});

test("a card's lagging follows the lag and lagRecovered notices", async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] }); // the lag monitor samples on a 60 s interval
  const { get, hub, port } = await apiHub(t);
  const lagging = async () => (await get<ServerCard[]>('/api/servers'))[0]!.lagging;
  const mod = await online(port);
  const beat = async (tps: number) => {
    mod.send({ type: 'heartbeat', tps, players: [] });
    await until(() => hub.get('gtnh')?.tps === tps);
    t.mock.timers.tick(60_000);
  };
  await beat(10);
  assert.equal(await lagging(), false); // one low minute isn't lag yet
  await beat(11);
  assert.equal(await lagging(), true);
  await beat(20);
  assert.equal(await lagging(), false);
});

test('a card has no service with systemd off', async (t) => {
  const { get } = await apiHub(t);
  assert.equal((await get<ServerCard[]>('/api/servers'))[0]!.service, null);
});

test('one server: status, TPS, top players per period and backups', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] }); // playtime syncs on a 10 s interval
  const { get, hub, port } = await apiHub(t);
  const offline = await get<ServerDetail>('/api/servers/gtnh');
  assert.equal(offline.card.online, false);
  assert.deepEqual(offline.status, { state: { id: 'gtnh', name: 'GTNH', game: 'minecraft', online: false, hung: false, paused: false, tps: null, players: [], dims: [] }, uptimeDay: null, uptimeWeek: null });
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

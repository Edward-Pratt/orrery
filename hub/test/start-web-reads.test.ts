// The web API's reads: a server's log files and crash reports (`logsHub`; a log is read only by a name the listing
// gives), the audit log (newest first, paging, filters), a server's history, and 404s for unknown servers and players,
// every read needing a session.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AuditLog, ServerDetail, ServerHistory, ServerLog, ServerLogFiles } from '../src/api.ts';
import { startHub } from '../src/start.ts';
import { online, sleep, until } from './fake-mod.ts';
import { config, loginCookie, WEB } from './web/web-hub.ts';
import { MINECRAFT, apiHub, UP } from './start-hub.ts';

/** A hub whose gtnh has a folder with a log, a crash report and the hub's config next to them; web has no folder. */
async function logsHub(t: TestContext) {
  const cfg = config(t, { minecraft: MINECRAFT, web: WEB });
  const dir = join(dirname(cfg.dbPath), 'gtnh');
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'crash-reports'));
  writeFileSync(join(dir, 'config.json'), '{"token":"secret"}');
  writeFileSync(join(dir, 'logs', 'latest.log'), 'one\ntwo\n');
  utimesSync(join(dir, 'logs', 'latest.log'), 3000, 3000);
  writeFileSync(join(dir, 'crash-reports', 'crash-1.txt'), 'boom\n');
  utimesSync(join(dir, 'crash-reports', 'crash-1.txt'), 2000, 2000);
  symlinkSync('../config.json', join(dir, 'logs', 'evil.log'));
  cfg.servers = [{ ...cfg.servers[0]!, dir }, { ...cfg.servers[0]!, id: 'web', name: 'Website' }];
  const handle = await startHub(cfg, { startFrontend: () => assert.fail('Discord is off'), get: async () => UP });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  return { request: (path: string) => app.request(path, { headers: { cookie } }) };
}

test("a server's logs: its log files and crash reports newest first, each file's tail by its listed name", async (t) => {
  const { request } = await logsHub(t);
  assert.equal(((await (await request('/api/servers/gtnh')).json()) as ServerDetail).logs, true);
  assert.equal(((await (await request('/api/servers/web')).json()) as ServerDetail).logs, false);
  assert.deepEqual(await (await request('/api/servers/gtnh/logs')).json(), [
    { name: 'latest.log', size: 8, modified: 3000 * 1000 },
    { name: 'crash-1.txt', size: 5, modified: 2000 * 1000 },
  ] satisfies ServerLogFiles);
  assert.deepEqual(await (await request('/api/servers/gtnh/logs/latest.log')).json(), { lines: ['one', 'two'] } satisfies ServerLog);
  assert.deepEqual(await (await request('/api/servers/gtnh/logs/crash-1.txt')).json(), { lines: ['boom'] } satisfies ServerLog);
});

test("a log is only one the listing names: paths, unlisted files and symlinks are 404, as are unknown or folderless servers", async (t) => {
  const { request } = await logsHub(t);
  for (const name of ['..%2Fconfig.json', '..%2F..%2Fhub.db', 'config.json', 'logs%2Flatest.log', 'evil.log', 'nope.log', '%2E%2E']) {
    assert.equal((await request(`/api/servers/gtnh/logs/${name}`)).status, 404, name);
  }
  assert.equal((await request('/api/servers/gtnh/logs/../config.json')).status, 404);
  for (const path of ['/api/servers/nope/logs', '/api/servers/nope/logs/latest.log', '/api/servers/web/logs', '/api/servers/web/logs/latest.log']) {
    assert.equal((await request(path)).status, 404, path);
  }
});

test('the audit log reads newest first, for all servers or one', async (t) => {
  const { get, restarts, port } = await apiHub(t);
  await online(port);
  restarts.schedule('gtnh', 10, 'discord:alice (1)', 'alice');
  restarts.cancel('gtnh', 'discord:bob (2)', 'bob');
  // Not the hub's own in-game warnings, whose timing varies.
  const byPeople = (log: AuditLog) => log.entries.filter((e) => e.actor.startsWith('discord:'));
  const log = byPeople(await get<AuditLog>('/api/audit'));
  assert.deepEqual(log.map(({ ts: _, id: __, ...e }) => e), [
    { actor: 'discord:bob (2)', action: 'restart cancel', target: 'gtnh', details: '' },
    { actor: 'discord:alice (1)', action: 'restart', target: 'gtnh', details: 'in 10 min' },
  ]);
  assert.deepEqual(byPeople(await get<AuditLog>('/api/audit?server=gtnh')), log);
  assert.deepEqual(await get<AuditLog>('/api/audit?server=web'), { entries: [], older: false });
});

test('the audit log pages back with before, filters by actor and server, and says when nothing is older', async (t) => {
  const { get, hub, app, cookie } = await apiHub(t);
  // More than a batch, in one millisecond or so: the cursor identifies an entry, not a time.
  for (let i = 0; i < 205; i++) hub.audit(i % 2 ? 'discord:bob (2)' : 'discord:alice (1)', 'command', 'gtnh', `n${i}`);
  const first = await get<AuditLog>('/api/audit');
  assert.equal(first.entries.length, 200);
  assert.equal(first.older, true);
  const rest = await get<AuditLog>(`/api/audit?before=${first.entries.at(-1)!.id}`);
  assert.equal(rest.older, false);
  const seen = [...first.entries, ...rest.entries].map((e) => e.id);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(
    [...first.entries, ...rest.entries].filter((e) => e.action === 'command' && e.details.startsWith('n')).map((e) => e.details),
    Array.from({ length: 205 }, (_, i) => `n${204 - i}`),
  );
  const bob = await get<AuditLog>('/api/audit?actor=discord:bob%20(2)&server=gtnh');
  assert.equal(bob.entries.length, 102);
  assert.ok(bob.entries.every((e) => e.actor === 'discord:bob (2)' && e.target === 'gtnh'));
  assert.equal(bob.older, false);
  assert.deepEqual((await get<AuditLog>('/api/audit?actor=discord:bob%20(2)&server=web')).entries, []);
  for (const before of ['0', '-1', 'abc', '1.5']) assert.equal((await app.request(`/api/audit?before=${before}`, { headers: { cookie } })).status, 400);
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

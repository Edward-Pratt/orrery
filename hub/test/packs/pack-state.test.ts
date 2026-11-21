// A server's Pack: whether it has one, its Kept paths and its Java runtime (`pack-state.ts`).

import assert from 'node:assert/strict';
import { existsSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PackState, ServerDetail } from '../../src/api.ts';
import { world } from './pack-world.ts';
import { start } from './pack-hub.ts';
import { runtimeHub } from './library-hub.ts';

test('a server with a folder, a service and a Mod has a Pack: Kept paths from keep first, then the built-in ones', async (t) => {
  const w = world(t);
  const s = await start(t, w, { server: { backupDir: join(w.dir, 'backups') } });
  const p = await s.pack();
  assert.equal(p.installed, null);
  assert.deepEqual(p.kept, {
    server: ['config/JourneyMapServer', 'journeymap/'],
    builtIn: [
      'World/',
      'server.properties',
      'ops.json',
      'whitelist.json',
      'banned-players.json',
      'banned-ips.json',
      'usercache.json',
      'eula.txt',
      'server-icon.png',
      'logs/',
      'crash-reports/',
      'backups/',
      '.pre-update-*/',
      '.orrery-update/',
      '.orrery-staging/',
      'mods/gtnhdiscord-*.jar',
      'mods/orrery-*.jar',
    ],
  });
  assert.deepEqual([p.history, p.extras, p.edits, p.pending, p.running, p.rolledBack], [[], [], [], [], null, null]);
  assert.equal(p.mod, 'mods/orrery-1.7.10-1.4.0.jar');
  assert.deepEqual(p.packFiles, []);
  assert.equal((await s.json<ServerDetail>(s.req('GET', '/api/servers/gtnh'))).pack, true);
});

test('the world defaults to "world" without a level-name; a backup folder outside the server folder is not listed', async (t) => {
  const w = world(t);
  rmSync(join(w.dir, 'server.properties'));
  const s = await start(t, w);
  const { builtIn } = (await s.pack()).kept;
  assert.equal(builtIn[0], 'world/');
  assert.ok(!builtIn.includes('backups/'));
});

test('no Pack without a folder, a linked service or a Mod token', async (t) => {
  for (const without of ['dir', 'service', 'token'] as const) {
    const w = world(t);
    if (without === 'token') {
      w.config.servers.push({ ...w.config.servers[0]!, id: 'other', name: 'Other', service: undefined });
      w.config.integrations.systemd!.push({ id: 'other', unit: 'other.service' });
      w.config.servers[1]!.service = 'other';
    }
    const s = await start(t, w, without === 'dir' ? { server: { dir: undefined } } : without === 'service' ? { server: { service: undefined } } : {});
    const id = without === 'token' ? 'other' : 'gtnh';
    assert.equal((await s.req('GET', `/api/servers/${id}/pack`)).status, 404, without);
    assert.equal((await s.req('POST', `/api/servers/${id}/pack/compare`, { library: 1 })).status, 404, without);
    assert.equal((await s.json<ServerDetail>(s.req('GET', `/api/servers/${id}`))).pack, false, without);
    await s.close();
  }
});

test('without systemd there are no pack routes', async (t) => {
  const w = world(t);
  delete w.config.integrations.systemd;
  const s = await start(t, w, { server: { service: undefined } });
  assert.equal((await s.req('GET', '/api/servers/gtnh/pack')).status, 404);
  assert.equal((await s.json<ServerDetail>(s.req('GET', '/api/servers/gtnh'))).pack, false);
});

test("a server's runtime: the link swapped, pending until its next start, removed for system java; the unit lines when it lacks them", async (t) => {
  const { s, lib, addRuntime, finished, data } = await runtimeHub(t);
  await addRuntime();
  await finished();
  const link = join(data, 'java', 'gtnh');
  let p = await s.pack();
  assert.deepEqual(p.runtime, { name: null, pending: false, unitLines: [`Environment=PATH=${link}/bin:/usr/local/bin:/usr/bin:/bin`, `Environment=JAVA_HOME=${link}`] });
  s.fake.environment = `PATH=${link}/bin:/usr/local/bin:/usr/bin:/bin JAVA_HOME=${link}`;
  p = await s.json<PackState>(s.req('PUT', '/api/servers/gtnh/pack/runtime', { runtime: 'temurin-21.0.8+9' }));
  assert.deepEqual(p.runtime, { name: 'temurin-21.0.8+9', pending: true, unitLines: null });
  assert.equal(readlinkSync(link), join(data, 'runtimes', 'temurin-21.0.8+9'));
  assert.deepEqual((await lib()).runtimes[0]!.usedBy, ['gtnh']);
  // Deleting it now is refused, naming the server.
  const refused = await s.req('DELETE', '/api/library/runtimes/temurin-21.0.8+9');
  assert.equal(refused.status, 409);
  assert.equal(await refused.text(), 'temurin-21.0.8+9 is what gtnh runs on.');
  await s.connect(); // the server's next start
  assert.equal((await s.pack()).runtime.pending, false);
  for (const runtime of ['temurin-17.0.1+1', '../etc', 7]) assert.equal((await s.req('PUT', '/api/servers/gtnh/pack/runtime', { runtime })).status, 404, String(runtime));
  p = await s.json<PackState>(s.req('PUT', '/api/servers/gtnh/pack/runtime', { runtime: null }));
  assert.deepEqual(p.runtime, { name: null, pending: true, unitLines: null });
  assert.ok(!existsSync(link));
  assert.equal((await s.req('DELETE', '/api/library/runtimes/temurin-21.0.8+9')).status, 204);
  assert.deepEqual((await lib()).runtimes, []);
  assert.ok(!existsSync(join(data, 'runtimes', 'temurin-21.0.8+9')));
  assert.equal((await s.req('DELETE', '/api/library/runtimes/temurin-21.0.8+9')).status, 404);
  assert.deepEqual((await s.audit('pack runtime')).map((e) => `${e.target}: ${e.details}`), ['gtnh: temurin-21.0.8+9', 'gtnh: system java']);
  assert.deepEqual((await s.audit('library runtime delete')).map((e) => e.details), ['temurin-21.0.8+9']);
});

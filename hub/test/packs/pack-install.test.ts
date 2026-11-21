// New server (#142, `pack-install.ts`).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Integrations, NewServerAnswer, PackState, PendingServers, StartScripts } from '../../src/api.ts';
import { LOOP } from '../../src/packs/packs.ts';
import { Db } from '../../src/stats/db.ts';
import type { HubDeps } from '../../src/start.ts';
import { ACTOR } from '../web/web-hub.ts';
import { sleep, until } from '../fake-mod.ts';
import { world, type World } from './pack-world.ts';
import { start } from './pack-hub.ts';
import { runtimeHub } from './library-hub.ts';

const URL_SERVER = 'https://packs.example/GTNH_2.7.6_Server.zip';
const LOOPING = '#!/bin/bash\nwhile true; do\n  java -Xms6G -Xmx6G -Dfml.readTimeout=180 @java9args.txt -jar lwjgl3ify-forgePatches.jar nogui\n  echo "Restarting in 10 s"\n  sleep 10\ndone\n';
const PACK_SERVER = {
  'mods/gregtech.jar': 'gt 2',
  'config/gregtech.cfg': 'pollution=true\n',
  'server.properties': 'level-name=world\nserver-port=25565\nmotd=pack default\n',
  'startserver-java9.sh': LOOPING,
  'startserver.sh': '#!/bin/bash\njava -Xms6G -Xmx6G -jar forge.jar nogui\n',
  'run-plain.sh': 'java -jar forge.jar nogui\n',
  'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar': 'forge',
};
/** Another pack, for a Minecraft version no Mod release has a build for. */
const URL_FORGE_OTHER = (w: World) => {
  const url = 'https://packs.example/Other_9.9.9.zip';
  w.urls[url] = w.zip('Other_9.9.9.zip', { ...PACK_SERVER, 'startserver.sh': 'java -Xmx1G -jar x.jar\n' });
  return url;
};
const FORM = { id: 'new-1', name: 'New One', gamePort: 25570, memory: '8G', startScript: 'startserver-java9.sh', runtime: null, eula: true, removeLoop: true };

/**
 * A hub with GitHub on (a Mod release with a 1.7.10 build) and a server pack in the library (2.7.6, under a folder in
 * its zip), recording `install` events. `mod.gate` holds the Mod's download; `mod.fails` makes it fail.
 */
async function newServerHub(t: TestContext) {
  const w = world(t);
  w.urls[URL_SERVER] = w.zip('GTNH_2.7.6_Server.zip', PACK_SERVER, 'GTNH_2.7.6_Server');
  w.config.integrations.github = {
    repo: 'Edward-Pratt/orrery',
    newerAfterDays: 14,
    deploys: { root: join(w.root, 'data'), hubUnit: 'orrery-hub.service', hubTemplate: 'orrery-deploy', webTemplate: 'orrery-deploy-web', webDir: join(w.root, 'www') },
  };
  const mod = { gate: Promise.resolve(), fails: false };
  const github: HubDeps['github'] = {
    releases: async () => [
      { tag: 'hub-v2.7.0', draft: false, prerelease: false, publishedAt: 1, assets: [] },
      { tag: 'mod-v1.5.0', draft: false, prerelease: false, publishedAt: 2, assets: ['orrery-1.7.10-1.5.0.jar'] },
      { tag: 'mod-v1.4.0', draft: false, prerelease: false, publishedAt: 1, assets: ['gtnhdiscord-1.4.0.jar'] },
    ],
    download: async (tag, asset) => {
      await mod.gate;
      if (mod.fails) throw new Error('GitHub: HTTP 502');
      return new TextEncoder().encode(`${tag} ${asset}`);
    },
  };
  const h = await runtimeHub(t, { setup: { github }, w });
  const { s } = h;
  while ((await s.json<{ checkedAt: number | null }>(s.req('GET', '/api/deploys'))).checkedAt === null) await sleep(5);
  const steps: string[] = [];
  s.handle.live.on('event', (_, e) => {
    if ('target' in e && e.type === 'install') steps.push(`${e.id} ${e.step}${e.detail ? `: ${e.detail}` : ''}`);
  });
  const { library } = await s.entry(URL_SERVER, '2.7.6');
  const install = (form: object = {}) => s.req('POST', '/api/servers', { ...FORM, library, ...form });
  /** Waits for an install to end; returns its last step. */
  const ended = async (n = 1) => {
    await until(() => steps.filter((x) => / (done|failed)/.test(x)).length >= n);
    return steps.filter((x) => / (done|failed)/.test(x))[n - 1]!;
  };
  const pending = () => s.json<PendingServers>(s.req('GET', '/api/servers/pending'));
  const folder = join(h.data, 'servers', 'new-1');
  /** Whether anything an install writes is on disk or in the database. */
  const nothing = async () => {
    assert.ok(!existsSync(folder), 'no folder');
    assert.ok(!existsSync(join(h.data, 'java', 'new-1')), 'no Java link');
    assert.deepEqual((await pending()).pending, []);
    const db = new Db(w.config.dbPath);
    try {
      assert.equal(db.hasPackData('new-1'), false);
    } finally {
      db.close();
    }
  };
  return { ...h, w, s, mod, steps, library, install, ended, pending, folder, nothing };
}

test("New server: a pack's start scripts are its content root's .sh files, each saying whether it loops", async (t) => {
  const { s, library } = await newServerHub(t);
  assert.deepEqual(await s.json<StartScripts>(s.req('GET', `/api/library/packs/${library}/scripts`)), {
    scripts: [
      { name: 'run-plain.sh', loops: false, memory: false },
      { name: 'startserver-java9.sh', loops: true, memory: true },
      { name: 'startserver.sh', loops: false, memory: true },
    ],
  });
  assert.equal((await s.req('GET', '/api/library/packs/99/scripts')).status, 404);
  assert.equal((await s.json<Integrations>(s.req('GET', '/api/integrations'))).newServer, true);
});

test('New server: each refusal comes before anything is written', async (t) => {
  const h = await newServerHub(t);
  const { s, install, nothing } = h;
  const other = await s.entry(URL_FORGE_OTHER(h.w), '9.9.9', '1.6.4');
  h.s.fake.units.push('taken.service');
  for (const [form, status, why] of [
    [{ id: 'New_1' }, 400, 'The id must be a lowercase letter, then up to 31 lowercase letters, digits or dashes.'],
    [{ id: 'gtnh' }, 409, 'The id gtnh is a server in config already.'],
    [{ gamePort: 25565 }, 409, "Port 25565 is GTNH's game port."],
    [{ gamePort: 70000 }, 400, 'The game port must be 1–65535.'],
    [{ id: 'taken' }, 409, 'systemd has a unit taken.service already: pick another id.'],
    [{ library: other.library }, 409, 'No Mod release has a build for Minecraft 1.6.4.'],
    [{ eula: false }, 400, 'Accept the Minecraft EULA to install a server.'],
    [{ memory: '8 GB' }, 400, 'Memory is a size like 6G or 512M.'],
    [{ startScript: 'run.sh' }, 400, "run.sh isn't a start script in GT New Horizons 2.7.6."],
    [{ startScript: '../x.sh' }, 400, 'Pick a start script from the pack.'],
    [{ startScript: 'run-plain.sh' }, 400, 'run-plain.sh sets no -Xmx or -Xms for the memory: pick another start script.'],
    [{ runtime: 'temurin-21.0.8+9' }, 404, 'No such runtime in the library.'],
    [{ library: 99 }, 404, 'No such pack in the library.'],
  ] as const) {
    const res = await install(form);
    assert.equal(res.status, status, JSON.stringify(form));
    assert.equal(await res.text(), why);
    await nothing();
  }
  assert.deepEqual(h.steps, []);
});

test('New server: the install unpacks the pack, writes eula.txt, the port, the Mod and orrery.cfg, and applies the memory and loop edits', async (t) => {
  const { s, w, install, ended, pending, folder, steps, data } = await newServerHub(t);
  assert.deepEqual(await s.json<NewServerAnswer>(install(), 202), { id: 'new-1' });
  assert.equal(await ended(), 'new-1 done');
  assert.deepEqual(steps.map((x) => x.split(':')[0]), ['new-1 unpack', 'new-1 write', 'new-1 mod', 'new-1 write', 'new-1 done']);
  assert.match(readFileSync(join(folder, 'eula.txt'), 'utf8'), /^eula=true$/m);
  assert.equal(readFileSync(join(folder, 'server.properties'), 'utf8'), 'level-name=world\nserver-port=25570\nmotd=pack default\n');
  assert.equal(readFileSync(join(folder, 'mods', 'orrery-1.7.10-1.5.0.jar'), 'utf8'), 'mod-v1.5.0 orrery-1.7.10-1.5.0.jar');
  // The memory and loop edits together leave one java line, with the chosen heap.
  assert.equal(readFileSync(join(folder, 'startserver-java9.sh'), 'utf8'), '#!/bin/bash\n  java -Xms8G -Xmx8G -Dfml.readTimeout=180 @java9args.txt -jar lwjgl3ify-forgePatches.jar nogui\n');
  assert.equal(readFileSync(join(folder, 'startserver.sh'), 'utf8'), PACK_SERVER['startserver.sh']); // not the chosen one
  const pendingFile = JSON.parse(readFileSync(join(folder, '.orrery-pending.json'), 'utf8'));
  assert.deepEqual(Object.keys(pendingFile), ['name', 'startScript', 'token']);
  assert.equal(pendingFile.name, 'New One');
  assert.equal(pendingFile.startScript, 'startserver-java9.sh');
  assert.match(pendingFile.token, /^[0-9a-f]{64}$/);
  assert.equal(statSync(join(folder, '.orrery-pending.json')).mode & 0o777, 0o600);
  const cfg = readFileSync(join(folder, 'config', 'orrery.cfg'), 'utf8');
  for (const line of ['S:hubHost=127.0.0.1', `I:hubPort=${s.handle.port}`, 'S:serverId=new-1', `S:token=${pendingFile.token}`]) assert.ok(cfg.includes(`    ${line}\n`), line);
  assert.ok(!existsSync(join(data, 'java', 'new-1'))); // system java
  assert.deepEqual(readdirSync(join(data, 'work')), []);

  const { pending: [p], installing } = await pending();
  assert.equal(installing, null);
  assert.deepEqual({ ...p!, at: 0 }, {
    id: 'new-1',
    name: 'New One',
    dir: folder,
    gamePort: 25570,
    runtime: null,
    by: 'alex',
    at: 0,
    command: `sudo /usr/local/lib/orrery/add-server.sh new-1 ${data} --hub-unit orrery-hub.service`,
    installScript: p!.installScript,
  });
  assert.match(p!.installScript ?? '', /^sudo install -D -m 755 -o root -g root -t \/usr\/local\/lib\/orrery \/.*\/deploy\/add-server\.sh$/);
  // The pack row and edits, under the new id; Kept paths (server.properties, eula.txt) and the Mod are not the pack's.
  const db = new Db(w.config.dbPath);
  t.after(() => db.close());
  assert.equal(db.pack('new-1')!.how, 'installed');
  assert.deepEqual(db.packFiles('new-1'), ['config/gregtech.cfg', 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar', 'mods/gregtech.jar', 'run-plain.sh', 'startserver-java9.sh', 'startserver.sh']);
  assert.deepEqual(db.configEdits('new-1').map((e) => [e.path, e.find, e.replace]), [
    ['startserver-java9.sh', '-Xm([sx])\\S+', '-Xm$18G'],
    ['startserver-java9.sh', LOOP, '$1'],
  ]);
  assert.deepEqual(await s.audit('server'), [
    { actor: ACTOR, action: 'server install', target: 'new-1', details: 'New One: GT New Horizons 2.7.6, port 25570, 8G, system java' },
    { actor: ACTOR, action: 'server install', target: 'new-1', details: 'New One: ok' },
  ]);
  // The id and the port are a Pending server's now.
  assert.equal(await (await install({ gamePort: 25571 })).text(), 'The id new-1 is a Pending server already.');
  assert.equal(await (await install({ id: 'new-2' })).text(), "Port 25570 is New One's game port.");
});

test('New server: a failed install leaves no folder, link or row, and a second install waits for the first', async (t) => {
  const h = await newServerHub(t);
  await h.addRuntime();
  assert.deepEqual(await h.finished(2), ['ok', '']); // after the pack's add
  h.mod.fails = true;
  let release!: () => void;
  h.mod.gate = new Promise((r) => (release = r));
  await h.s.json(h.install({ runtime: 'temurin-21.0.8+9' }), 202);
  await until(() => h.steps.some((x) => x.startsWith('new-1 mod')));
  assert.equal(readlinkSync(join(h.data, 'java', 'new-1')), join(h.data, 'runtimes', 'temurin-21.0.8+9'));
  assert.equal(await (await h.install({ id: 'new-2', gamePort: 25571 })).text(), 'New One is being installed: one install at a time.');
  assert.equal(await (await h.s.req('POST', '/api/library/runtimes', { feature: 21 })).text(), 'A New server install is running: add once it is done.');
  assert.equal((await h.pending()).installing?.step, 'mod');
  release();
  assert.equal(await h.ended(), 'new-1 failed: GitHub: HTTP 502');
  await h.nothing();
  assert.deepEqual(readdirSync(join(h.data, 'work')), []);
  assert.equal((await h.pending()).installing, null);
});

test('New server: Discard removes the folder, the Java link and the rows; it is refused once the id is in config', async (t) => {
  const h = await newServerHub(t);
  await h.addRuntime();
  assert.deepEqual(await h.finished(2), ['ok', '']); // after the pack's add
  await h.s.json(h.install({ runtime: 'temurin-21.0.8+9' }), 202);
  await h.ended();
  assert.equal((await h.pending()).pending[0]!.runtime, 'temurin-21.0.8+9');
  // In use by the Pending server: neither its pack nor its runtime can be deleted.
  assert.equal(await (await h.s.req('DELETE', `/api/library/packs/${h.library}`)).text(), 'GT New Horizons 2.7.6 is used by new-1.');
  assert.equal(await (await h.s.req('DELETE', '/api/library/runtimes/temurin-21.0.8+9')).text(), 'temurin-21.0.8+9 is what new-1 runs on.');
  assert.equal((await h.s.req('DELETE', '/api/servers/pending/nope')).status, 404);
  assert.equal((await h.s.req('DELETE', '/api/servers/pending/gtnh')).status, 409);
  assert.equal((await h.s.req('DELETE', '/api/servers/pending/new-1')).status, 204);
  await h.nothing();
  assert.equal((await h.s.req('DELETE', `/api/library/packs/${h.library}`)).status, 204);
  assert.deepEqual((await h.s.audit('server discard')).map((e) => `${e.target}: ${e.details}`), ['new-1: New One']);
});

test('New server: a hub deploy is refused while an install runs', async (t) => {
  const h = await newServerHub(t);
  h.mod.gate = new Promise(() => {});
  await h.s.json(h.install(), 202);
  const deploy = await h.s.req('POST', '/api/deploys', { part: 'hub', tag: 'hub-v2.7.0' });
  assert.equal(deploy.status, 409);
  assert.equal(await deploy.text(), 'A New server install is running: deploy the hub once it is done.');
});

test('New server: once its id is in config, the Pending server becomes a server at start, its pack installed', async (t) => {
  const h = await newServerHub(t);
  await h.s.json(h.install({ removeLoop: false }), 202);
  await h.ended();
  const token = JSON.parse(readFileSync(join(h.folder, '.orrery-pending.json'), 'utf8')).token as string;
  await h.s.close();
  // What add-server.sh adds to config.json.
  h.w.config.servers.push({ ...h.w.config.servers[0]!, id: 'new-1', name: 'New One', dir: h.folder, backupDir: join(h.folder, 'backups'), service: 'new-1', keep: [] });
  h.w.config.integrations.minecraft!.tokens['new-1'] = token;
  h.w.config.integrations.systemd!.push({ id: 'new-1', unit: 'new-1.service' });
  const again = await start(t, h.w, { github: { releases: async () => [], download: async () => new Uint8Array() } });
  assert.deepEqual((await again.json<PendingServers>(again.req('GET', '/api/servers/pending'))).pending, []);
  assert.ok(!existsSync(join(h.folder, '.orrery-pending.json')));
  const p = await again.json<PackState>(again.req('GET', '/api/servers/new-1/pack'));
  assert.equal(p.installed?.how, 'installed');
  assert.equal(p.installed?.version, '2.7.6');
  assert.deepEqual(p.edits.map((e) => e.find), ['-Xm([sx])\\S+']);
  assert.deepEqual(p.pending, []);
  assert.equal(p.mod, 'mods/orrery-1.7.10-1.5.0.jar');
  assert.equal((await again.req('DELETE', '/api/servers/pending/new-1')).status, 409);
});

test('New server: an install the hub stopped in the middle of is removed by the next hub', async (t) => {
  const h = await newServerHub(t);
  await h.addRuntime();
  assert.deepEqual(await h.finished(2), ['ok', '']);
  h.mod.gate = new Promise(() => {});
  await h.s.json(h.install({ runtime: 'temurin-21.0.8+9' }), 202);
  await until(() => h.steps.some((x) => x.startsWith('new-1 mod')));
  assert.ok(existsSync(h.folder));
  await h.s.close();
  const again = await start(t, h.w, { github: { releases: async () => [], download: async () => new Uint8Array() } });
  assert.ok(!existsSync(h.folder));
  assert.ok(!existsSync(join(h.data, 'java', 'new-1')));
  assert.ok(!existsSync(join(h.data, 'work', 'installing.json')));
  assert.deepEqual((await again.json<PendingServers>(again.req('GET', '/api/servers/pending'))).pending, []);
  const db = new Db(h.w.config.dbPath);
  t.after(() => db.close());
  assert.equal(db.hasPackData('new-1'), false);
});

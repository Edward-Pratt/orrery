// The pack library (`library.ts`, `library-entries.ts`).

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { LibraryState } from '../../src/api.ts';
import { Db } from '../../src/stats/db.ts';
import { ACTOR } from '../web/web-hub.ts';
import { sleep, until } from '../fake-mod.ts';
import { PACK_NEW, rawZip, sha, URL_NEW, URL_OLD, world } from './pack-world.ts';
import { github, start, updatable } from './pack-hub.ts';
import { libraryHub, NEW, URL_FORGE } from './library-hub.ts';

test('a pack version added from a URL and one from a chunked upload are listed with their sha256 and size, newest first', async (t) => {
  const { w, s, lib, add, finished, files } = await libraryHub(t);
  assert.deepEqual(await lib(), { packs: [], runtimes: [], running: null });
  await add({ url: URL_FORGE, name: 'GT New Horizons', version: '2.7.6' }); // the Minecraft version and loader from its Forge jar
  assert.deepEqual(await finished(), ['ok', '']);
  await add({ upload: await s.upload(w.urls[URL_NEW]!), ...NEW });
  assert.deepEqual(await finished(2), ['ok', '']);
  const { packs, running } = await lib();
  assert.equal(running, null);
  const entry = (file: string, version: string, source: string) =>
    ({ name: 'GT New Horizons', version, mc: '1.7.10', loader: 'forge', sha256: sha(file), size: statSync(file).size, source, by: 'alex', usedBy: [] });
  assert.deepEqual(packs.map(({ id: _, at: __, ...p }) => p), [entry(w.urls[URL_NEW]!, '2.7.5', 'GTNH_2.7.5.zip'), entry(w.urls[URL_FORGE]!, '2.7.6', URL_FORGE)]);
  assert.deepEqual(files(), [`${sha(w.urls[URL_FORGE]!)}.zip`, `${sha(w.urls[URL_NEW]!)}.zip`].sort());
  assert.deepEqual(await s.audit('library'), [
    { actor: ACTOR, action: 'library add', target: 'library', details: `GT New Horizons 2.7.6 from ${URL_FORGE}` },
    { actor: ACTOR, action: 'library add', target: 'library', details: 'GT New Horizons 2.7.6: ok' },
    { actor: ACTOR, action: 'library add', target: 'library', details: 'GT New Horizons 2.7.5 from GTNH_2.7.5.zip' },
    { actor: ACTOR, action: 'library add', target: 'library', details: 'GT New Horizons 2.7.5: ok' },
  ]);
});

test('an add streams its progress then its end; the replay holds only the latest progress, and none once it ends', async (t) => {
  const { s, adds, lib, add, finished } = await libraryHub(t);
  let release!: () => void;
  s.fake.downloadGate = new Promise((r) => (release = r));
  const { add: n } = await add({ url: URL_FORGE, name: 'GT New Horizons', version: '2.7.6' });
  await until(() => adds.length >= 1);
  assert.deepEqual({ ...(await lib()).running!, started: 0 }, { add: n, kind: 'pack', name: 'GT New Horizons', version: '2.7.6', by: 'alex', started: 0, detail: 'Downloading' });
  const replay = () => s.handle.live.since().map(([, e]) => e).filter((e) => 'target' in e && e.type === 'libraryAdd');
  assert.equal(replay().length, 1);
  release();
  await finished();
  const phases = adds.map((e) => (e.phase === 'progress' ? e.detail : `${e.phase} ${e.outcome}`));
  assert.deepEqual(phases, ['Downloading', 'Downloading 1.7 KB of 1.7 KB', 'Checking the zip', 'Storing', 'finished ok']);
  assert.ok(adds.every((e) => e.add === n));
  assert.deepEqual(replay().map((e) => 'phase' in e && e.phase), ['finished']);
});

test('Cancel stops an add and leaves nothing behind; a second add while one runs, and a hub deploy, are refused', async (t) => {
  const w = world(t);
  w.config.integrations.github = {
    repo: 'Edward-Pratt/orrery',
    newerAfterDays: 14,
    deploys: { root: join(w.root, 'data'), hubUnit: 'orrery-hub.service', hubTemplate: 'orrery-deploy', webTemplate: 'orrery-deploy-web', webDir: join(w.root, 'www') },
  };
  const { s, lib, add, finished, files } = await libraryHub(t, { github }, w);
  while ((await s.json<{ checkedAt: number | null }>(s.req('GET', '/api/deploys'))).checkedAt === null) await sleep(5);
  s.fake.downloadGate = new Promise(() => {}); // a download that would never end
  await add({ url: URL_FORGE, name: 'GT New Horizons', version: '2.7.6' });
  await until(() => s.fake.downloads.length === 1);
  const second = await s.req('POST', '/api/library/packs', { url: URL_NEW, ...NEW });
  assert.equal(second.status, 409);
  assert.equal(await second.text(), 'GT New Horizons 2.7.6 is being added: one add at a time.');
  const deploy = await s.req('POST', '/api/deploys', { part: 'hub', tag: 'hub-v2.7.0' });
  assert.equal(deploy.status, 409);
  assert.equal(await deploy.text(), 'A library add is running: deploy the hub once it is done.');
  assert.equal((await s.req('POST', '/api/library/cancel')).status, 204);
  assert.deepEqual(await finished(), ['cancelled', '']);
  assert.deepEqual(await lib(), { packs: [], runtimes: [], running: null });
  assert.deepEqual(files(), []);
  assert.equal((await s.req('POST', '/api/library/cancel')).status, 409); // nothing running
  assert.deepEqual((await s.audit('library')).map((e) => `${e.action}: ${e.details}`), [
    `library add: GT New Horizons 2.7.6 from ${URL_FORGE}`,
    'library cancel: GT New Horizons 2.7.6',
    'library add: GT New Horizons 2.7.6: cancelled',
  ]);
});

test('the same file under the same name and version is already there; any other duplicate is refused, naming the entry', async (t) => {
  const { w, s, lib, add, finished, files } = await libraryHub(t);
  await add({ url: URL_NEW, ...NEW });
  await finished();
  await add({ url: URL_NEW, ...NEW });
  assert.deepEqual(await finished(2), ['ok', 'GT New Horizons 2.7.5 is already in the library.']);
  await add({ url: URL_OLD, ...NEW });
  assert.deepEqual(await finished(3), ['failed', 'GT New Horizons 2.7.5 is in the library already, with a different file.']);
  await add({ url: URL_NEW, ...NEW, version: '2.7.5-again' });
  assert.deepEqual(await finished(4), ['failed', 'This file is in the library already, as GT New Horizons 2.7.5.']);
  // An upload's sha256 is known at once: refused before it starts, and the upload is still there to use.
  const upload = await s.upload(w.urls[URL_NEW]!);
  for (const [body, why] of [
    [{ upload, ...NEW }, 'GT New Horizons 2.7.5 is already in the library.'],
    [{ upload, ...NEW, version: '2.7.5-again' }, 'This file is in the library already, as GT New Horizons 2.7.5.'],
  ] as const) {
    const res = await s.req('POST', '/api/library/packs', body);
    assert.equal(res.status, 409);
    assert.equal(await res.text(), why);
  }
  assert.equal((await lib()).packs.length, 1);
  assert.deepEqual(files(), [`${sha(w.urls[URL_NEW]!)}.zip`]);
});

test('an unsafe or rootless zip, or one that says nothing of its Minecraft version, is refused and leaves nothing', async (t) => {
  const { w, lib, add, finished, files } = await libraryHub(t);
  w.urls['https://x/dots.zip'] = rawZip(w, 'dots.zip', { 'mods/a.jar': 'a', 'mods/../../../evil.txt': 'x' });
  w.urls['https://x/client.zip'] = w.zip('client.zip', { 'readme.txt': 'not a server pack' });
  const cases = [
    [{ url: 'https://x/dots.zip', ...NEW }, 'The zip has a path outside its folder (mods/../../../evil.txt): refused.'],
    [{ url: 'https://x/client.zip', ...NEW }, 'The zip has no mods/ or config/ folder: is it a server pack?'],
    [{ url: URL_OLD, name: 'GT New Horizons', version: '2.7.4' }, "The zip doesn't say its Minecraft version: type the Minecraft version and loader, then add it again."],
    [{ url: 'https://x/missing.zip', ...NEW }, 'Downloading the pack failed: HTTP 404'],
  ] as const;
  for (const [i, [body, why]] of cases.entries()) {
    await add(body);
    assert.deepEqual(await finished(i + 1), ['failed', why]);
  }
  assert.deepEqual((await lib()).packs, []);
  assert.deepEqual(files(), []);
});

test('bad adds are 400; Delete removes the entry and its zip, audited; an unknown one is 404', async (t) => {
  const { s, lib, add, finished, files } = await libraryHub(t);
  for (const body of [
    { url: 'http://packs.example/a.zip', ...NEW },
    { url: URL_NEW, ...NEW, name: ' ' },
    { url: URL_NEW, ...NEW, version: 'v'.repeat(101) },
    { url: URL_NEW, ...NEW, loader: 'fabric' },
    { upload: 'nope', ...NEW },
  ]) {
    assert.equal((await s.req('POST', '/api/library/packs', body)).status, 400, JSON.stringify(body));
  }
  await add({ url: URL_NEW, ...NEW });
  await finished();
  const [entry] = (await lib()).packs;
  assert.equal((await s.req('DELETE', `/api/library/packs/${entry!.id}`)).status, 204);
  assert.deepEqual((await lib()).packs, []);
  assert.deepEqual(files(), []);
  for (const id of [entry!.id, 'x']) assert.equal((await s.req('DELETE', `/api/library/packs/${id}`)).status, 404);
  assert.deepEqual((await s.audit('library delete')).map((e) => e.details), ['GT New Horizons 2.7.5']);
});

test('at start, packs/<id>.zip moves into the library: added, reused by sha256, or added as "<version> (<server>)" on a clash; no row: deleted', async (t) => {
  const w = world(t);
  w.urls[URL_FORGE] = w.zip('GTNH_2.7.6.zip', { ...PACK_NEW, 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar': 'forge' });
  const data = dirname(w.config.dbPath);
  const db = new Db(w.config.dbPath);
  const row = (name: string, version: string, source: string) => ({ name, version, source, sha256: 'x', by: 'alex', at: 1, how: 'adopted' as const, snapshot: '{"extras":{},"edits":{}}', libraryId: null });
  db.setPack('gtnh', row('GT New Horizons', '2.7.4', URL_OLD), [], new Set());
  db.setPack('reused', row('Renamed', '9', 'by hand'), [], new Set());
  db.setPack('clash', row('GT New Horizons', '2.7.5', 'by hand'), [], new Set());
  db.addLibraryEntry({ name: 'GT New Horizons', version: '2.7.5', mc: '1.7.10', loader: 'forge', sha256: sha(w.urls[URL_NEW]!), size: 1, source: URL_NEW, by: 'alex', at: 2 });
  db.close();
  mkdirSync(join(data, 'packs'));
  mkdirSync(join(data, 'library'));
  copyFileSync(w.urls[URL_NEW]!, join(data, 'library', `${sha(w.urls[URL_NEW]!)}.zip`));
  copyFileSync(w.urls[URL_OLD]!, join(data, 'packs', 'gtnh.zip'));
  copyFileSync(w.urls[URL_NEW]!, join(data, 'packs', 'reused.zip'));
  copyFileSync(w.urls[URL_FORGE]!, join(data, 'packs', 'clash.zip'));
  writeFileSync(join(data, 'packs', 'gone.zip'), 'no row');
  const s = await start(t, w);
  assert.ok(!existsSync(join(data, 'packs')));
  assert.deepEqual(readdirSync(join(data, 'library')).sort(), [`${sha(w.urls[URL_OLD]!)}.zip`, `${sha(w.urls[URL_NEW]!)}.zip`, `${sha(w.urls[URL_FORGE]!)}.zip`].sort());
  const { packs } = await s.json<LibraryState>(s.req('GET', '/api/library'));
  assert.deepEqual(
    packs.map(({ name, version, mc, loader, source, usedBy }) => ({ name, version, mc, loader, source, usedBy })),
    [
      { name: 'GT New Horizons', version: '2.7.5', mc: '1.7.10', loader: 'forge', source: URL_NEW, usedBy: ['reused'] },
      { name: 'GT New Horizons', version: '2.7.4', mc: '1.7.10', loader: 'forge', source: URL_OLD, usedBy: ['gtnh'] },
      { name: 'GT New Horizons', version: '2.7.5 (clash)', mc: '1.7.10', loader: 'forge', source: 'by hand', usedBy: ['clash'] },
    ],
  );
  // The moved pack is the server's: Apply changes unzips it.
  await s.connect();
  await s.json(s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'startserver.sh', find: '-Xmx6G', replace: '-Xmx8G' }));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', { pending: true }), 202);
  assert.equal((await s.finished()).outcome, 'ok');
  assert.equal(readFileSync(join(w.dir, 'mods/old-only.jar'), 'utf8'), 'gone in 2.7.5');
});

test("a pack row with no library link (an older hub's, after a Rollback) is linked by its zip's sha256: at start, or once that zip is added", async (t) => {
  const w = world(t);
  let s = await start(t, w);
  await s.connect();
  await s.adopt();
  const linked = async () => (await s.json<LibraryState>(s.req('GET', '/api/library'))).packs.map((p) => `${p.version}: ${p.usedBy.join(',')}`);
  assert.deepEqual(await linked(), ['2.7.4: gtnh']);
  await s.close();
  // What an older hub's INSERT OR REPLACE leaves: no library_id.
  const unlink = () => {
    const db = new Db(w.config.dbPath);
    db.setPack('gtnh', { ...db.pack('gtnh')!, libraryId: null }, db.packFiles('gtnh'), new Set(db.packFiles('gtnh', true)));
    db.close();
  };
  unlink();
  s = await start(t, w);
  assert.deepEqual(await linked(), ['2.7.4: gtnh']);
  await s.connect();
  await s.json(s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'startserver.sh', find: '-Xmx6G', replace: '-Xmx8G' }));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', { pending: true }), 202); // Apply works again
  assert.equal((await s.finished()).outcome, 'ok');
  // An entry deleted from under an unlinked row comes back linked when its zip is added again.
  await s.close();
  unlink();
  const db = new Db(w.config.dbPath);
  db.deleteLibraryEntry(db.library()[0]!.id);
  db.close();
  s = await start(t, w);
  assert.deepEqual(await linked(), []);
  await s.entry(URL_OLD, '2.7.4');
  assert.deepEqual(await linked(), ['2.7.4: gtnh']);
});

test('an entry a server uses, or a running update installs, is not deleted (409 naming them); once unused it is', async (t) => {
  const { w, s } = await updatable(t);
  const old = await s.entry(URL_OLD, '2.7.4');
  const refused = await s.req('DELETE', `/api/library/packs/${old.library}`);
  assert.equal(refused.status, 409);
  assert.equal(await refused.text(), 'GT New Horizons 2.7.4 is used by gtnh.');
  const next = await s.toNew();
  s.fake.backupGate = new Promise(() => {});
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', next), 202);
  assert.equal(await (await s.req('DELETE', `/api/library/packs/${next.library}`)).text(), 'GT New Horizons 2.7.5 is used by gtnh.');
  assert.deepEqual((await s.json<LibraryState>(s.req('GET', '/api/library'))).packs.map((p) => p.usedBy), [['gtnh'], ['gtnh']]);
  await s.close(); // the update is interrupted: the next hub closes it
  const again = await start(t, w);
  // The interrupted update no longer installs 2.7.5; 2.7.4 is still the server's.
  assert.equal((await again.req('DELETE', `/api/library/packs/${next.library}`)).status, 204);
  assert.equal((await again.req('DELETE', `/api/library/packs/${old.library}`)).status, 409);
});

test("a Mod deploy picks the build for the server pack's Minecraft version, else 1.7.10", async (t) => {
  const w = world(t);
  w.config.integrations.github = {
    repo: 'Edward-Pratt/orrery',
    newerAfterDays: 14,
    deploys: { root: join(w.root, 'data'), hubUnit: 'orrery-hub.service', hubTemplate: 'orrery-deploy', webTemplate: 'orrery-deploy-web', webDir: join(w.root, 'www') },
  };
  const assets = ['orrery-1.7.10-1.5.0.jar', 'orrery-1.12.2-1.5.0.jar'];
  const s = await start(t, w, {
    github: {
      releases: async () => [{ tag: 'mod-v1.5.0', draft: false, prerelease: false, publishedAt: 1, assets }],
      download: async (_tag, asset) => new TextEncoder().encode(asset),
    },
  });
  while ((await s.json<{ checkedAt: number | null }>(s.req('GET', '/api/deploys'))).checkedAt === null) await sleep(5);
  const deploy = async () => {
    await s.json(s.req('POST', '/api/deploys', { part: 'mod', tag: 'mod-v1.5.0', server: 'gtnh' }), 202);
    await sleep(50);
    return readdirSync(join(w.dir, 'mods')).filter((f) => f.startsWith('orrery-'));
  };
  assert.deepEqual(await deploy(), ['orrery-1.7.10-1.5.0.jar']); // no pack yet
  await s.json(s.req('POST', '/api/servers/gtnh/pack/compare', await s.entry(URL_OLD, '2.7.4', '1.12.2')));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/adopt', { keep: [] }));
  assert.deepEqual(await deploy(), ['orrery-1.12.2-1.5.0.jar']); // the older build removed
  assert.equal(readFileSync(join(w.dir, 'mods', 'orrery-1.12.2-1.5.0.jar'), 'utf8'), 'orrery-1.12.2-1.5.0.jar');
});

// Compare and Adopt, and the library entry they come from (`pack-compare.ts`).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CompareReport } from '../../src/api.ts';
import { ACTOR } from '../web/web-hub.ts';
import { sleep } from '../fake-mod.ts';
import { sha, snapshot, URL_OLD, world, write } from './pack-world.ts';
import { start } from './pack-hub.ts';

test('Compare reports matching, the Mod, files not in the pack and different ones, skipping Kept paths; nothing on disk changes', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const before = snapshot(w.dir);
  const report = await s.json<CompareReport>(s.req('POST', '/api/servers/gtnh/pack/compare', await s.entry(URL_OLD, '2.7.4')));
  assert.deepEqual(report, {
    name: 'GT New Horizons',
    version: '2.7.4',
    // gregtech.jar, old-only.jar, bq.jar, gregtech.cfg, startserver.sh; server.properties and World/ are kept
    matching: 5,
    mod: ['mods/orrery-1.7.10-1.4.0.jar'],
    notInPack: [
      { path: 'config/custom.cfg', size: 14 },
      { path: 'mods/journeymap-fairplay.jar', size: 17 },
    ],
    different: [{ path: 'config/forge.cfg', size: 21 }],
  } satisfies CompareReport);
  assert.deepEqual(snapshot(w.dir), before);
  assert.deepEqual(await s.audit(), [{ actor: ACTOR, action: 'pack compare', target: 'gtnh', details: 'GT New Horizons 2.7.4: 5 files match' }]);
});

test('Adopt keeps the ticked files as Extras and records the pack, changing nothing on disk; a second Adopt is 409', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const before = snapshot(w.dir);
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/adopt', { keep: [] })).status, 409); // compare first
  const p = await s.adopt();
  assert.deepEqual(snapshot(w.dir), before);
  const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
  assert.deepEqual(p.installed && { ...p.installed, at: 0 }, {
    name: 'GT New Horizons',
    version: '2.7.4',
    source: URL_OLD,
    sha256: sha(readFileSync(w.urls[URL_OLD]!)),
    by: 'alex',
    at: 0,
    how: 'adopted',
  });
  assert.deepEqual(
    p.extras.map(({ target, sha256, replaces, change, removed }) => ({ target, sha256, replaces, change, removed })),
    [
      { target: 'config/custom.cfg', sha256: sha('our own config'), replaces: false, change: null, removed: false },
      { target: 'config/forge.cfg', sha256: sha('changed on the server'), replaces: true, change: null, removed: false },
      { target: 'mods/journeymap-fairplay.jar', sha256: sha('a third-party mod'), replaces: false, change: null, removed: false },
    ],
  );
  assert.deepEqual(p.pending, []);
  assert.deepEqual(p.packFiles, ['config/forge.cfg', 'config/gregtech.cfg', 'mods/bq.jar', 'mods/gregtech.jar', 'mods/old-only.jar', 'startserver.sh']);
  // Each Extra is stored under its row id, outside the server folder.
  const stored = join(w.root, 'data', 'extras', 'gtnh');
  assert.deepEqual(readdirSync(stored).sort(), p.extras.map((e) => String(e.id)).sort());
  assert.equal(readFileSync(join(stored, String(p.extras[0]!.id)), 'utf8'), 'our own config');
  const again = await s.req('POST', '/api/servers/gtnh/pack/compare', await s.entry(URL_OLD, '2.7.4'));
  assert.equal(again.status, 409);
  assert.deepEqual(await s.audit('pack adopt'), [{ actor: ACTOR, action: 'pack adopt', target: 'gtnh', details: 'GT New Horizons 2.7.4, keeping 3 files' }]);
});

test('Adopt takes only paths from the report', async (t) => {
  const s = await start(t, world(t));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/compare', await s.entry(URL_OLD, '2.7.4')));
  for (const keep of [['ops.json'], ['../etc/passwd'], ['mods/orrery-1.7.10-1.4.0.jar'], 'config/custom.cfg']) {
    assert.equal((await s.req('POST', '/api/servers/gtnh/pack/adopt', { keep })).status, 400, String(keep));
  }
  assert.equal((await s.pack()).installed, null);
});

test('a source is a library entry: anything else is 400, an unknown one 404; Compare needs no packs/ or downloads/', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  for (const body of [{}, { library: '1' }, { library: 0 }, { library: 1.5 }, { url: URL_OLD, name: 'x', version: '1' }]) {
    assert.equal((await s.req('POST', '/api/servers/gtnh/pack/compare', body)).status, 400, JSON.stringify(body));
  }
  const unknown = await s.req('POST', '/api/servers/gtnh/pack/compare', { library: 999 });
  assert.equal(unknown.status, 404);
  assert.equal(await unknown.text(), 'No such pack in the library.');
  await s.json(s.req('POST', '/api/servers/gtnh/pack/compare', await s.entry(URL_OLD, '2.7.4')));
  assert.deepEqual(readdirSync(join(w.root, 'data')).sort(), ['hub.db', 'library', 'work']);
  assert.deepEqual(readdirSync(join(w.root, 'data', 'work')), []); // Compare's scratch is gone again
});

test("a library zip outlives an expired Compare, and Compare's scratch is cleared at start", async (t) => {
  const w = world(t);
  const s = await start(t, w, { compareMs: 50 });
  await s.json(s.req('POST', '/api/servers/gtnh/pack/compare', await s.entry(URL_OLD, '2.7.4')));
  await sleep(100);
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/adopt', { keep: [] })).status, 409); // forgotten
  assert.ok(existsSync(join(w.root, 'data', 'library', `${sha(w.urls[URL_OLD]!)}.zip`)));
  await s.close();
  write(join(w.root, 'data'), { 'work/gtnh/mods/a.jar': 'left by a crash', 'staging/gtnh/x': 'before the rename', 'downloads/abc': 'before the library' });
  await start(t, w);
  assert.deepEqual(readdirSync(join(w.root, 'data')).sort(), ['hub.db', 'library', 'work']);
  assert.deepEqual(readdirSync(join(w.root, 'data', 'work')), []);
});

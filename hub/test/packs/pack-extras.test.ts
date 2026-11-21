// Extras and Config edits, and the changes pending (`pack-extras.ts`).

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { world, write } from './pack-world.ts';
import { start, uploaded } from './pack-hub.ts';

test('adding, replacing and removing Extras and edits gives exactly the pending changes, each audited', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  let p = await s.adopt();
  const id = (target: string) => p.extras.find((e) => e.target === target)!.id;
  const extras = '/api/servers/gtnh/pack/extras';
  p = await s.json(s.req('POST', extras, { upload: await uploaded(s, w, 'pregen.jar', 'pregen'), target: 'mods/pregen.jar', label: '4.4.4', note: 'chunk pregen' }));
  p = await s.json(s.req('PUT', `${extras}/${id('config/custom.cfg')}`, { upload: await uploaded(s, w, 'custom.cfg', 'our own config, v2') }));
  p = await s.json(s.req('PUT', `${extras}/${id('mods/journeymap-fairplay.jar')}`, { label: '5.2.6', note: 'fairplay build' })); // not a file change
  p = await s.json(s.req('DELETE', `${extras}/${id('config/forge.cfg')}`));
  p = await s.json(s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'startserver.sh', find: '-Xmx6G', replace: '-Xmx12G', note: 'heap' }));
  assert.deepEqual(p.pending, [
    { path: 'config/custom.cfg', kind: 'extra', change: 'replaced' },
    { path: 'config/forge.cfg', kind: 'extra', change: 'removed' },
    { path: 'mods/pregen.jar', kind: 'extra', change: 'added' },
    { path: 'startserver.sh', kind: 'edit', change: 'added' },
  ]);
  assert.deepEqual(
    p.extras.map(({ target, label, note, by, removed, change, replaces }) => ({ target, label, note, by, removed, change, replaces })),
    [
      { target: 'config/custom.cfg', label: '', note: 'kept at adopt', by: 'alex', removed: false, change: 'replaced', replaces: false },
      { target: 'config/forge.cfg', label: '', note: 'kept at adopt', by: 'alex', removed: true, change: 'removed', replaces: true },
      { target: 'mods/journeymap-fairplay.jar', label: '5.2.6', note: 'fairplay build', by: 'alex', removed: false, change: null, replaces: false },
      { target: 'mods/pregen.jar', label: '4.4.4', note: 'chunk pregen', by: 'alex', removed: false, change: 'added', replaces: false },
    ],
  );
  assert.deepEqual(
    p.edits.map(({ path, find, replace, note, failedOn }) => ({ path, find, replace, note, failedOn })),
    [{ path: 'startserver.sh', find: '-Xmx6G', replace: '-Xmx12G', note: 'heap', failedOn: null }],
  );
  // An Extra never applied goes at once; an edit changed and removed again leaves nothing pending.
  p = await s.json(s.req('DELETE', `${extras}/${id('mods/pregen.jar')}`));
  p = await s.json(s.req('PUT', `/api/servers/gtnh/pack/edits/${p.edits[0]!.id}`, { path: 'startserver.sh', find: '-Xmx6G', replace: '-Xmx16G' }));
  assert.equal(p.edits[0]!.replace, '-Xmx16G');
  p = await s.json(s.req('DELETE', `/api/servers/gtnh/pack/edits/${p.edits[0]!.id}`));
  assert.deepEqual(p.pending.map((x) => x.path), ['config/custom.cfg', 'config/forge.cfg']);
  assert.ok(!p.extras.some((e) => e.target === 'mods/pregen.jar'));
  assert.deepEqual((await s.audit('pack e')).map((e) => `${e.action}: ${e.details}`), [
    'pack extra add: mods/pregen.jar',
    'pack extra change: config/custom.cfg: new file',
    'pack extra change: mods/journeymap-fairplay.jar',
    'pack extra remove: config/forge.cfg',
    'pack edit add: startserver.sh: -Xmx6G → -Xmx12G',
    'pack extra remove: mods/pregen.jar',
    'pack edit change: startserver.sh: -Xmx6G → -Xmx16G',
    'pack edit remove: startserver.sh: -Xmx6G → -Xmx16G',
  ]);
});

test('Extras and edits are refused outside the folder, at a Kept path, at the Mod jar or a .pre-update folder; a bad regex is 400', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'startserver.sh', find: 'x', replace: 'y' })).status, 409); // adopt first
  await s.adopt();
  mkdirSync(join(w.root, 'elsewhere'));
  symlinkSync(join(w.root, 'elsewhere'), join(w.dir, 'outside'));
  for (const target of ['../evil.jar', '/etc/passwd', 'mods/../../evil.jar', 'outside/evil.jar', 'World/level.dat', 'server.properties', 'journeymap/x', 'config/JourneyMapServer/a.cfg', 'mods/gtnhdiscord-9.9.9.jar', 'mods/orrery-1.7.10-9.9.9.jar', '.pre-update-20261002-120000/mods/a.jar', '.orrery-staging/a', '', '.']) {
    const extra = await s.req('POST', '/api/servers/gtnh/pack/extras', { upload: await uploaded(s, w, 'x.jar', 'x'), target });
    assert.equal(extra.status, 400, `extra at ${target}: ${await extra.text()}`);
    const edit = await s.req('POST', '/api/servers/gtnh/pack/edits', { path: target, find: 'a', replace: 'b' });
    assert.equal(edit.status, 400, `edit of ${target}`);
  }
  assert.equal(await (await s.req('POST', '/api/servers/gtnh/pack/extras', { upload: await uploaded(s, w, 'x.jar', 'x'), target: 'mods/gtnhdiscord-2.0.0.jar' })).text(), "mods/gtnhdiscord-2.0.0.jar is the Mod's jar: deploy the Mod from Host.");
  const bad = await s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'startserver.sh', find: '-Xmx(6G', replace: 'y' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /^Find isn't a valid regex/);
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/extras', { upload: 'nope', target: 'mods/a.jar' })).status, 400);
  const twice = await s.req('POST', '/api/servers/gtnh/pack/extras', { upload: await uploaded(s, w, 'x.jar', 'x'), target: 'config/custom.cfg' });
  assert.equal(twice.status, 409);
  assert.equal((await s.req('PUT', '/api/servers/gtnh/pack/extras/999', { label: 'x' })).status, 404);
  assert.equal((await s.req('DELETE', '/api/servers/gtnh/pack/edits/abc')).status, 404);
  assert.deepEqual((await s.pack()).pending, []);
});

test('the preview counts the matches in the file on the server', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  write(w.dir, { 'config/gregtech.cfg': 'pollution=true\nheap=6G\nother_pollution=true\n' });
  const preview = (body: object) => s.req('POST', '/api/servers/gtnh/pack/edits/preview', body);
  assert.deepEqual(await s.json(preview({ path: 'config/gregtech.cfg', find: 'pollution=true$' })), { matches: 2 });
  assert.deepEqual(await s.json(preview({ path: 'config/gregtech.cfg', find: 'o' })), { matches: 2 }); // lines, not hits
  assert.deepEqual(await s.json(preview({ path: 'config/gregtech.cfg', find: '^pollution=true$' })), { matches: 1 });
  assert.deepEqual(await s.json(preview({ path: 'config/gregtech.cfg', find: 'nothing' })), { matches: 0 });
  assert.equal((await preview({ path: 'config/missing.cfg', find: 'x' })).status, 404);
  assert.equal((await preview({ path: 'config/gregtech.cfg', find: '(' })).status, 400);
  assert.equal((await preview({ path: '../gtnh/config/gregtech.cfg', find: 'x' })).status, 400);
});

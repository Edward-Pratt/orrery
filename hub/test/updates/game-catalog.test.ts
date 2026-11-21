// The catalog's reads: the game's own mods in the plan, the mod browser and the Import mod list's check
// (`game-catalog.ts`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameCatalog, ModBrowse, ModCheckAnswer } from '../../src/api.ts';
import { LIMITS } from '../../src/protocol.ts';
import { eventually, gameHub, INSTALLED, MODS, PICK, PNG, ready, rel, WEB } from '../fake-agent.ts';

test("the game's own mods stay as installed has them: dependencies are resolved, and from and to counted, against those enabled", async (t) => {
  MODS['needs-recycler'] = [rel('needs-recycler', '1.0.0', ['base >= 2.1.0', 'recycler'])];
  MODS['needs-space'] = [rel('needs-space', '1.0.0', ['base >= 2.1.0', 'space-age'])];
  const h = await ready(t);
  // Space Age disabled by hand in mod-list.json, and recycler never enabled: the Agent keeps both so.
  h.agent.send({ type: 'installed', factorio: '2.1.24', mods: INSTALLED.filter((m) => m.name !== 'space-age') });
  await eventually(async () => (await h.game()).installed?.mods.length === 4);
  const unresolved = async (name: string) =>
    (await h.json<GameCatalog>(h.req('POST', '/api/servers/space/game/catalog', { factorio: '2.1.24', mods: [{ name: 'orrery', version: null }, { name, version: null }] }))).unresolved;
  assert.deepEqual(await unresolved('needs-recycler'), [{ mod: 'needs-recycler', dependency: 'recycler', reason: "recycler comes with Factorio, but it isn't enabled on this server." }]);
  assert.deepEqual(await unresolved('needs-space'), [{ mod: 'needs-space', dependency: 'space-age', reason: "space-age comes with Factorio, but it isn't enabled on this server." }]);
  // orrery's `? space-age` is optional: fine without it. To: base, elevated-rails and quality, and the three mods.
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  await h.answer();
  const running = (await h.game()).running!;
  assert.deepEqual([running.from, running.to], ['2.1.24 · 4 mods', '2.1.24 · 6 mods']);
});

test('the mod browser: a page of the portal\'s mods for the version\'s line through the hub, its parameters checked, and thumbnails as checked PNGs', async (t) => {
  const h = await gameHub(t);
  const mods = '/api/servers/space/game/mods';
  // A session is needed, as for every route; a server no Agent runs has none; no Agent connected is fine (a read).
  assert.equal((await h.app.request(`${mods}?factorio=2.1.24`)).status, 401);
  assert.equal((await h.app.request(`${mods}/flib/thumbnail`)).status, 401);
  assert.equal((await h.req('GET', '/api/servers/gtnh/game/mods?factorio=2.1.24')).status, 404);
  assert.equal((await h.req('GET', '/api/servers/gtnh/game/mods/helmod/thumbnail')).status, 404);
  const answer = await h.json<ModBrowse>(h.req('GET', `${mods}?factorio=2.1.24`));
  assert.deepEqual(answer, {
    line: '2.1',
    total: 3,
    mods: [
      { name: 'flib', title: 'Factorio Library', owner: 'raiguard', summary: 'A library.', downloads: 1_080_000, version: '0.16.2', updated: Date.parse('2026-10-01T00:00:00.000Z'), category: 'internal', spaceAge: false, page: 'https://mods.factorio.com/mod/flib' },
      { name: 'helmod', title: 'Helmod', owner: 'Helfima', summary: 'Plan your factory.', downloads: 500_000, version: '2.0.0', updated: Date.parse('2026-10-02T00:00:00.000Z'), category: 'tweaks', spaceAge: false, page: 'https://mods.factorio.com/mod/helmod' },
      { name: 'Squeak Through', title: 'Squeak Through', owner: 'someone', summary: 'Squeeze.', downloads: 3, version: '1.0.0', updated: null, category: 'tweaks', spaceAge: false, page: 'https://mods.factorio.com/mod/Squeak%20Through' },
    ],
    categories: [{ id: 'tweaks', title: 'Tweaks' }, { id: 'internal', title: 'Internal' }, { id: 'mod-packs', title: 'Mod packs' }],
  });
  const names = async (query: string) => (await h.json<ModBrowse>(h.req('GET', `${mods}?factorio=2.1.24&${query}`))).mods.map((m) => m.name);
  assert.deepEqual(await names('q=PLAN&category=tweaks&sort=updated&page=1'), ['helmod']);
  assert.deepEqual(await names('sort=name'), ['flib', 'helmod', 'Squeak Through']);
  assert.deepEqual(await names('page=2'), []);
  for (const [query, why] of [
    ['', 'Give a Factorio version (factorio), like 2.1.24.'],
    ['factorio=2.1', 'Give a Factorio version (factorio), like 2.1.24.'],
    [`factorio=2.1.24&q=${'x'.repeat(101)}`, 'Search for at most 100 characters.'],
    ['factorio=2.1.24&sort=score', 'Sort by downloads, updated, name.'],
    ['factorio=2.1.24&category=Mod%20Packs', 'Give a category by its id on the mod portal, like mod-packs.'],
    ['factorio=2.1.24&category=nope', 'The mod portal has no category nope.'],
    ['factorio=2.1.24&page=0', 'Give a page from 1 to 1000.'],
    ['factorio=2.1.24&page=x', 'Give a page from 1 to 1000.'],
    ['factorio=2.1.24&page=1001', 'Give a page from 1 to 1000.'],
  ]) {
    const res = await h.req('GET', `${mods}?${query}`);
    assert.deepEqual([res.status, await res.text()], [400, why], query);
  }
  // 100 characters with spaces around them: trimmed, fine.
  assert.equal((await h.req('GET', `${mods}?factorio=2.1.24&q=${encodeURIComponent(` ${'x'.repeat(100)} `)}`)).status, 200);

  // A thumbnail: the fake image's bytes as image/png, never sniffed, kept a day by the browser; a name with a space works.
  const thumb = await h.req('GET', `${mods}/Squeak%20Through/thumbnail`);
  assert.equal(thumb.status, 200);
  assert.deepEqual(
    [thumb.headers.get('content-type'), thumb.headers.get('x-content-type-options'), thumb.headers.get('cache-control')],
    ['image/png', 'nosniff', 'private, max-age=86400'],
  );
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), PNG);
  // No thumbnail (flib has none), no such mod, a name that isn't a mod's: 404, kept an hour.
  for (const name of ['flib', 'gone', 'a..b', '..%2F..', 'a%2Fb', 'x%3Cb%3E']) {
    const res = await h.req('GET', `${mods}/${name}/thumbnail`);
    assert.deepEqual([res.status, res.headers.get('cache-control')], [404, 'private, max-age=3600'], name);
  }
  // The portal failing: 502 with why, never cached.
  const down = await h.req('GET', `${mods}/down/thumbnail`);
  assert.deepEqual([down.status, down.headers.get('cache-control'), await down.text()], [502, null, "The mod portal can't be read: HTTP 503."]);
  const old = await h.req('GET', `${mods}?factorio=2.0.0`);
  assert.deepEqual([old.status, await old.text()], [502, "The mod portal can't be read: HTTP 404."]);
});

test("Import mod list's check: each name on the portal for the version's line or not, the body checked before any portal read", async (t) => {
  const h = await gameHub(t);
  const check = '/api/servers/space/game/check';
  const body = { factorio: '2.1.24', names: ['helmod', 'Squeak Through', 'needy', 'gone'] };
  // A session is needed, as for every route; a server no Agent runs has none; no Agent connected is fine (a read).
  assert.equal((await h.app.request(check, { method: 'POST', headers: { origin: WEB.publicUrl, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
  assert.equal((await h.req('POST', '/api/servers/gtnh/game/check', body)).status, 404);
  // helmod and Squeak Through from the list, needy read on its own (not listed), gone not on the portal.
  assert.deepEqual(await h.json<ModCheckAnswer>(h.req('POST', check, body)), {
    line: '2.1',
    mods: [
      { name: 'helmod', found: 'fits', title: 'Helmod', latest: '2.0.0' },
      { name: 'Squeak Through', found: 'fits', title: 'Squeak Through', latest: '1.0.0' },
      { name: 'needy', found: 'fits', title: 'needy', latest: '1.0.0' },
      { name: 'gone', found: 'missing', title: null, latest: null },
    ],
  });
  assert.deepEqual(await h.json<ModCheckAnswer>(h.req('POST', check, { factorio: '2.0.0', names: [] })), { line: '2.0', mods: [] }); // no read
  for (const [bad, why] of [
    [{ names: ['helmod'] }, 'Give a Factorio version, like 2.1.24.'],
    [{ factorio: '2.1', names: ['helmod'] }, 'Give a Factorio version, like 2.1.24.'],
    [{ factorio: '2.1.24' }, `Give the mods to check by name (names, at most ${LIMITS.mods}).`],
    [{ factorio: '2.1.24', names: 'helmod' }, `Give the mods to check by name (names, at most ${LIMITS.mods}).`],
    [{ factorio: '2.1.24', names: Array.from({ length: LIMITS.mods + 1 }, (_, i) => `m${i}`) }, `Give the mods to check by name (names, at most ${LIMITS.mods}).`],
    [{ factorio: '2.1.24', names: ['../etc'] }, 'Give each mod by its name on the mod portal.'],
    [{ factorio: '2.1.24', names: ['.'] }, 'Give each mod by its name on the mod portal.'], // /api/mods/./full is /api/mods/full
    [{ factorio: '2.1.24', names: ['<script>'] }, 'Give each mod by its name on the mod portal.'],
    [{ factorio: '2.1.24', names: ['x'.repeat(LIMITS.text + 1)] }, 'Give each mod by its name on the mod portal.'],
    [{ factorio: '2.1.24', names: [7] }, 'Give each mod by its name on the mod portal.'],
    [{ factorio: '2.1.24', names: ['space-age'] }, "space-age comes with Factorio: it isn't on the mod portal."],
    [{ factorio: '2.1.24', names: ['helmod', 'helmod'] }, 'helmod is given twice.'],
  ] as const) {
    const res = await h.req('POST', check, bad);
    assert.deepEqual([res.status, await res.text()], [400, why], JSON.stringify(bad).slice(0, 80));
  }
  // The portal has no list for 2.0 here: 502 with why.
  const old = await h.req('POST', check, { factorio: '2.0.0', names: ['helmod'] });
  assert.deepEqual([old.status, await old.text()], [502, "The mod portal can't be read: HTTP 404."]);
});

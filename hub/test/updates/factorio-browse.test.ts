// The mod browser (`factorio-browse.ts`, through `FactorioCatalog.browse`): the cache, the rows' checks, the search
// and its refusals.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactorioCatalog, GameRefused, type PortalFetch } from '../../src/updates/factorio.ts';
import { browse, CATEGORIES, CATS, LIST, portal, row } from './factorio-portal.ts';

test('the mod browser reads the line\'s list and the categories once, keeps them (15 minutes, 6 hours) and the two newest lines only', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const lines = ['2.1', '2.0', '1.1'];
  const { fetch, asked } = portal({
    ...Object.fromEntries(lines.map((l) => [LIST(l), { body: { pagination: null, results: [row(`mod-${l}`, {}, { info_json: { factorio_version: l } })] } }])),
    [CATEGORIES]: { body: CATS },
  });
  const catalog = new FactorioCatalog(fetch);
  const urls = () => asked.map((a) => a.url);
  // Two at once share one read of each.
  const [a, b] = await Promise.all([catalog.browse('2.1', browse), catalog.browse('2.1', browse)]);
  assert.deepEqual(a, b);
  assert.deepEqual(urls().sort(), [CATEGORIES, LIST('2.1')]);
  assert.ok(asked.every((x) => x.redirect === 'manual'));
  assert.deepEqual(a.categories, [{ id: 'content', title: 'Content' }, { id: 'tweaks', title: 'Tweaks' }, { id: 'mod-packs', title: 'Mod packs' }]);
  assert.deepEqual([a.line, a.total, a.mods.map((m) => m.name)], ['2.1', 1, ['mod-2.1']]);
  // Within 15 minutes: neither read again.
  t.mock.timers.tick(14 * 60_000);
  await catalog.browse('2.1', { ...browse, q: 'mod' });
  assert.equal(asked.length, 2);
  // After 15 minutes the list is read again, the categories only after 6 hours.
  t.mock.timers.tick(2 * 60_000);
  await catalog.browse('2.1', browse);
  assert.deepEqual(urls().slice(2), [LIST('2.1')]);
  t.mock.timers.tick(6 * 60 * 60_000);
  await catalog.browse('2.1', browse);
  assert.deepEqual(urls().slice(3).sort(), [CATEGORIES, LIST('2.1')]);
  // A third line drops the one browsed longest ago: 2.0 and 1.1 kept, 2.1 read again.
  asked.length = 0;
  await catalog.browse('2.0', browse);
  await catalog.browse('1.1', browse);
  await catalog.browse('2.0', browse);
  await catalog.browse('1.1', browse);
  assert.deepEqual(urls(), [LIST('2.0'), LIST('1.1')]);
  await catalog.browse('2.1', browse);
  assert.deepEqual(urls(), [LIST('2.0'), LIST('1.1'), LIST('2.1')]);
  // A failed read isn't kept.
  let down = true;
  const flaky = new FactorioCatalog(async (url, init) => (down && url === CATEGORIES ? new Response('', { status: 503 }) : fetch(url, init)));
  await assert.rejects(flaky.browse('2.1', browse), (err: GameRefused) => err.status === 502 && err.message === "The mod portal can't be read: HTTP 503.");
  down = false;
  assert.equal((await flaky.browse('2.1', browse)).total, 1);
  await assert.rejects(catalog.browse('2.1.24', browse), (err: GameRefused) => err.status === 400);
});

test("the mod browser checks every row from the portal: one that fails is dropped, every string is plain text and cut, never passed on", async () => {
  const title = 'T'.repeat(299);
  const summary = `First line\r\nsecond\u0007 line‮  with\ttabs ${'s'.repeat(600)}`;
  const { fetch } = portal({
    [LIST()]: {
      body: {
        results: [
          row('Squeak Through', { title, summary, owner: `own\u0000er${'o'.repeat(80)}`, category: 'made-up', downloads_count: 'many', requires_space_age: true }),
          row('plain', { title: '  ', summary: null, owner: 7, category: 'mod-packs', downloads_count: 1234.9, requires_space_age: 'yes' }, { released_at: 'never' }),
          row('bad/name'),
          row('..dots'),
          row('n'.repeat(300)),
          row('no-release', { latest_release: null }),
          row('bad-version', {}, { version: '1.0' }),
          row('other-line', {}, { info_json: { factorio_version: '2.0' } }),
          row('no-line', {}, { info_json: null }),
          'not a row',
          row('plain', { title: 'A second plain' }),
        ],
      },
    },
    [CATEGORIES]: { body: [...CATS, ['BAD id', 'Bad', ''], ['no-title', 7, ''], 'junk', ['tweaks', 'Again', '']] },
  });
  const answer = await new FactorioCatalog(fetch).browse('2.1', { ...browse, sort: 'name' });
  assert.deepEqual(answer.categories.map((c) => c.id), ['content', 'tweaks', 'mod-packs']);
  assert.equal(answer.total, 2);
  const [plain, squeak] = answer.mods;
  assert.deepEqual(plain, {
    name: 'plain',
    title: 'plain',
    owner: '',
    summary: '',
    downloads: 1234,
    version: '1.0.0',
    updated: null,
    category: 'mod-packs',
    spaceAge: false,
    page: 'https://mods.factorio.com/mod/plain',
  });
  assert.equal(squeak!.name, 'Squeak Through');
  assert.equal(squeak!.title, 'T'.repeat(200));
  assert.equal(squeak!.owner, `owner${'o'.repeat(59)}`);
  assert.equal(squeak!.summary.length, 500);
  assert.ok(squeak!.summary.startsWith('First line second line with tabs sss'), squeak!.summary);
  assert.ok(squeak!.summary.endsWith('s…'));
  assert.ok(!/[\p{Cc}‮]/u.test(squeak!.summary));
  assert.deepEqual([squeak!.downloads, squeak!.category, squeak!.spaceAge, squeak!.updated], [0, null, true, Date.parse('2026-10-01T00:00:00.000Z')]);
  assert.equal(squeak!.page, 'https://mods.factorio.com/mod/Squeak%20Through');
});

test('the mod browser searches every word in name, title or summary, filters a category, sorts, puts an exact match first and pages by 24', async () => {
  const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;
  const rows = [
    row('flib', { title: 'Factorio Library', summary: 'A library for mods.', downloads_count: 1_080_000, category: 'internal' }, { released_at: day(3) }),
    row('helmod', { title: 'Helmod: Production Planner', summary: 'Plan your factory.', downloads_count: 500_000, category: 'tweaks' }, { released_at: day(9) }),
    row('flib-extras', { title: 'Extras for the LIBRARY', summary: 'More.', downloads_count: 20, category: 'content' }, { released_at: day(1) }),
    row('pack', { title: 'Big Pack', summary: 'Every mod, a library too', downloads_count: 20, category: 'mod-packs' }, { released_at: null }),
    ...Array.from({ length: 60 }, (_, i) => row(`filler-${String(i).padStart(2, '0')}`, { title: `Filler ${i}`, downloads_count: 100 + i }, { released_at: day(10) })),
  ];
  const { fetch } = portal({ [LIST()]: { body: { results: rows } }, [CATEGORIES]: { body: [...CATS, ['internal', 'Internal', '']] } });
  const catalog = new FactorioCatalog(fetch);
  const names = async (o: Partial<typeof browse>) => (await catalog.browse('2.1', { ...browse, ...o })).mods.map((m) => m.name);
  assert.deepEqual(await names({ q: 'LIBRARY' }), ['flib', 'flib-extras', 'pack']);
  assert.deepEqual(await names({ q: 'library mod' }), ['flib', 'pack']); // every word, in any of the three
  assert.deepEqual(await names({ q: '  plan   factory ' }), ['helmod']);
  assert.deepEqual(await names({ q: 'library', category: 'mod-packs' }), ['pack']);
  assert.deepEqual(await names({ q: 'library', sort: 'updated' }), ['flib', 'flib-extras', 'pack']);
  assert.deepEqual(await names({ q: 'library', sort: 'name' }), ['pack', 'flib-extras', 'flib']); // by title, case aside
  // A mod whose name or title is the query comes first, whatever the sort.
  assert.deepEqual(await names({ q: 'flib-extras' }), ['flib-extras']);
  assert.deepEqual(await names({ q: 'big pack', sort: 'downloads' }), ['pack']);
  assert.deepEqual(await names({ q: 'extras for the library' }), ['flib-extras']);
  assert.deepEqual(await names({ q: 'flib' }), ['flib', 'flib-extras']);
  assert.deepEqual((await names({ q: 'Factorio Library', sort: 'name' }))[0], 'flib');
  // Pages of 24, total counts every match; past the end: none, with the total.
  const page1 = await catalog.browse('2.1', browse);
  const page2 = await catalog.browse('2.1', { ...browse, page: 2 });
  const all = [...rows].sort((a, b) => b.downloads_count - a.downloads_count || (a.name < b.name ? -1 : 1)).map((r) => r.name);
  assert.equal(page1.total, 64);
  assert.deepEqual(page1.mods.map((m) => m.name), all.slice(0, 24));
  assert.deepEqual(page2.mods.map((m) => m.name), all.slice(24, 48));
  assert.deepEqual(await catalog.browse('2.1', { ...browse, page: 4 }), { ...page1, mods: [] });
  assert.deepEqual((await catalog.browse('2.1', { ...browse, sort: 'updated' })).mods.slice(0, 2).map((m) => m.name), ['filler-00', 'filler-01']);
  // A category the portal doesn't list: 400.
  await assert.rejects(catalog.browse('2.1', { ...browse, category: 'nope' }), (err: GameRefused) => err.status === 400 && err.message === 'The mod portal has no category nope.');
});

test("the mod browser refuses (502) a list over 16 MiB, too many rows, a timeout or a redirect off the portal, with no URL in the message", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(32);
  const huge: PortalFetch = async (url) => {
    if (url === CATEGORIES) return Response.json(CATS);
    let sent = 0;
    return new Response(new ReadableStream({ pull: (c) => (sent++ < 17 ? c.enqueue(chunk) : c.close()) }));
  };
  const timeout: PortalFetch = async () => {
    throw new DOMException('The operation timed out.', 'TimeoutError');
  };
  const cases: [PortalFetch, string][] = [
    [huge, `The mod portal's answer is over ${16 * 1024 * 1024} bytes.`],
    [portal({ [LIST()]: { body: { results: Array.from({ length: 50_001 }, () => 0) } }, [CATEGORIES]: { body: CATS } }).fetch, "The mod portal's list of mods has over 50000 rows."],
    [portal({ [LIST()]: { body: { mods: [] } }, [CATEGORIES]: { body: CATS } }).fetch, "The mod portal's list of mods has no results."],
    [portal({ [LIST()]: { body: '<html>' }, [CATEGORIES]: { body: CATS } }).fetch, "The mod portal's list of mods isn't JSON."],
    [portal({ [LIST()]: { body: { results: [] } }, [CATEGORIES]: { body: { content: 'Content' } } }).fetch, "The mod portal's categories aren't a list."],
    [timeout, "The mod portal can't be read: timed out."],
    [portal({ [LIST()]: { status: 302, headers: { location: 'https://assets-mod.factorio.com/list.json' } }, [CATEGORIES]: { body: CATS } }).fetch, 'The mod portal redirected away from factorio.com, www.factorio.com, mods.factorio.com.'],
  ];
  for (const [fetch, why] of cases) {
    await assert.rejects(new FactorioCatalog(fetch).browse('2.1', browse), (err: GameRefused) => {
      assert.equal(err.status, 502);
      assert.equal(err.message, why);
      assert.ok(!err.message.includes('https://mods.factorio.com'), err.message);
      return true;
    });
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PortalSort } from '../src/api.ts';
import { compareVersions, FactorioCatalog, GameRefused, type PortalFetch } from '../src/factorio.ts';

const MODS = 'https://mods.factorio.com/api/mods/';
const ACCOUNT = { username: 'owner', token: 'secret-token-0123456789' };
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** A portal release: `factorio` its line, `deps` its `info_json.dependencies`. */
const rel = (name: string, version: string, factorio = '2.1', deps: string[] = ['base >= 2.0.0'], extra: object = {}) => ({
  version,
  sha1: sha1(`${name}@${version}`),
  download_url: `/download/${name}/${sha1(name).slice(0, 24)}`,
  file_name: `${name}_${version}.zip`,
  released_at: '2026-10-01T00:00:00.000Z',
  info_json: { factorio_version: factorio, dependencies: deps },
  ...extra,
});

type Page = { status?: number; body?: unknown; headers?: Record<string, string>; url?: string };

/** A fake factorio.com and mod portal: `pages` by URL (a mod's by its name), every request recorded. */
function portal(pages: Record<string, Page>, mods: Record<string, { title?: string; releases: unknown[] }> = {}) {
  const asked: { url: string; redirect: string }[] = [];
  const fetch: PortalFetch = async (url, init) => {
    asked.push({ url, redirect: init.redirect });
    const name = url.startsWith(MODS) ? decodeURIComponent(url.slice(MODS.length).replace(/\/full$/, '')) : undefined;
    const page: Page | undefined = name !== undefined && mods[name] ? { body: { name, title: mods[name].title ?? name, releases: mods[name].releases } } : pages[url];
    if (!page) return new Response('not found', { status: 404 });
    const body = typeof page.body === 'string' || page.body === undefined ? page.body : JSON.stringify(page.body);
    const res = new Response(body ?? null, { status: page.status ?? 200, headers: page.headers });
    if (page.url) Object.defineProperty(res, 'url', { value: page.url });
    return res;
  };
  return { fetch, asked };
}

const resolved = (r: Awaited<ReturnType<FactorioCatalog['resolve']>>) => r.mods.map((m) => `${m.name} ${m.version}${m.requiredBy ? ` < ${m.requiredBy}` : ''}`);
const GAME = new Set(['base', 'space-age', 'quality', 'elevated-rails']);

test('versions compare by number, a missing part as 0', () => {
  assert.ok(compareVersions('0.16.2', '0.16.10') < 0);
  assert.equal(compareVersions('2.1', '2.1.0'), 0);
  assert.ok(compareVersions('2.1.24', '2.1') > 0);
});

test("the catalog offers a mod's releases for the Factorio version's line only, newest first, and picks the newest", async () => {
  const { fetch } = portal({}, {
    flib: { title: 'Factorio Library', releases: [rel('flib', '0.15.0', '2.0'), rel('flib', '0.16.0'), rel('flib', '0.16.2'), rel('flib', '0.17.0', '2.2')] },
  });
  const catalog = new FactorioCatalog(fetch);
  const r = await catalog.resolve('2.1.24', [{ name: 'flib', version: null }], GAME);
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(
    r.mods.map(({ sha1: _, downloadUrl: __, ...m }) => m),
    [{ name: 'flib', title: 'Factorio Library', version: '0.16.2', releases: ['0.16.2', '0.16.0'], requiredBy: null }],
  );
  assert.equal(r.mods[0]!.sha1, sha1('flib@0.16.2'));
  // A version picked by hand must be one for that line.
  assert.deepEqual(resolved(await catalog.resolve('2.1.24', [{ name: 'flib', version: '0.16.0' }], GAME)), ['flib 0.16.0']);
  const old = await catalog.resolve('2.1.24', [{ name: 'flib', version: '0.15.0' }], GAME);
  assert.deepEqual(old.mods, []);
  assert.deepEqual(old.unresolved, [{ mod: 'flib', dependency: 'flib = 0.15.0', reason: "flib 0.15.0 isn't a release for Factorio 2.1." }]);
  // Factorio 2.2 has only 0.17.0.
  assert.deepEqual(resolved(await catalog.resolve('2.2.0', [{ name: 'flib', version: null }], GAME)), ['flib 0.17.0']);
});

test("required dependencies resolve transitively, at versions meeting every limit and base's against the Factorio version; optional ones stay out", async () => {
  const { fetch } = portal({}, {
    // `~` is required too; `?` and `(?)` are optional; `B < 1.3.0` limits B.
    A: { releases: [rel('A', '1.0.0', '2.1', ['base >= 2.1.0', 'B >= 1.1.0', 'B < 1.3.0', '? C', '(?) D', '~ E', 'space-age'])] },
    // B 1.2.5 needs a newer base than 2.1.24: B 1.2.0 is the newest that fits.
    B: { releases: [rel('B', '1.0.0'), rel('B', '1.2.0', '2.1', ['base', 'F']), rel('B', '1.2.5', '2.1', ['base >= 2.1.30', 'F']), rel('B', '1.3.0')] },
    C: { releases: [rel('C', '1.0.0')] },
    D: { releases: [rel('D', '1.0.0')] },
    E: { releases: [rel('E', '3.0.0')] },
    // F's newest is for 2.0; and G's limit on F (picked by hand too) binds once both are there.
    F: { releases: [rel('F', '0.9.0'), rel('F', '1.0.0'), rel('F', '1.1.0', '2.0')] },
    G: { releases: [rel('G', '1.0.0', '2.1', ['? F <= 0.9.0'])] },
  });
  const catalog = new FactorioCatalog(fetch);
  const r = await catalog.resolve('2.1.24', [{ name: 'A', version: null }], GAME);
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(resolved(r), ['A 1.0.0', 'B 1.2.0 < A', 'E 3.0.0 < A', 'F 1.0.0 < B']);
  // An optional dependency's limit binds once its mod is in: G holds F at 0.9.0, which B accepts.
  const both = await catalog.resolve('2.1.24', [{ name: 'A', version: null }, { name: 'G', version: null }], GAME);
  assert.deepEqual(both.unresolved, []);
  assert.deepEqual(resolved(both), ['A 1.0.0', 'G 1.0.0', 'B 1.2.0 < A', 'E 3.0.0 < A', 'F 0.9.0 < B']);
  // On Factorio 2.1.30, B 1.2.5 fits.
  assert.deepEqual(resolved(await catalog.resolve('2.1.30', [{ name: 'A', version: null }], GAME)), ['A 1.0.0', 'B 1.2.5 < A', 'E 3.0.0 < A', 'F 1.0.0 < B']);
});

test('! incompatibilities are refused, and every dependency that cannot be met is shown', async () => {
  const { fetch } = portal({}, {
    A: { releases: [rel('A', '1.0.0', '2.1', ['base', '! G', '! quality', 'missing', 'H >= 9.0', 'space-age'])] },
    G: { releases: [rel('G', '1.0.0')] },
    H: { releases: [rel('H', '1.0.0')] },
    I: { releases: [rel('I', '1.0.0', '2.1', ['base >= 2.2.0'])] },
  });
  const catalog = new FactorioCatalog(fetch);
  const r = await catalog.resolve('2.1.24', [{ name: 'A', version: null }, { name: 'G', version: null }, { name: 'I', version: null }], new Set(['base', 'quality']));
  assert.deepEqual(resolved(r), ['A 1.0.0', 'G 1.0.0']);
  assert.deepEqual(r.unresolved, [
    { mod: 'I', dependency: 'base >= 2.2.0', reason: 'Factorio 2.1.24 is picked (I: the newest for Factorio 2.1 is 1.0.0).' },
    { mod: 'A', dependency: 'missing', reason: 'Not on the mod portal.' },
    { mod: 'A', dependency: 'H >= 9.0', reason: 'No release of H for Factorio 2.1 meets it (the newest for Factorio 2.1 is 1.0.0).' },
    { mod: 'A', dependency: 'space-age', reason: "space-age comes with Factorio, but it isn't enabled on this server." },
    { mod: 'A', dependency: '! G', reason: 'G is in the update too.' },
    { mod: 'A', dependency: '! quality', reason: 'quality comes with Factorio and is enabled on this server.' },
  ]);
  // A picked mod the portal doesn't have is a 404.
  await assert.rejects(catalog.resolve('2.1.24', [{ name: 'nope', version: null }], GAME), (err: GameRefused) => err.status === 404 && err.message === 'The mod portal has no mod nope.');
});

test("bad names, versions, hashes and links from the portal are rejected, never passed on", async () => {
  const { fetch } = portal(
    { [`${MODS}other/full`]: { body: { name: 'evil', releases: [] } }, [`${MODS}junk/full`]: { body: '<html>' }, [`${MODS}huge/full`]: { headers: { 'content-length': String(5 * 1024 * 1024) }, body: '{}' } },
    {
      A: {
        title: 'x'.repeat(500),
        releases: [
          rel('A', '../../x'),
          rel('A', '9.0'),
          rel('A', '8.0.0-beta'),
          rel('A', '7.0.0', '2.1', ['base'], { sha1: 'not-a-sha1' }),
          rel('A', '6.0.0', '2.1', ['base'], { download_url: '/download/../../etc/passwd' }),
          rel('A', '5.0.0', '2.1', ['base'], { download_url: 'https://evil.example/A.zip' }),
          rel('A', '4.0.0', '2.x'),
          rel('A', '3.0.0', '2.1', ['bad/name >= 1.0.0']), // a required dependency no mod can be
          rel('A', '2.0.0', '2.1', ['? bad..name', '! also/bad', 'base']), // optional and incompatible ones naming nothing are dropped
          rel('A', '1.0.0'),
        ],
      },
      B: { releases: [rel('B', '1.0.0', '2.1', ['A..B'])] },
    },
  );
  const catalog = new FactorioCatalog(fetch);
  const a = (await catalog.mod('A'))!;
  assert.deepEqual(a.releases.map((r) => r.version), ['3.0.0', '2.0.0', '1.0.0']);
  assert.equal(a.title.length, 200);
  assert.deepEqual(resolved(await catalog.resolve('2.1.24', [{ name: 'A', version: null }], GAME)), ['A 2.0.0']);
  const third = await catalog.resolve('2.1.24', [{ name: 'A', version: '3.0.0' }], GAME);
  assert.deepEqual(third.unresolved, [{ mod: 'A', dependency: 'bad/name >= 1.0.0', reason: 'Not a name a mod can have (A: 3.0.0 is picked).' }]);
  assert.deepEqual((await catalog.resolve('2.1.24', [{ name: 'B', version: null }], GAME)).unresolved, [
    { mod: 'B', dependency: 'A..B', reason: 'Not a name a mod can have (B: the newest for Factorio 2.1 is 1.0.0).' },
  ]);
  for (const [name, why] of [
    ['other', "The mod portal's answer for other names another mod."],
    ['junk', "The mod portal's answer for junk isn't JSON."],
    ['huge', `The mod portal's answer is over ${4 * 1024 * 1024} bytes.`],
  ]) {
    await assert.rejects(catalog.mod(name!), (err: GameRefused) => err.status === 502 && err.message === why, name);
  }
});

test("Factorio's releases and their sha256 come from factorio.com; a redirect is followed only to https on factorio.com, checked before it is asked", async () => {
  const hash = (n: number) => String(n).repeat(64).slice(0, 64);
  const sums = [`${hash(1)}  factorio-headless_linux_2.1.24.tar.xz`, `${hash(2)}  factorio-headless_linux-arm64_2.1.24.tar.xz`, `${hash(3)}  factorio-headless_linux-arm64_2.1.25.tar.xz`].join('\n');
  const { fetch, asked } = portal({
    'https://factorio.com/api/latest-releases': { body: { stable: { alpha: '2.1.24', headless: '2.1.24' }, experimental: { headless: '2.1.25' } } },
    'https://www.factorio.com/download/sha256sums/': { body: sums },
  });
  const catalog = new FactorioCatalog(fetch);
  assert.deepEqual(await catalog.releases(), [{ version: '2.1.24', channel: 'stable' }, { version: '2.1.25', channel: 'experimental' }]);
  assert.equal(await catalog.sha256('2.1.24'), hash(2));
  assert.equal(await catalog.sha256('2.1.25'), hash(3));
  assert.equal(await catalog.sha256('2.0.0'), undefined);
  assert.equal(catalog.download('2.1.24'), 'https://www.factorio.com/get-download/2.1.24/headless/linux-arm64');
  assert.equal(asked.filter((a) => a.url.includes('sha256sums')).length, 1); // reused, not asked again
  assert.ok(asked.every((a) => a.redirect === 'manual'), 'redirects are followed by the hub, each checked');

  const to = (location: string): Page => ({ status: 302, headers: { location } });
  const LATEST = 'https://factorio.com/api/latest-releases';
  // factorio.com to www.factorio.com, relative and absolute: followed.
  const moved = portal({ [LATEST]: to('https://www.factorio.com/api/x'), 'https://www.factorio.com/api/x': to('/api/latest'), 'https://www.factorio.com/api/latest': { body: { stable: { headless: '2.1.24' } } } });
  assert.deepEqual(await new FactorioCatalog(moved.fetch).releases(), [{ version: '2.1.24', channel: 'stable' }]);
  assert.deepEqual(moved.asked.map((a) => a.url), [LATEST, 'https://www.factorio.com/api/x', 'https://www.factorio.com/api/latest']);

  // To http, the hub's own loopback, another host, a port or a user: refused, and that hop never asked.
  for (const [location, why] of [
    ['http://factorio.com/api/latest-releases', 'factorio.com redirected away from https.'],
    ['https://127.0.0.1:25581/api/servers', 'factorio.com redirected away from factorio.com, www.factorio.com, mods.factorio.com.'],
    ['https://evil.example/x', 'factorio.com redirected away from factorio.com, www.factorio.com, mods.factorio.com.'],
    ['https://www.factorio.com:8443/x', 'factorio.com redirected away from factorio.com, www.factorio.com, mods.factorio.com.'],
    ['https://user@www.factorio.com/x', 'factorio.com redirected away from factorio.com, www.factorio.com, mods.factorio.com.'],
  ]) {
    const away = portal({ [LATEST]: to(location!) });
    await assert.rejects(new FactorioCatalog(away.fetch).releases(), (err: GameRefused) => err.status === 502 && err.message === why, location);
    assert.deepEqual(away.asked.map((a) => a.url), [LATEST], `${location} never asked`);
  }
  // A loop: 3 hops at most.
  const loop = portal({ [LATEST]: to(LATEST) });
  await assert.rejects(new FactorioCatalog(loop.fetch).releases(), (err: GameRefused) => err.status === 502 && err.message === 'factorio.com redirected more than 3 times.');
  assert.equal(loop.asked.length, 4);
});

test('a download link is the signed dl-mod.factorio.com one: asked with the account, never following a redirect, and passed on without it', async () => {
  const download = '/download/flib/5f9f3d3c3a5f4c0001b8c9e4';
  const asked = `https://mods.factorio.com${download}?username=owner&token=${ACCOUNT.token}`;
  const signed = 'https://dl-mod.factorio.com/files/5f/flib_0.16.2.zip?secure=Lk4AJh-V9cC_2wLJ8_7B5w,1730393211';
  const answer = (location: string | null, status = 302) => portal({ [asked]: { status, headers: location === null ? {} : { location } } });

  const ok = answer(signed);
  assert.equal(await new FactorioCatalog(ok.fetch, ACCOUNT).link(download), signed);
  assert.deepEqual(ok.asked, [{ url: asked, redirect: 'manual' }]);

  const refusals: [ReturnType<typeof answer>, string][] = [
    [answer(`https://dl-mod.factorio.com/files/5f/flib.zip?secure=x&token=${ACCOUNT.token}`), 'signed'],
    [answer('https://dl-mod.factorio.com/files/5f/flib.zip?secure=x&username=owner'), 'signed'],
    [answer(`https://dl-mod.factorio.com/files/${ACCOUNT.token}/flib.zip?secure=x`), 'signed'],
    [answer('https://evil.example/flib.zip?secure=x'), 'signed'],
    [answer('http://dl-mod.factorio.com/flib.zip?secure=x'), 'signed'],
    [answer('https://dl-mod.factorio.com:8443/flib.zip?secure=x'), 'signed'],
    [answer('https://dl-mod.factorio.com/flib.zip'), 'signed'],
    [answer(`https://dl-mod.factorio.com/${'x'.repeat(2100)}.zip?secure=x`), 'over 2048 characters'],
    [answer(null, 200), 'HTTP 200'],
    [answer(null, 403), 'HTTP 403: check FACTORIO_USERNAME and FACTORIO_TOKEN'],
  ];
  for (const [fake, why] of refusals) {
    await assert.rejects(new FactorioCatalog(fake.fetch, ACCOUNT).link(download), (err: GameRefused) => {
      assert.equal(err.status, 502);
      assert.ok(err.message.includes(why), err.message);
      assert.ok(!err.message.includes(ACCOUNT.token) && !err.message.includes('username='), err.message);
      return true;
    });
  }
  const down: PortalFetch = async () => {
    throw new TypeError(`fetch failed for ${asked}`, { cause: { code: 'ECONNRESET' } });
  };
  await assert.rejects(new FactorioCatalog(down, ACCOUNT).link(download), (err: GameRefused) => err.message === "The mod portal didn't give a download link: ECONNRESET.");
  // Without the account: refused, saying how to fix it; nothing asked.
  const none = answer(signed);
  await assert.rejects(new FactorioCatalog(none.fetch).link(download), (err: GameRefused) => err.status === 409 && /FACTORIO_USERNAME and FACTORIO_TOKEN aren't set/.test(err.message));
  assert.deepEqual(none.asked, []);
});

test('a release on both channels is listed once, as stable', async () => {
  const { fetch } = portal({ 'https://factorio.com/api/latest-releases': { body: { stable: { headless: '2.1.24' }, experimental: { headless: '2.1.24' } } } });
  assert.deepEqual(await new FactorioCatalog(fetch).releases(), [{ version: '2.1.24', channel: 'stable' }]);
});

// The mod browser.
const LIST = (line = '2.1') => `https://mods.factorio.com/api/mods?page_size=max&version=${line}&hide_deprecated=true`;
const CATEGORIES = 'https://mods.factorio.com/api/categories';
const CATS = [
  ['content', 'Content', 'Mods introducing new content into the game.'],
  ['tweaks', 'Tweaks', 'Small changes.'],
  ['mod-packs', 'Mod packs', 'Collections of mods.'],
];
/** A row of the portal's list for a line: its newest release for that line. */
const row = (name: string, extra: Record<string, unknown> = {}, release: Record<string, unknown> = {}) => ({
  name,
  title: name,
  owner: 'someone',
  summary: `About ${name}`,
  downloads_count: 10,
  category: 'content',
  score: 1,
  latest_release: { version: '1.0.0', released_at: '2026-10-01T00:00:00.000Z', sha1: sha1(name), info_json: { factorio_version: '2.1' }, ...release },
  ...extra,
});
const browse: { q: string; category: string; sort: PortalSort; page: number } = { q: '', category: '', sort: 'downloads', page: 1 };

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

const SHORT = 'https://mods.factorio.com/api/mods/';
const THUMB = (sha: string) => `/assets/${sha}.thumb.png`;
const png = (size = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size - 8, 7)]);
/** A fake portal for thumbnails: short pages by name, images by path; every request recorded. */
function thumbs(pages: Record<string, unknown>, images: Record<string, () => Response> = {}) {
  const asked: { url: string; redirect: string }[] = [];
  const fetch: PortalFetch = async (url, init) => {
    asked.push({ url, redirect: init.redirect });
    if (url.startsWith(SHORT)) {
      const name = decodeURIComponent(url.slice(SHORT.length));
      const page = pages[name];
      return page === undefined ? new Response('', { status: 404 }) : new Response(typeof page === 'string' ? page : JSON.stringify(page));
    }
    const path = url.startsWith('https://assets-mod.factorio.com/') ? url.slice('https://assets-mod.factorio.com'.length) : '';
    return images[path]?.() ?? new Response('', { status: 404 });
  };
  return { fetch, asked };
}
const image = (body: Uint8Array | string, type = 'image/png', status = 200, headers: Record<string, string> = {}) => () =>
  new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers: { 'content-type': type, ...headers } });

test('a thumbnail: its path from the short page, the PNG from assets-mod.factorio.com alone, no redirect, kept by its sha1', async () => {
  const A = sha1('a');
  const { fetch, asked } = thumbs(
    {
      'Squeak Through': { name: 'Squeak Through', thumbnail: THUMB(A) },
      twin: { name: 'twin', thumbnail: THUMB(A) },
      none: { name: 'none' },
      empty: { name: 'empty', thumbnail: null },
      dotdot: { name: 'dotdot', thumbnail: `/assets/../${A}.thumb.png` },
      offsite: { name: 'offsite', thumbnail: `https://evil.example/assets/${A}.thumb.png` },
      jpeg: { name: 'jpeg', thumbnail: `/assets/${A}.thumb.jpg` },
      liar: { name: 'someone-else', thumbnail: THUMB(A) },
      junk: '<html>',
      big: `{"name":"big","thumbnail":"${THUMB(A)}","x":"${'x'.repeat(512 * 1024)}"}`,
    },
    { [THUMB(A)]: image(png(), 'image/png; charset=binary') },
  );
  const catalog = new FactorioCatalog(fetch);
  assert.deepEqual(Buffer.from((await catalog.thumbnail('Squeak Through'))!), png());
  assert.deepEqual(asked, [
    { url: 'https://mods.factorio.com/api/mods/Squeak%20Through', redirect: 'manual' },
    { url: `https://assets-mod.factorio.com${THUMB(A)}`, redirect: 'manual' },
  ]);
  // Again, or another mod with the same image: no image read again; the same name: nothing read at all.
  await catalog.thumbnail('Squeak Through');
  assert.equal(asked.length, 2);
  await catalog.thumbnail('twin');
  assert.deepEqual(asked.slice(2).map((a) => a.url), ['https://mods.factorio.com/api/mods/twin']);
  // No thumbnail: none, null, a path not the pattern, another mod's page, not JSON, a page over 512 KiB, no such mod.
  for (const name of ['none', 'empty', 'dotdot', 'offsite', 'jpeg', 'liar', 'junk', 'big', 'unknown']) {
    assert.equal(await catalog.thumbnail(name), null, name);
  }
  assert.ok(asked.every((a) => !a.url.includes('evil') && !a.url.endsWith('.jpg')));
  // A name that isn't a mod's: no request. `.` alone would read /api/mods/, the portal's list.
  const before = asked.length;
  for (const name of ['../etc', 'a/b', '', '.']) assert.equal(await catalog.thumbnail(name), null);
  assert.equal(asked.length, before);
});

test('a thumbnail that redirects, is not image/png, has no PNG signature or is over 512 KiB is refused (502); a failure is not kept', async () => {
  const sha = (n: number) => sha1(`img-${n}`);
  const cases: [() => Response, string][] = [
    [image('', 'image/png', 302, { location: `https://assets-mod.factorio.com${THUMB(sha(9))}` }), "The mod portal's thumbnail redirected, which is never followed."],
    [image(png(), 'image/jpeg'), "The mod portal's thumbnail isn't image/png."],
    [image(png(), 'text/html'), "The mod portal's thumbnail isn't image/png."],
    [image('<svg onload=alert(1)>'), "The mod portal's thumbnail isn't a PNG."],
    [image(png(512 * 1024 + 1)), `The mod portal's thumbnail's answer is over ${512 * 1024} bytes.`],
    [image('', 'image/png', 500), "The mod portal's thumbnail can't be read: HTTP 500."],
  ];
  for (const [i, [answer, why]] of cases.entries()) {
    const { fetch, asked } = thumbs({ m: { name: 'm', thumbnail: THUMB(sha(i)) } }, { [THUMB(sha(i))]: answer });
    const catalog = new FactorioCatalog(fetch);
    await assert.rejects(catalog.thumbnail('m'), (err: GameRefused) => err.status === 502 && err.message === why, why);
    assert.equal(asked.length, 2, 'a redirect is never followed');
    await assert.rejects(catalog.thumbnail('m'));
    assert.deepEqual(asked.slice(2).map((a) => a.url), [`https://assets-mod.factorio.com${THUMB(sha(i))}`], 'the image is asked again; the path was kept');
  }
  // The short page failing is 502 too.
  await assert.rejects(new FactorioCatalog(async () => new Response('', { status: 503 })).thumbnail('m'), (err: GameRefused) => err.status === 502);
});

test('at most 4 portal reads for thumbnails run at once', async () => {
  let running = 0;
  let peak = 0;
  const held: (() => void)[] = [];
  const fetch: PortalFetch = async (url) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise<void>((go) => held.push(go));
    running--;
    if (url.startsWith(SHORT)) {
      const name = decodeURIComponent(url.slice(SHORT.length));
      return Response.json({ name, thumbnail: THUMB(sha1(name)) });
    }
    return new Response(new Uint8Array(png()), { headers: { 'content-type': 'image/png' } });
  };
  const catalog = new FactorioCatalog(fetch);
  const all = Promise.all(Array.from({ length: 10 }, (_, i) => catalog.thumbnail(`mod-${i}`)));
  // Let each held read go, one at a time, until all 20 (10 pages, 10 images) are done.
  let done = false;
  void all.then(() => (done = true));
  for (let i = 0; !done && i < 1000; i++) {
    await new Promise((r) => setImmediate(r));
    held.shift()?.();
  }
  assert.equal((await all).length, 10);
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.equal(peak, 4);
});

// The Import mod list's check.
test("the mod list check answers from the line's list, reads only the names missing from it, one by one, and at most 20 of them", async () => {
  const unlisted = Array.from({ length: 25 }, (_, i) => `gone-${String(i).padStart(2, '0')}`);
  const { fetch, asked } = portal(
    {
      [LIST()]: { body: { results: [row('flib', { title: 'Factorio Library' }, { version: '0.16.2' }), row('Squeak Through')] } },
      [`${MODS}flaky/full`]: { status: 503 },
    },
    {
      // Deprecated, so the list leaves it out, but it has a 2.1 release; old has 2.0 releases only.
      retired: { title: 'Retired‮ mod', releases: [rel('retired', '1.0.0', '2.0'), rel('retired', '1.1.0')] },
      old: { releases: [rel('old', '0.1.0', '2.0')] },
    },
  );
  const catalog = new FactorioCatalog(fetch);
  const names = ['flib', 'retired', 'old', 'nowhere', 'flaky', 'Squeak Through', ...unlisted];
  const answer = await catalog.check('2.1', names);
  assert.deepEqual(answer.slice(0, 6), [
    { name: 'flib', found: 'fits', title: 'Factorio Library', latest: '0.16.2' },
    { name: 'retired', found: 'fits', title: 'Retired mod', latest: '1.1.0' },
    { name: 'old', found: 'noRelease', title: 'old', latest: null },
    { name: 'nowhere', found: 'missing', title: null, latest: null },
    { name: 'flaky', found: 'unchecked', title: null, latest: null },
    { name: 'Squeak Through', found: 'fits', title: 'Squeak Through', latest: '1.0.0' },
  ]);
  // 4 unlisted names above, then 16 of the 25: the other 9 aren't read.
  assert.deepEqual(answer.slice(6).map((m) => m.found), [...Array(16).fill('missing'), ...Array(9).fill('unchecked')]);
  const full = asked.filter((a) => a.url.endsWith('/full')).map((a) => decodeURIComponent(a.url.slice(MODS.length, -'/full'.length)));
  assert.deepEqual(full.sort(), ['flaky', 'nowhere', 'old', 'retired', ...unlisted.slice(0, 16)].sort());
  assert.equal(asked.filter((a) => a.url === LIST()).length, 1);
  assert.ok(asked.every((a) => a.redirect === 'manual'));
  // The list is the mod browser's, kept: a second check reads it no more, and the mods read are cached too.
  asked.length = 0;
  await catalog.check('2.1', ['flib', 'old']);
  assert.deepEqual(asked, []);
  await assert.rejects(catalog.check('2.1.24', ['flib']), (err: GameRefused) => err.status === 400);
  // No names: nothing read at all.
  assert.deepEqual(await new FactorioCatalog(async () => assert.fail('read')).check('2.0', []), []);
  // The list failing fails the check.
  const down = new FactorioCatalog(async () => new Response('', { status: 503 }));
  await assert.rejects(down.check('2.1', ['flib']), (err: GameRefused) => err.status === 502 && err.message === "The mod portal can't be read: HTTP 503.");
});

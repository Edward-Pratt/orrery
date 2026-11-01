import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
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

test("Factorio's releases and their sha256 come from factorio.com; a redirect away from https is refused", async () => {
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
  assert.ok(asked.every((a) => a.redirect === 'follow'));

  const away = new FactorioCatalog(portal({ 'https://factorio.com/api/latest-releases': { body: {}, url: 'http://factorio.com/api/latest-releases' } }).fetch);
  await assert.rejects(away.releases(), (err: GameRefused) => err.status === 502 && err.message === 'factorio.com redirected away from https.');
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

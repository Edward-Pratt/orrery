// The catalog on a fake portal alone (`factorio.ts`): versions, a mod's checked page, factorio.com's releases and
// sha256 with the public read's redirect rules (`factorio-fetch.ts`), and the Import mod list's check.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, FactorioCatalog, GameRefused } from '../../src/updates/factorio.ts';
import { GAME, LIST, MODS, portal, rel, resolved, row, type Page } from './factorio-portal.ts';

test('versions compare by number, a missing part as 0', () => {
  assert.ok(compareVersions('0.16.2', '0.16.10') < 0);
  assert.equal(compareVersions('2.1', '2.1.0'), 0);
  assert.ok(compareVersions('2.1.24', '2.1') > 0);
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

test('a release on both channels is listed once, as stable', async () => {
  const { fetch } = portal({ 'https://factorio.com/api/latest-releases': { body: { stable: { headless: '2.1.24' }, experimental: { headless: '2.1.24' } } } });
  assert.deepEqual(await new FactorioCatalog(fetch).releases(), [{ version: '2.1.24', channel: 'stable' }]);
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

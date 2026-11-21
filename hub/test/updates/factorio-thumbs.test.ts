// The mod browser's thumbnails (`factorio-thumbs.ts`, through `FactorioCatalog.thumbnail`): the path, the image, the
// refusals and the 4 reads at once.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactorioCatalog, GameRefused, type PortalFetch } from '../../src/updates/factorio.ts';
import { sha1 } from './factorio-portal.ts';

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

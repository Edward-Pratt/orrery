import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GameRefused, type PortalFetch } from '../../src/updates/factorio.ts';
import { ModsZip, type ModsZipDeps } from '../../src/updates/mods-zip.ts';
import type { FactorioMod } from '../../src/types.ts';
import { Hono } from 'hono';
import { serveWebApi, type WebApi } from '../../src/web/web.ts';
import { gameExtrasRoutes } from '../../src/web/web-game-extras.ts';
import { eventually, ready } from '../fake-agent.ts';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const file = (name: string, version: string) => `zip of ${name} ${version}`;
const cdn = (name: string) => `https://dl-mod.factorio.com/files/${name}.zip?secure=sig`;

/** A ModsZip over a server running `mods`, a portal holding `flib` 0.16.3 and `helmod` 2.0.1, and the CDN serving `served`. */
function world(mods: FactorioMod[] | null, served: (name: string) => string | null = (n) => file(n, n === 'flib' ? '0.16.3' : '2.0.1')) {
  const releases: Record<string, string> = { flib: '0.16.3', helmod: '2.0.1' };
  const asked: string[] = [];
  const fetch: PortalFetch = async (url, { signal }) => {
    asked.push(url);
    const name = /\/files\/([^/]+)\.zip/.exec(url)?.[1];
    const body = name ? served(name) : '';
    // null: a download that never answers, until it is aborted.
    if (body === null) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error)));
    return name ? new Response(body) : new Response('', { status: 404 });
  };
  const catalog: ModsZipDeps['catalog'] = {
    mod: async (name) => {
      const v = releases[name];
      return v ? { name, title: name, releases: [{ version: v, line: '2.1', sha1: sha1(file(name, v)), downloadUrl: `/download/${name}/x`, dependencies: [], bad: null }] } : null;
    },
    link: async (url) => cdn(url.split('/')[2]!),
  };
  const gameUpdates = { has: (id: string) => id === 'fac', state: () => ({ installed: mods && { factorio: '2.1.24', mods } }) } as unknown as ModsZipDeps['gameUpdates'];
  return { zip: new ModsZip({ catalog, fetch, gameUpdates }), asked };
}

const RUNS = [
  { name: 'base', version: '2.1.24' },
  { name: 'flib', version: '0.16.3' },
  { name: 'helmod', version: '2.0.1' },
];

test('the mods zip: each portal mod at the version the server runs, stored, and a mod-list.json enabling all', async (t) => {
  const { zip } = world(RUNS);
  const bytes = Buffer.from(await new Response(await zip.open('fac')).arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), 'mods-zip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'mods.zip'), bytes);
  execFileSync('unzip', ['-tq', join(dir, 'mods.zip')]);
  assert.equal(execFileSync('unzip', ['-p', join(dir, 'mods.zip'), 'flib_0.16.3.zip'], { encoding: 'utf8' }), file('flib', '0.16.3'));
  const list = JSON.parse(execFileSync('unzip', ['-p', join(dir, 'mods.zip'), 'mod-list.json'], { encoding: 'utf8' })) as unknown;
  assert.deepEqual(list, { mods: RUNS.map((m) => ({ name: m.name, enabled: true })) });
  const names = execFileSync('unzip', ['-Z1', join(dir, 'mods.zip')], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(names, ['flib_0.16.3.zip', 'helmod_2.0.1.zip', 'mod-list.json']);
  // Done: another can be made.
  await (await zip.open('fac')).cancel();
});

test('the mods zip refuses before any download: a version the portal lacks, no installed, one already being made', async () => {
  const { zip, asked } = world([...RUNS, { name: 'flib2', version: '1.0.0' }, { name: 'helmod', version: '9.9.9' }]);
  await assert.rejects(zip.open('fac'), (e: GameRefused) => e.status === 409 && /flib2 1\.0\.0, helmod 9\.9\.9/.test(e.message));
  assert.deepEqual(asked, []);
  await assert.rejects(world(null).zip.open('fac'), (e: GameRefused) => e.status === 409);
  await assert.rejects(world([RUNS[0]!]).zip.open('fac'), (e: GameRefused) => e.status === 409 && /no mods/.test(e.message));
  const one = world(RUNS).zip;
  const first = await one.open('fac');
  await assert.rejects(one.open('fac'), (e: GameRefused) => e.status === 429);
  await first.cancel();
  await (await one.open('fac')).cancel();
});

test("the mods zip errors the stream when a download doesn't match the portal's sha1", async () => {
  const { zip } = world(RUNS, (n) => `tampered ${n}`);
  await assert.rejects(new Response(await zip.open('fac')).arrayBuffer(), /doesn't match the portal's sha1/);
  await (await zip.open('fac')).cancel(); // and the server isn't left busy
});

test('GET …/game/mods.zip: an attachment for a server an Agent runs, after its report; 404 otherwise', async (t) => {
  const h = await ready(t);
  const res = await h.req('GET', '/api/servers/space/game/mods.zip');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="space-mods.zip"');
  await res.body?.cancel();
  assert.equal((await h.req('GET', '/api/servers/gtnh/game/mods.zip')).status, 404);
  assert.equal((await h.req('GET', '/api/servers/nope/game/mods.zip')).status, 404);
});

/** The route on a real socket, over `zip`. */
async function served(t: import('node:test').TestContext, zip: ModsZip) {
  const app = new Hono();
  gameExtrasRoutes(app as never, { modsZip: zip, actor: () => '', body: async () => ({}) });
  const http = await serveWebApi(app as unknown as WebApi, 0);
  t.after(() => http.close());
  return `http://127.0.0.1:${http.port}/servers/fac/game/mods.zip`;
}

test('on a real socket: a client going away frees the server for the next zip; a bad download fails the read', async (t) => {
  const slow = world(RUNS, (n) => (n === 'flib' ? file('flib', '0.16.3') : null));
  const url = await served(t, slow.zip);
  const client = new AbortController();
  const res = await fetch(url, { signal: client.signal });
  assert.equal(res.status, 200);
  await res.body!.getReader().read(); // flib's entry
  client.abort();
  await eventually(async () => {
    try {
      await (await slow.zip.open('fac')).cancel();
      return true;
    } catch {
      return false;
    }
  });
  const bad = world(RUNS, (n) => `tampered ${n}`);
  const res2 = await fetch(await served(t, bad.zip));
  assert.equal(res2.status, 200);
  await assert.rejects(res2.arrayBuffer());
});

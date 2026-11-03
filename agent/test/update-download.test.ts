// Game updates, on the Host `fake-world.ts` builds: a failing download (an HTTP error naming the signed link, a 403
// after a redirect) with no query string in the steps, `agent.log` or the journal; a stalled answer and a stalled body
// ("No data from …") and a `Content-Length` over the cap.
import assert from 'node:assert/strict';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentLog, logTo } from '../src/logs.ts';
import { type Http } from '../src/update.ts';
import { SUMS, sha256, tarball, signedGame, modUrl, world, exists } from './fake-world.ts';

test('a failing download leaves no query string in step details or agent.log', async (t) => {
  const w = await world(t);
  const log = join(w.dir, 'agent.log');
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const out: string[] = [];
  t.after(() => Object.assign(console, original));
  for (const level of ['log', 'info', 'warn', 'error'] as const) console[level] = (...args: unknown[]) => void out.push(args.join(' '));
  logTo(new AgentLog(log));

  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  // The mod's CDN fails with an error naming the signed link, as an HTTP client's might.
  w.routes.set(modUrl('flib', '0.16.2'), async () => {
    throw new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED for ${modUrl('flib', '0.16.2')}`) });
  });
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']]));
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.equal((await w.step('prepare', 'failed')).detail, "Can't download https://dl-mod.factorio.com/files/flib_0.16.2.zip: connect ECONNREFUSED for https://dl-mod.factorio.com/files/flib_0.16.2.zip");

  // The game's signed link, after factorio.com's redirect, answering 403.
  w.sent.length = 0;
  w.offer('2.1.26');
  w.routes.set(signedGame('2.1.26'), async () => new Response('expired', { status: 403 }));
  await w.u.update(w.request('2.1.26', [['orrery', '0.2.0']], 'u2'));
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.equal((await w.step('prepare', 'failed')).detail, 'https://dl.factorio.com/releases/factorio-headless_linux_2.1.26.tar.xz answered HTTP 403');

  Object.assign(console, original);
  const written = await readFile(log, 'utf8');
  assert.match(written, /prepare failed: Can't download https:\/\/dl-mod\.factorio\.com\/files\/flib_0\.16\.2\.zip/);
  for (const [what, text] of [['steps', JSON.stringify(w.sent)], ['agent.log', written], ['the journal', out.join('\n')]] as const) {
    assert.ok(!/SECRET|secure=|\?/.test(text), `no query string in ${what}: ${text}`);
  }
  assert.deepEqual(await readdir(join(w.data, '.incoming')), []);
});

test('a download that gets no byte for the stall time fails prepare with a clear step error; one over its cap is refused before it is read', async (t) => {
  const w = await world(t, { stallMs: 100 });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  const mods: [string, string][] = [['orrery', '0.2.0'], ['flib', '0.16.2']];
  /** An answer that never comes: aborted with the request, as fetch's is. */
  const silent: Http = (_url, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const failed = async () => {
    const done = await w.done();
    const step = await w.step('prepare', 'failed');
    w.sent.length = 0;
    return [done.outcome, step.detail];
  };

  // factorio.com's sha256 list never answers.
  const sums = w.routes.get(SUMS)!;
  w.routes.set(SUMS, silent);
  await w.u.update(w.request('2.1.25', mods));
  assert.deepEqual(await failed(), ['failed in staging', 'No data from https://www.factorio.com/download/sha256sums/ for 0.1 s: the download was stopped']);
  w.routes.set(SUMS, sums);

  // The game's signed link says it is over the 1 GiB cap: refused before anything is written.
  let created = false;
  w.routes.set(signedGame('2.1.25'), async () => {
    created = (await readdir(join(w.install, '.incoming'))).length > 0;
    return new Response(new Uint8Array(10), { headers: { 'content-length': String(2 * 1024 ** 3) } });
  });
  await w.u.update(w.request('2.1.25', mods, 'u2'));
  assert.deepEqual(await failed(), ['failed in staging', `https://dl.factorio.com/releases/${tarball('2.1.25')} is over 1073.7 MB`]);
  assert.equal(created, false);
  assert.deepEqual(await readdir(join(w.install, '.incoming')), []);
  w.offer('2.1.25');

  // flib's download sends a little, then nothing.
  w.routes.set(modUrl('flib', '0.16.2'), async (_url, signal) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(1000));
        signal.addEventListener('abort', () => c.error(signal.reason));
      },
    });
    return new Response(body);
  });
  await w.u.update(w.request('2.1.25', mods, 'u3'));
  assert.deepEqual(await failed(), ['failed in staging', 'No data from https://dl-mod.factorio.com/files/flib_0.16.2.zip for 0.1 s: the download was stopped']);
  assert.deepEqual(await readdir(join(w.data, '.incoming')), []);
  assert.equal(await exists(join(w.data, 'mods.next')), false);
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  assert.deepEqual(w.unit.calls, []);
});

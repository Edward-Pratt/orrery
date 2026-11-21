// Chunked uploads (`uploads.ts`).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CompareReport, LibraryState, PackState, UploadAnswer, UploadProgress } from '../../src/api.ts';
import { WEB } from '../web/web-hub.ts';
import { sleep } from '../fake-mod.ts';
import { sha, URL_OLD, world } from './pack-world.ts';
import { start } from './pack-hub.ts';

test('chunks in order make an upload, hashed once complete, that can be adopted from, once', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const id = await s.upload(w.urls[URL_OLD]!, 'GT_New_Horizons_2.7.4_Server_Java_17-21.zip', 700);
  assert.deepEqual(await s.json<UploadProgress>(s.req('GET', `/api/uploads/${id}`)), { received: statSync(w.urls[URL_OLD]!).size });
  assert.deepEqual(readdirSync(join(w.root, 'data', 'uploads')), [id]);
  const body = { upload: id, name: 'GT New Horizons', version: '2.7.4', mc: '1.7.10', loader: 'forge' };
  await s.json(s.req('POST', '/api/library/packs', body), 202);
  assert.equal((await s.req('POST', '/api/library/packs', { ...body, version: '2' })).status, 400); // used
  while ((await s.json<LibraryState>(s.req('GET', '/api/library'))).packs.length === 0) await sleep(10);
  const [entry] = (await s.json<LibraryState>(s.req('GET', '/api/library'))).packs;
  assert.deepEqual([entry!.source, entry!.sha256], ['GT_New_Horizons_2.7.4_Server_Java_17-21.zip', sha(w.urls[URL_OLD]!)]); // its sha256 was right
  assert.equal((await s.json<CompareReport>(s.req('POST', '/api/servers/gtnh/pack/compare', { library: entry!.id }))).matching, 5);
});

test('a chunk only at the bytes received: a wrong offset is 409 with the size, a failed or oversize chunk leaves nothing', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  await s.adopt();
  const { upload: id } = await s.json<UploadAnswer>(s.req('POST', '/api/uploads', { fileName: 'a.jar', size: 10 }));
  assert.deepEqual(await s.json<UploadProgress>(s.chunk(id, 0, 'abcd')), { received: 4 });
  for (const offset of [0, 2, 6]) {
    const res = await s.chunk(id, offset, 'efgh');
    assert.equal(res.status, 409, String(offset));
    assert.deepEqual(await res.json(), { received: 4 });
  }
  const over = await s.chunk(id, 4, 'efghijk'); // 7 bytes where 6 are left
  assert.equal(over.status, 413);
  assert.deepEqual(await s.json<UploadProgress>(s.req('GET', `/api/uploads/${id}`)), { received: 4 });
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/extras', { upload: id, target: 'mods/a.jar' })).status, 400); // not complete
  assert.deepEqual(await s.json<UploadProgress>(s.chunk(id, 4, 'efghij')), { received: 10 }); // re-sent after the 409s
  assert.equal(readFileSync(join(w.root, 'data', 'uploads', id), 'utf8'), 'abcdefghij');
  assert.equal((await s.chunk(id, 10, 'k')).status, 409); // complete
  const p = await s.json<PackState>(s.req('POST', '/api/servers/gtnh/pack/extras', { upload: id, target: 'mods/a.jar' }));
  assert.equal(p.extras.find((e) => e.target === 'mods/a.jar')!.sha256, createHash('sha256').update('abcdefghij').digest('hex'));
  // An empty file is complete at once.
  const { upload: empty } = await s.json<UploadAnswer>(s.req('POST', '/api/uploads', { fileName: 'empty.cfg', size: 0 }));
  assert.deepEqual(await s.json<UploadProgress>(s.req('GET', `/api/uploads/${empty}`)), { received: 0 });
  await s.json(s.req('POST', '/api/servers/gtnh/pack/extras', { upload: empty, target: 'config/empty.cfg' }));
});

test('uploads are capped at 4 GiB and chunks at 64 MiB; bad requests are refused', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  for (const body of [{ fileName: 'a.zip', size: 4 * 1024 ** 3 + 1 }, { fileName: 'a.zip', size: -1 }, { fileName: 'a.zip', size: 1.5 }, { fileName: 'a.zip' }]) {
    assert.equal((await s.req('POST', '/api/uploads', body)).status, 400, JSON.stringify(body));
  }
  const { upload: id } = await s.json<UploadAnswer>(s.req('POST', '/api/uploads', { fileName: 'big.zip', size: 4 * 1024 ** 3 }));
  assert.equal((await s.chunk(id, 0, Buffer.alloc(64 * 1024 ** 2 + 1))).status, 413);
  assert.deepEqual(await s.json<UploadProgress>(s.req('GET', `/api/uploads/${id}`)), { received: 0 });
  assert.equal(statSync(join(w.root, 'data', 'uploads', id)).size, 0);
  assert.deepEqual(await s.json<UploadProgress>(s.chunk(id, 0, Buffer.alloc(64 * 1024 ** 2))), { received: 64 * 1024 ** 2 });
  for (const offset of ['', 'x', '-1', '1e3']) assert.equal((await s.app.request(`/api/uploads/${id}?offset=${offset}`, { method: 'PUT', headers: { cookie: s.cookie, origin: WEB.publicUrl, 'content-type': 'application/octet-stream' }, body: 'x' })).status, 400, offset);
  assert.equal((await s.chunk('f'.repeat(32), 0, 'x')).status, 404);
  assert.equal((await s.req('GET', `/api/uploads/${'f'.repeat(32)}`)).status, 404);
  // The chunk route is the one exception to JSON, and only for raw bytes; its Origin is checked all the same.
  assert.equal((await s.chunk(id, 64 * 1024 ** 2, 'x', { 'content-type': 'application/json' })).status, 415);
  assert.equal((await s.chunk(id, 64 * 1024 ** 2, 'x', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await s.chunk(id, 64 * 1024 ** 2, 'x', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await s.app.request('/api/uploads', { method: 'POST', headers: { cookie: s.cookie, origin: WEB.publicUrl, 'content-type': 'application/octet-stream' }, body: '{}' })).status, 415);
  assert.equal((await s.app.request(`/api/uploads/${id}`, { headers: {} })).status, 401);
});

test('uploads are dropped an hour after their last chunk, and cleared at start', async (t) => {
  const w = world(t);
  const s = await start(t, w, { uploadIdleMs: 200 });
  const { upload: idle } = await s.json<UploadAnswer>(s.req('POST', '/api/uploads', { fileName: 'a.zip', size: 10 }));
  const { upload: busy } = await s.json<UploadAnswer>(s.req('POST', '/api/uploads', { fileName: 'b.zip', size: 10 }));
  for (let i = 0; i < 4; i++) {
    await sleep(100);
    await s.json(s.chunk(busy, i, 'x'));
  }
  assert.equal((await s.req('GET', `/api/uploads/${idle}`)).status, 404);
  assert.deepEqual(readdirSync(join(w.root, 'data', 'uploads')), [busy]);
  await s.close();
  await start(t, w);
  assert.ok(!existsSync(join(w.root, 'data', 'uploads')));
});

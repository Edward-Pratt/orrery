// Java runtimes (#141).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LibraryAdd } from '../../src/api.ts';
import { sha } from './pack-world.ts';
import { JDK, runtimeHub } from './library-hub.ts';

test('a runtime is added from Adoptium, checked with java -version, and listed; the same build again is already installed', async (t) => {
  const { s, lib, adds, addRuntime, finished, tarball, data } = await runtimeHub(t);
  await addRuntime();
  assert.deepEqual(await finished(), ['ok', '']);
  assert.ok(adds.every((e) => (e as LibraryAdd & { id: string }).id === 'runtimes'));
  assert.deepEqual(
    adds.filter((e) => e.phase === 'progress').map((e) => e.phase === 'progress' && e.detail.replace(/ [\d.]+ [KMG]?B of .*/, '')),
    ['Asking Adoptium', 'Downloading', 'Downloading', 'Checking the download', 'Unpacking', 'Running java -version', 'Storing'],
  );
  const { runtimes } = await lib();
  assert.deepEqual(runtimes.map(({ at: _, ...r }) => r), [
    { name: 'temurin-21.0.8+9', label: 'Temurin 21.0.8+9', feature: 21, size: statSync(tarball).size, sha256: sha(tarball), by: 'alex', usedBy: [] },
  ]);
  assert.ok(existsSync(join(data, 'runtimes', 'temurin-21.0.8+9', 'bin', 'java')));
  assert.deepEqual(readdirSync(join(data, 'work')), []);
  await addRuntime();
  assert.deepEqual(await finished(2), ['ok', 'Temurin 21.0.8+9 is already installed.']);
  assert.equal(s.fake.requests.filter((r) => r.url === JDK).length, 1); // not downloaded again
  for (const feature of [11, '21', undefined]) assert.equal((await s.req('POST', '/api/library/runtimes', { feature })).status, 400, String(feature));
  assert.deepEqual((await s.audit('library runtime')).map((e) => e.details), ['Temurin 21', 'Temurin 21.0.8+9: ok', 'Temurin 21', 'Temurin 21.0.8+9: ok: Temurin 21.0.8+9 is already installed.']);
});

test('a java -version that fails, or a wrong sha256, leaves nothing installed', async (t) => {
  for (const [setup, why] of [
    [{ javaFails: true }, "java -version failed on this host, so it isn't installed: Exec format error"],
    [{ checksum: 'f'.repeat(64) }, "The download's sha256 doesn't match Adoptium's: not installed."],
  ] as const) {
    const { lib, addRuntime, finished, data, s } = await runtimeHub(t, setup);
    await addRuntime();
    assert.deepEqual(await finished(), ['failed', why]);
    assert.deepEqual((await lib()).runtimes, []);
    assert.ok(!existsSync(join(data, 'runtimes')));
    assert.deepEqual(readdirSync(join(data, 'work')), []);
    await s.close();
  }
});

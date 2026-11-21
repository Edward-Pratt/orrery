// The library tests' hubs, shared by `test/packs/`: `libraryHub` (a hub on a world with 2.7.6, a Forge jar at its
// root, behind `URL_FORGE` too, recording the library's add events) and `runtimeHub` (one whose fake Adoptium offers
// Temurin 21.0.8+9, `JDK`).

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { LibraryAdd, LibraryState } from '../../src/api.ts';
import { until } from '../fake-mod.ts';
import { PACK_NEW, type Setup, sha, world, type World, write } from './pack-world.ts';
import { start } from './pack-hub.ts';

export const URL_FORGE = 'https://packs.example/GTNH_2.7.6.zip';
export const NEW = { name: 'GT New Horizons', version: '2.7.5', mc: '1.7.10', loader: 'forge' };

/** A hub on a world with 2.7.6 (a Forge jar at its root) behind a URL too, recording the library's add events. */
export async function libraryHub(t: TestContext, setup: Setup = {}, w = world(t)) {
  w.urls[URL_FORGE] = w.zip('GTNH_2.7.6.zip', { ...PACK_NEW, 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar': 'forge' });
  const s = await start(t, w, setup);
  const adds: LibraryAdd[] = [];
  s.handle.live.on('event', (_, e) => {
    if ('target' in e && e.type === 'libraryAdd') adds.push(e);
  });
  const lib = () => s.json<LibraryState>(s.req('GET', '/api/library'));
  const add = (body: object) => s.json<{ add: number }>(s.req('POST', '/api/library/packs', body), 202);
  /** Waits for the nth add to finish; returns how. */
  const finished = async (n = 1) => {
    await until(() => adds.filter((e) => e.phase === 'finished').length >= n);
    const e = adds.filter((e) => e.phase === 'finished')[n - 1]!;
    return e.phase === 'finished' ? [e.outcome, e.reason] : [];
  };
  const files = () => readdirSync(join(w.root, 'data', 'library')).sort();
  return { w, s, adds, lib, add, finished, files };
}

export const ARCH = process.arch === 'arm64' ? 'aarch64' : 'x64';
export const ADOPTIUM = (feature: number) => `https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?architecture=${ARCH}&image_type=jdk&os=linux&vendor=eclipse`;
export const JDK = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.8%2B9/OpenJDK21U-jdk_hotspot_21.0.8_9.tar.gz';

/** A library hub whose fake Adoptium offers Temurin 21.0.8+9: a tiny tarball whose bin/java prints a version (or fails). */
export async function runtimeHub(t: TestContext, { javaFails = false, checksum, setup, w }: { javaFails?: boolean; checksum?: string; setup?: Setup; w?: World } = {}) {
  const h = await libraryHub(t, setup, w);
  const src = join(h.w.root, 'jdk-src');
  write(join(src, 'jdk-21.0.8+9'), { 'bin/java': javaFails ? '#!/bin/sh\necho "Exec format error" >&2\nexit 126\n' : '#!/bin/sh\necho \'openjdk version "21.0.8"\' >&2\n', release: 'JAVA_VERSION="21.0.8"' });
  execFileSync('chmod', ['+x', join(src, 'jdk-21.0.8+9', 'bin', 'java')]);
  const tarball = join(h.w.zips, 'jdk.tar.gz');
  execFileSync('tar', ['-czf', tarball, '-C', src, 'jdk-21.0.8+9']);
  const answer = join(h.w.zips, 'adoptium-21.json');
  writeFileSync(answer, JSON.stringify([{ release_name: 'jdk-21.0.8+9', binary: { package: { link: JDK, checksum: checksum ?? sha(tarball), size: statSync(tarball).size } } }]));
  h.w.urls[ADOPTIUM(21)] = answer;
  h.w.urls[JDK] = tarball;
  const addRuntime = (feature = 21) => h.s.json<{ add: number }>(h.s.req('POST', '/api/library/runtimes', { feature }), 202);
  const data = join(h.w.root, 'data');
  return { ...h, tarball, data, addRuntime };
}

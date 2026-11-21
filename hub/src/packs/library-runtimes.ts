// The library's Java runtimes, for `Library`: `startRuntime` (`addRuntime({ feature })`: 8, 17, 21 or 25; sharing the
// one add slot, Cancel and events, `id` `runtimes`) asks Adoptium (`api.adoptium.net/v3/assets/latest/<feature>/hotspot`,
// `os` `linux` or `alpine-linux` on musl, `process.arch` mapped to `x64`/`aarch64`), names it `temurin-<release>`
// (checked against `RUNTIME`), answers "already installed" for a known name before downloading, downloads the tarball
// into `work/runtime-<random>/` (cleared at start), checks Adoptium's sha256, unpacks it with the system `tar`, runs
// `bin/java -version` (30 s) and only then moves it to `runtimes/<name>/` (`runtimes` table: name, feature, the
// tarball's size and sha256, by, at); `deleteRuntime` (404 unknown, 409 naming the servers whose `<root>/java/*` link
// points at it); `runtime(name)`; `linkedTo`, each one's linked servers for `state().runtimes`. Hub core.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readlinkSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RuntimeRow } from '../stats/db.ts';
import { formatBytes } from '../units.ts';
import { type Add, cancelled, finish, LibraryRefused, type LibraryCtx, progress, TICK_MS } from './library-ctx.ts';
import { download, request } from './library-download.ts';
import { sha256File } from './packs.ts';

const ADOPTIUM = 'https://api.adoptium.net/v3/assets/latest';
/** The Java versions Add runtime offers. */
export const FEATURES = [8, 17, 21, 25];
/** A runtime's name, from Adoptium's build name: safe as a folder name. */
export const RUNTIME = /^temurin-[0-9][0-9A-Za-z.+_-]*$/;
/** Adoptium's names for the architectures Node reports. */
const ARCH: Record<string, string> = { x64: 'x64', arm64: 'aarch64' };
const JAVA_CHECK_MS = 30_000;

/** Runs a program (no shell); rejects with its error output. */
const run = (file: string, args: string[], signal: AbortSignal, timeout = 0) =>
  new Promise<void>((done, fail) =>
    execFile(file, args, { signal, timeout }, (err, _out, stderr) => (err ? fail(new Error(stderr.trim().split('\n').at(-1) || err.message)) : done())),
  );

/** A runtime, or undefined. */
export function runtime(c: LibraryCtx, name: string): RuntimeRow | undefined {
  return c.d.db.runtimes().find((r) => r.name === name);
}

/** Starts adding the latest GA Temurin JDK of a Java version for this host; returns its add number at once. */
export function startRuntime(c: LibraryCtx, body: unknown, by: string, byName: string): number {
  const feature = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}).feature;
  if (typeof feature !== 'number' || !FEATURES.includes(feature)) throw new LibraryRefused(400, `Pick a Java version: ${FEATURES.join(', ')}.`);
  const arch = ARCH[c.d.arch ?? process.arch];
  if (!arch) throw new LibraryRefused(400, `Temurin has no build for this host's architecture (${c.d.arch ?? process.arch}).`);
  if (c.add) throw new LibraryRefused(409, `${c.add.name} ${c.add.version} is being added: one add at a time.`);
  if (c.d.installRunning()) throw new LibraryRefused(409, 'A New server install is running: add once it is done.');
  const add: Add = {
    add: c.next++,
    kind: 'runtime',
    name: 'Temurin',
    version: String(feature),
    by: byName,
    started: Date.now(),
    detail: '',
    actor: by,
    source: 'Adoptium',
    abort: new AbortController(),
    cancelled: false,
    storing: false,
  };
  c.add = add;
  c.d.hub.audit(by, 'library runtime add', 'library', `Temurin ${feature}`);
  void runRuntime(c, add, feature, arch);
  return add.add;
}

/** Deletes a runtime; refused (409, naming them) while a server's Java link points at it. */
export async function deleteRuntime(c: LibraryCtx, name: string, by: string): Promise<void> {
  if (!RUNTIME.test(name) || !runtime(c, name)) throw new LibraryRefused(404, 'No such runtime in the library.');
  const users = linkedTo(c, name);
  if (users.length) throw new LibraryRefused(409, `${name} is what ${users.join(', ')} run${users.length === 1 ? 's' : ''} on.`);
  c.d.db.deleteRuntime(name);
  await rm(join(c.d.root, 'runtimes', name), { recursive: true, force: true });
  c.d.hub.audit(by, 'library runtime delete', 'library', name);
}

/** The servers whose Java link (`<root>/java/<server>`) points at a runtime. */
export function linkedTo(c: LibraryCtx, name: string): string[] {
  const links = join(c.d.root, 'java');
  const runtime = join(c.d.root, 'runtimes', name);
  let ids: string[];
  try {
    ids = readdirSync(links);
  } catch {
    return [];
  }
  return ids.filter((id) => {
    try {
      return resolve(links, readlinkSync(join(links, id))) === runtime;
    } catch {
      return false; // not a link (a swap's leftover)
    }
  }).sort();
}

/**
 * Asks Adoptium for the build, downloads its tarball into `work/runtime-<random>/`, checks its sha256, unpacks it with
 * the system `tar`, runs `bin/java -version` (30 s), and only then moves it to `runtimes/<name>/`.
 */
async function runRuntime(c: LibraryCtx, add: Add, feature: number, arch: string): Promise<void> {
  const work = join(c.d.root, 'work', `runtime-${randomBytes(16).toString('hex')}`);
  const signal = add.abort.signal;
  try {
    await mkdir(join(work, 'jdk'), { recursive: true });
    progress(c, add, 'Asking Adoptium');
    // musl's Node reports no glibc.
    const os = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ? 'linux' : 'alpine-linux';
    const asked = await request(c.d.download, `${ADOPTIUM}/${feature}/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`, {}, undefined, signal);
    if (!asked.ok) throw new Error(`Adoptium answered HTTP ${asked.status}.`);
    const answer = (await asked.json().catch(() => [])) as { release_name?: unknown; binary?: { package?: { link?: unknown; checksum?: unknown } } }[];
    const build = answer[0];
    const pkg = build?.binary?.package;
    if (typeof build?.release_name !== 'string' || typeof pkg?.link !== 'string' || typeof pkg.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(pkg.checksum)) {
      throw new Error(`Adoptium has no Temurin ${feature} JDK for ${os} ${arch}.`);
    }
    const name = `temurin-${build.release_name.replace(/^jdk-?/, '')}`;
    if (!RUNTIME.test(name)) throw new Error(`Adoptium named the build "${build.release_name}": refused.`);
    add.version = name.slice('temurin-'.length);
    if (runtime(c, name)) return await finish(c, add, 'ok', `Temurin ${add.version} is already installed.`, work);
    cancelled(add);
    const tarball = join(work, 'jdk.tar.gz');
    let last = 0;
    progress(c, add, 'Downloading');
    try {
      await download(
        c.d.download,
        pkg.link,
        tarball,
        (bytes, total) => {
          if (Date.now() - last < TICK_MS) return;
          last = Date.now();
          progress(c, add, `Downloading ${formatBytes(bytes)}${total ? ` of ${formatBytes(total)}` : ''}`);
        },
        signal,
      );
    } catch (err) {
      throw add.cancelled ? err : new Error(`Downloading the JDK failed: ${(err as Error).message}`);
    }
    progress(c, add, 'Checking the download');
    const sha256 = await sha256File(tarball);
    if (sha256 !== pkg.checksum) throw new Error("The download's sha256 doesn't match Adoptium's: not installed.");
    progress(c, add, 'Unpacking');
    await run('tar', ['-xzf', tarball, '-C', join(work, 'jdk'), '--no-same-owner'], signal);
    const top = await readdir(join(work, 'jdk'));
    const home = top.length === 1 ? join(work, 'jdk', top[0]!) : join(work, 'jdk');
    progress(c, add, 'Running java -version');
    await run(join(home, 'bin', 'java'), ['-version'], signal, JAVA_CHECK_MS).catch((err: Error) => {
      throw new Error(`java -version failed on this host, so it isn't installed: ${err.message}`);
    });
    cancelled(add);
    add.storing = true;
    progress(c, add, 'Storing');
    await mkdir(join(c.d.root, 'runtimes'), { recursive: true });
    const size = (await stat(tarball)).size;
    await rename(home, join(c.d.root, 'runtimes', name));
    c.d.db.addRuntime({ name, feature, size, sha256, by: add.by, at: Date.now() });
    await finish(c, add, 'ok', '', work);
  } catch (err) {
    await finish(c, add, add.cancelled ? 'cancelled' : 'failed', add.cancelled ? '' : (err as Error).message, work);
  }
}

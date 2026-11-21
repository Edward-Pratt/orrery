// A pack zip, for `Packs` and the library: `zipEntries` lists its entries with `unzip -Z` (no shell, `execFile`)
// before anything is extracted, refusing (`PackRefused` 400) a symlink, an absolute path or a `..`, and checks the
// count against the zip's own; `contentRoot` is the shallowest folder holding `mods/` or `config/`; `unpack` checks,
// then extracts into a folder made empty first; `sha256File`. A pack's start scripts (`startScripts`): the plain
// `*.sh` files at its content root (`SCRIPT`, what `add-server.sh` accepts), each with whether `LOOP` matches and
// whether it sets `-Xmx`/`-Xms` (`MEMORY_FLAG`). Hub core.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { StartScript } from '../api.ts';
import { PackRefused } from './pack-paths.ts';

/** A start script `add-server.sh` accepts: a plain `.sh` file at the content root. */
export const SCRIPT = /^[A-Za-z0-9._-]+\.sh$/;
/** The Config edit that takes a start script's `while true` loop out, keeping its `java` line. */
export const LOOP = '^while true.*\\n(?:.*\\n)*?(.*\\bjava\\b.*)\\n(?:.*\\n)*?done\\b.*$';
/** The heap flags the memory Config edit sets. */
export const MEMORY_FLAG = /-Xm([sx])\S+/;

/** `unzip` (no shell): resolves with its output. */
const unzip = (args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile('unzip', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(`unzip: ${stderr.trim() || err.message}`)) : resolve(stdout))),
  );

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * The entries of a pack zip, checked before anything is extracted: refused (400) with a symlink, an absolute path or
 * a `..` segment. Read from `unzip -Z`, whose count must match the zip's own, so no entry can slip past.
 */
export async function zipEntries(zip: string): Promise<string[]> {
  const out = await unzip(['-Z', zip]).catch((err: Error) => {
    throw new PackRefused(400, `Not a readable zip: ${err.message}`);
  });
  const count = Number(/number of entries: (\d+)/.exec(out)?.[1]);
  const entries: string[] = [];
  for (const line of out.split('\n')) {
    const m = /^([-a-zA-Z?]{7,12}) +\S+ +\S+ +\d+ +\S+ +\S+ +\S+ +\S+ (.*)$/.exec(line);
    if (!m) continue;
    const [, mode, name] = m as unknown as [string, string, string];
    if (mode.startsWith('l')) throw new PackRefused(400, `The zip has a symlink (${name}): refused.`);
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split(/[/\\]/).includes('..')) {
      throw new PackRefused(400, `The zip has a path outside its folder (${name}): refused.`);
    }
    entries.push(name);
  }
  if (!entries.length || entries.length !== count) throw new PackRefused(400, "Couldn't read the zip's list of files.");
  return entries;
}

/** The content root: the shallowest folder holding `mods/` or `config/` ('' for the zip's top). */
export function contentRoot(entries: string[]): string {
  let best: string[] | undefined;
  for (const e of entries) {
    const parts = e.split('/');
    const i = parts.findIndex((p, n) => (p === 'mods' || p === 'config') && n < parts.length - 1);
    if (i !== -1 && (!best || i < best.length)) best = parts.slice(0, i);
  }
  if (!best) throw new PackRefused(400, 'The zip has no mods/ or config/ folder: is it a server pack?');
  return best.join('/');
}

/** Checks a pack zip, extracts it into `into` (made empty first) and returns its content root's files, relative to `<into>/<root>`. */
export async function unpack(zip: string, into: string): Promise<{ root: string; files: string[] }> {
  const entries = await zipEntries(zip);
  const root = contentRoot(entries);
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  await unzip(['-qq', '-o', zip, '-d', into]);
  const prefix = root ? `${root}/` : '';
  return { root: join(into, root), files: entries.filter((e) => e.startsWith(prefix) && !e.endsWith('/')).map((e) => e.slice(prefix.length)) };
}

/** A pack's start scripts: the plain `*.sh` files at its content root, each with whether it loops (`LOOP` matches) and sets the heap. */
export async function startScripts(zip: string): Promise<StartScript[]> {
  const entries = await zipEntries(zip);
  const root = contentRoot(entries);
  const prefix = root ? `${root}/` : '';
  const scripts: StartScript[] = [];
  for (const e of entries) {
    const name = e.startsWith(prefix) ? e.slice(prefix.length) : '';
    if (!SCRIPT.test(name)) continue;
    const content = await unzip(['-p', zip, e]).catch(() => '');
    scripts.push({ name, loops: new RegExp(LOOP, 'm').test(content), memory: MEMORY_FLAG.test(content) });
  }
  return scripts.sort((a, b) => a.name.localeCompare(b.name));
}

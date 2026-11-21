// The request checks and the server folder's files, for `Packs`: `PackRefused` (400/404/409); a request's path
// (`relPath`: an Extra's target, an edit's file) normalised, refused if absolute or with a `..`, and `inside` the
// folder with symlinks resolved; short texts (`text`, at most 200 characters) and Find regexes (`regex`: JS, `gm`).
// The Kept paths (`keptPaths`: the server's `keep`, then the built-in ones, `builtIn`: the world from `level-name`,
// the server's own files, the backup folder when inside, `.pre-update-*`, `.orrery-update` and the older
// `.orrery-staging`, the Mod's `gtnhdiscord-*.jar` and `orrery-*.jar`; `keptBy`: `*` within one name, a trailing `/`
// a folder), the Mod's jars (`MOD_JAR`, `modJars`) and the folder's files (`walk`). Hub core.

import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import type { ServerSettings } from '../config.ts';

/** Why a pack action wasn't done: 400 (bad input), 404 (no such thing) or 409 (not now). */
export class PackRefused extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** Where Prepare builds the staged set, in the server folder. */
export const UPDATE = '.orrery-update';
/** Its name before the rename: Kept, and deleted by the next update. */
export const LEGACY_STAGING = '.orrery-staging';
export const PRE = '.pre-update-';
/** The Mod's jar, from before the rename and after: put back by every update, never an Extra. The only thing the hub knows about the pack's contents. */
export const MOD_JAR = /^mods\/(gtnhdiscord|orrery)-[^/]*\.jar$/;

const TEXT_MAX = 200;

export async function isFile(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined))?.isFile() ?? false;
}

export async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined;
}

/** Every file (not folder or symlink) under `base`, as posix paths relative to it; none if it doesn't exist. */
export async function walk(base: string, rel = ''): Promise<string[]> {
  const entries = await readdir(join(base, rel), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) files.push(...(await walk(base, p)));
    else if (e.isFile()) files.push(p);
  }
  return files;
}

/** The Mod's jars in a server folder's `mods/`. */
export async function modJars(dir: string): Promise<string[]> {
  return (await readdir(join(dir, 'mods')).catch(() => [])).map((f) => `mods/${f}`).filter((p) => MOD_JAR.test(p));
}

/** Whether `rel` in `dir` resolves (symlinks followed, as far as it exists) inside `dir`. */
export async function inside(dir: string, rel: string): Promise<boolean> {
  const root = await realpath(dir);
  for (let at = join(dir, rel); ; at = dirname(at)) {
    try {
      const real = await realpath(at);
      return real === root || real.startsWith(root + sep);
    } catch {
      if (dirname(at) === at) return false;
    }
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `path` is, or is inside, a Kept path (`*` matches within one name; a trailing `/` marks a folder). */
export const keptBy = (path: string, kept: string[]) =>
  kept.find((k) => new RegExp(`^${k.replace(/\/+$/, '').split('*').map(escapeRe).join('[^/]*')}(/|$)`).test(path));

/** A request's path in the server folder, normalised; refused if empty, absolute or with a `..`. */
export function relPath(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new PackRefused(400, `Give ${what}.`);
  const p = posix.normalize(raw.trim()).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (posix.isAbsolute(raw.trim()) || raw.split(/[/\\]/).includes('..') || raw.includes('\0') || p === '.' || p === '') {
    throw new PackRefused(400, `${what[0]!.toUpperCase()}${what.slice(1)} must be a path inside the server folder, without "..".`);
  }
  return p;
}

export const text = (raw: unknown, what: string, required = false): string => {
  if (raw === undefined && !required) return '';
  if (typeof raw !== 'string' || (required && !raw.trim()) || raw.length > TEXT_MAX) throw new PackRefused(400, `Give ${what} (at most ${TEXT_MAX} characters).`);
  return raw.trim();
};

export function regex(find: unknown): RegExp {
  if (typeof find !== 'string' || !find) throw new PackRefused(400, 'Give a Find regex.');
  try {
    return new RegExp(find, 'gm');
  } catch (err) {
    throw new PackRefused(400, `Find isn't a valid regex: ${(err as Error).message}`);
  }
}

export async function builtIn(s: ServerSettings): Promise<string[]> {
  const props = await readFile(join(s.dir!, 'server.properties'), 'utf8').catch(() => '');
  const world = /^level-name=(.*)$/m.exec(props)?.[1]?.trim() || 'world';
  const backups = s.backupDir ? relative(s.dir!, s.backupDir) : '';
  return [
    `${world}/`,
    'server.properties',
    'ops.json',
    'whitelist.json',
    'banned-players.json',
    'banned-ips.json',
    'usercache.json',
    'eula.txt',
    'server-icon.png',
    'logs/',
    'crash-reports/',
    ...(backups && !backups.startsWith('..') && !isAbsolute(backups) ? [`${backups}/`] : []),
    `${PRE}*/`,
    `${UPDATE}/`,
    `${LEGACY_STAGING}/`,
    'mods/gtnhdiscord-*.jar',
    'mods/orrery-*.jar',
  ];
}

export async function keptPaths(s: ServerSettings): Promise<string[]> {
  return [...(s.keep ?? []), ...(await builtIn(s))];
}

// The mod portal's releases as the catalog checks them, pure: `MOD_NAME`/`validName`, `VERSION`, `GAME_MODS`, `LINE`,
// `compareVersions`, `meets`, `lineOf`, `release` (a portal release checked, its dependencies parsed: `bad` for a
// required one naming no possible mod), `plain` (a portal string as plain text on one line, cut), and `choose` (the
// newest release of a mod for a line that meets every limit and its own on the game's mods, else why not).
// `factorio.ts` re-exports the names other modules import from it. Hub core.

import { LIMITS } from './protocol.ts';

/*
 * The mod portal's releases as the catalog checks them: names, versions and dependencies parsed, and which release
 * of a mod fits a Factorio version. Pure: no reads (those are `FactorioCatalog`'s, in `factorio.ts`).
 */

/**
 * A mod's name as the Agent accepts it, with no `..` and not `.` alone (a URL reads that as "this folder", so
 * `/api/mods/./full` would be `/api/mods/full`): also every name taken from the portal.
 */
export const MOD_NAME = /^[A-Za-z0-9_. -]+$/;
export const validName = (name: string) => name.length <= LIMITS.text && MOD_NAME.test(name) && !name.includes('..') && name !== '.';
/** A Factorio or mod version as the Agent accepts it. */
export const VERSION = /^\d+\.\d+\.\d+$/;
/**
 * The mods that come with Factorio itself: not on the mod portal, at the game's own version, enabled or not by the
 * server's `mod-list.json` (the dashboard's list is the same).
 */
export const GAME_MODS = new Set(['base', 'elevated-rails', 'quality', 'recycler', 'space-age']);

const SHA1 = /^[0-9a-f]{40}$/;
export const LINE = /^\d+\.\d+$/;

export type Op = '<' | '<=' | '=' | '>=' | '>';
/** A release's dependency: `required` (no prefix, or `~`), `optional` (`?`, `(?)`), `incompatible` (`!`). */
export type Dependency = { kind: 'required' | 'optional' | 'incompatible'; name: string; op?: Op; version?: string; text: string };
/** A release from the portal that passed every check: `bad` is a required dependency it names in a way no mod can have. */
export type ModRelease = { version: string; line: string; sha1: string; downloadUrl: string; dependencies: Dependency[]; bad: string | null };
/** A mod on the portal: its releases that passed the checks, newest first. */
export type PortalMod = { name: string; title: string; releases: ModRelease[] };

/** A version as numbers, a missing part as 0 ("2.1" is 2.1.0). */
const parts = (v: string) => [...v.split('.').map(Number), 0, 0].slice(0, 3);
/** Below 0: `a` is older. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
export function meets(version: string, op: Op, limit: string): boolean {
  const c = compareVersions(version, limit);
  return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '=' ? c === 0 : op === '>=' ? c >= 0 : c > 0;
}
/** A Factorio version's line ("2.1.24" → "2.1"), which a release's `factorio_version` names. */
export const lineOf = (factorio: string) => factorio.split('.').slice(0, 2).join('.');

const DEPENDENCY = /^(?:(!|\?|\(\?\)|~)\s*)?(.*?)(?:\s*(<=|>=|<|>|=)\s*(\d{1,5}\.\d{1,5}(?:\.\d{1,5})?))?$/;
/** A dependency as the portal writes it ("? flib >= 0.16"); `bad` when its name isn't one a mod can have. */
function dependency(text: string): Dependency | { kind: Dependency['kind']; bad: true } {
  const m = DEPENDENCY.exec(text.trim())!; // every string matches: the name takes what's left
  const kind = m[1] === '!' ? 'incompatible' : m[1] === '?' || m[1] === '(?)' ? 'optional' : 'required';
  const name = m[2]!.trim();
  if (!validName(name)) return { kind, bad: true };
  return { kind, name, text: text.trim(), ...(m[3] && { op: m[3] as Op, version: m[4]! }) };
}

/** A release from the portal, checked; null when any part of it fails (a bad version, sha1 or link). */
export function release(r: unknown): ModRelease | null {
  if (!r || typeof r !== 'object') return null;
  const { version, sha1, download_url: url, info_json: info } = r as Record<string, unknown>;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  if (typeof sha1 !== 'string' || !SHA1.test(sha1)) return null;
  if (typeof url !== 'string' || !/^\/download\/[^?#\\]+$/.test(url) || url.includes('..')) return null;
  const { factorio_version: line, dependencies: deps = [] } = (info && typeof info === 'object' ? info : {}) as Record<string, unknown>;
  if (typeof line !== 'string' || !LINE.test(line)) return null;
  if (!Array.isArray(deps) || deps.length > LIMITS.mods || !deps.every((d) => typeof d === 'string' && d.length <= LIMITS.text)) return null;
  const dependencies: Dependency[] = [];
  let bad: string | null = null;
  for (const text of deps as string[]) {
    const d = dependency(text);
    if ('bad' in d) {
      if (d.kind === 'required') bad ??= text; // an optional or incompatible one can't name any mod there is
    } else dependencies.push(d);
  }
  return { version, line, sha1, downloadUrl: url, dependencies, bad };
}

/** Control characters, and the bidi overrides, which could turn a portal string around on screen. */
const CONTROL = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu;
/**
 * A portal string as plain text on one line: a line break or other space becomes one space, control characters go,
 * and it is cut to `max` characters (counting `…`, which ends a cut one when `ellipsis`); '' when it isn't a string.
 */
export function plain(value: unknown, max: number, ellipsis = false): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/gu, ' ').replace(CONTROL, '').replace(/ {2,}/g, ' ').trim();
  const chars = [...text];
  if (chars.length <= max) return text;
  return ellipsis ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.slice(0, max).join('').trimEnd();
}

/** The newest release that fits every limit; else why not, as an unresolved dependency's parts. */
export function choose(
  name: string,
  fits: ModRelease[],
  version: string | null,
  limits: { by: string; dep: Dependency }[],
  factorio: string,
  gameMods: Set<string>,
): ModRelease | { reason: string; mod?: string; dependency?: string } {
  const line = lineOf(factorio);
  if (!fits.length) return { reason: `${name} has no release for Factorio ${line}.` };
  const candidates = version === null ? fits : fits.filter((r) => r.version === version);
  if (!candidates.length) return { reason: `${name} ${version} isn't a release for Factorio ${line}.` };
  let why: { reason: string; mod?: string; dependency?: string } | undefined;
  for (const r of candidates) {
    const which = version === null ? `the newest for Factorio ${line} is ${r.version}` : `${r.version} is picked`;
    const game = r.dependencies.find(
      (d) => GAME_MODS.has(d.name) && d.op && (d.kind === 'required' || (d.kind === 'optional' && gameMods.has(d.name))) && !meets(factorio, d.op, d.version!),
    );
    const limit = limits.find((l) => !meets(r.version, l.dep.op!, l.dep.version!));
    if (game) why ??= { mod: name, dependency: game.text, reason: `Factorio ${factorio} is picked (${name}: ${which}).` };
    else if (r.bad !== null) why ??= { mod: name, dependency: r.bad, reason: `Not a name a mod can have (${name}: ${which}).` };
    else if (limit) why ??= { mod: limit.by, dependency: limit.dep.text, reason: `No release of ${name} for Factorio ${line} meets it (${which}).` };
    else return r;
  }
  return why!;
}

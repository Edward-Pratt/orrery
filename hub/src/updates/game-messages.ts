// The messages a game update checks or sends, pure: a game update request's body (`request`, for `catalog` and
// `update`; 400 bad input: a version `^\d+\.\d+\.\d+$`, at most 500 mods by name, each a version or null, none the
// game's own or picked twice), the mod browser's query (`browseQuery`, checked before any portal read, 400 otherwise:
// `factorio` a version, whose line is browsed; `q` at most 100 characters once trimmed; `category` empty or
// `^[a-z0-9-]{1,32}$`; `sort` `downloads` (default), `updated` or `name`; `page` 1 to 1000), the Import mod list's
// check (`checkRequest`, its body checked before any portal read, 400 otherwise: `factorio` a version, whose line is
// checked; `names` at most 500, each passing the Agent's check, none the game's own or given twice), whether an
// `update` line fits `LIMITS.lineBytes` with its newline (`fitsLine`), and the Agent's text redacted (`redact`: every
// URL's query string, any `?key=value`, `token=`, `secure=` and `username=` values). Hub core.

import type { GameModPick, GameUpdateRequest, ModCheckRequest, PortalSort } from '../api.ts';
import { CATEGORY, GAME_MODS, GameRefused, lineOf, validName, VERSION } from './factorio.ts';
import { LIMITS } from '../protocol.ts';

/**
 * Whether an `update` request fits on one line of the Agent port, its newline counted: so it fits however a side
 * counts `LIMITS.lineBytes`. Longer, the Agent's line reader would drop the connection.
 */
export function fitsLine(msg: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(msg)) + 1 <= LIMITS.lineBytes;
}

/**
 * Text from the Agent with every URL's query string, any other `?key=value` and every `token=`, `secure=` and
 * `username=` value taken out, before it is a step's detail, a log line or a notice (the Agent strips them too).
 */
export function redact(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?#"'<>]*)\?[^\s#"'<>]*/gi, '$1')
    .replace(/(\S)\?[\w.~%-]+=[^\s#"'<>]*/g, '$1')
    .replace(/\b(token|secure|username)=[^&\s"'<>]*/gi, '$1=[redacted]');
}

/** A game update request's body, checked: 400 otherwise. */
export function request(body: unknown): GameUpdateRequest {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof b.factorio !== 'string' || !VERSION.test(b.factorio)) throw new GameRefused(400, 'Give a Factorio version, like 2.1.24.');
  if (!Array.isArray(b.mods) || b.mods.length > LIMITS.mods) throw new GameRefused(400, `Give the mods to have (mods, at most ${LIMITS.mods}).`);
  const mods: GameModPick[] = [];
  for (const m of b.mods as unknown[]) {
    const { name, version = null } = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !validName(name)) throw new GameRefused(400, 'Give each mod by its name on the mod portal.');
    if (version !== null && (typeof version !== 'string' || !VERSION.test(version))) {
      throw new GameRefused(400, `${name}: give a version like 1.2.3, or null for the newest that fits.`);
    }
    if (GAME_MODS.has(name)) throw new GameRefused(400, `${name} comes with Factorio: it isn't picked.`);
    if (mods.some((p) => p.name === name)) throw new GameRefused(400, `${name} is picked twice.`);
    mods.push({ name, version });
  }
  return { factorio: b.factorio, mods };
}

/** The Import mod list's check request, its shape checked before any portal read: 400 otherwise. */
export function checkRequest(body: unknown): ModCheckRequest {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof b.factorio !== 'string' || !VERSION.test(b.factorio)) throw new GameRefused(400, 'Give a Factorio version, like 2.1.24.');
  if (!Array.isArray(b.names) || b.names.length > LIMITS.mods) throw new GameRefused(400, `Give the mods to check by name (names, at most ${LIMITS.mods}).`);
  const names: string[] = [];
  for (const name of b.names as unknown[]) {
    if (typeof name !== 'string' || !validName(name)) throw new GameRefused(400, 'Give each mod by its name on the mod portal.');
    if (GAME_MODS.has(name)) throw new GameRefused(400, `${name} comes with Factorio: it isn't on the mod portal.`);
    if (names.includes(name)) throw new GameRefused(400, `${name} is given twice.`);
    names.push(name);
  }
  return { factorio: b.factorio, names };
}

const SORTS: PortalSort[] = ['downloads', 'updated', 'name'];
const QUERY_MAX = 100;
const PAGES = 1000;

/** The mod browser's query, its shape checked before any portal read: 400 otherwise. */
export function browseQuery(query: Record<string, string | undefined>): { line: string; q: string; category: string; sort: PortalSort; page: number } {
  const { factorio, q = '', category = '', sort = 'downloads', page = '1' } = query;
  if (factorio === undefined || !VERSION.test(factorio)) throw new GameRefused(400, 'Give a Factorio version (factorio), like 2.1.24.');
  const text = q.trim();
  if (text.length > QUERY_MAX) throw new GameRefused(400, `Search for at most ${QUERY_MAX} characters.`);
  if (category !== '' && !CATEGORY.test(category)) throw new GameRefused(400, 'Give a category by its id on the mod portal, like mod-packs.');
  if (!(SORTS as string[]).includes(sort)) throw new GameRefused(400, `Sort by ${SORTS.join(', ')}.`);
  const n = /^\d{1,4}$/.test(page) ? Number(page) : 0;
  if (n < 1 || n > PAGES) throw new GameRefused(400, `Give a page from 1 to ${PAGES}.`);
  return { line: lineOf(factorio), q: text, category, sort: sort as PortalSort, page: n };
}

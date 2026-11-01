/**
 * The Import mod list's parsing, in the browser: a client's `mod-list.json` (Factorio's own format,
 * `{"mods":[{"name":"flib","enabled":true,"version"?:"0.16.2"}]}`) or names pasted one per line or comma-separated.
 * Nothing here talks to the hub: the names that pass go to `POST …/game/check`, which checks them again.
 */

/**
 * The mods that come with Factorio itself (the ones setup's `mod-list.json` turns on, `orrery` aside): not on the
 * mod portal, so never picked; a game update brings them with the version. The hub's `GAME_MODS`.
 */
export const GAME_MODS = new Set(['base', 'elevated-rails', 'quality', 'recycler', 'space-age']);
/** The most mods an update may pick: the hub's `LIMITS.mods`. */
export const MODS_MAX = 500;
/** The longest name the hub takes: its `LIMITS.text`. */
const NAME_MAX = 256;
/** The biggest list read: a `mod-list.json` of 500 mods is well under 64 KiB. */
export const LIST_MAX_BYTES = 256 * 1024;
/** A mod's name as the Agent (and the hub) accept it, with no `..` and not `.` alone (a URL's "this folder"). */
const MOD_NAME = /^[A-Za-z0-9_. -]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
export const validName = (name: string) => name.length > 0 && name.length <= NAME_MAX && MOD_NAME.test(name) && !name.includes('..') && name !== '.';

/** A mod from the list, enabled, with the version the file pins (null: none, or not a version like 1.2.3). */
export type ListedMod = { name: string; version: string | null };
/**
 * A list read: its enabled portal mods, in order, each once; and what was left out: names `disabled` in the file, the
 * game's own (`game`, enabled or not there: the server keeps its own setting), the ones that aren't a mod's name
 * (`invalid`, as given) and how many came twice.
 */
export type ModList = { mods: ListedMod[]; disabled: string[]; game: { name: string; enabled: boolean }[]; invalid: string[]; duplicates: number };

/** Why a list can't be read at all: shown in the Import view as is. */
export class ModListError extends Error {}

const KIB = LIST_MAX_BYTES / 1024;

/** A list's text: JSON (`mod-list.json`) when it starts with `{`, else names one per line or comma-separated. */
export function parseModList(text: string): ModList {
  if (new TextEncoder().encode(text).byteLength > LIST_MAX_BYTES) throw new ModListError(`That's over ${KIB} KiB: a mod-list.json is much smaller.`);
  const trimmed = text.trim();
  if (!trimmed) throw new ModListError('Nothing to import: the list is empty.');
  // Names never hold a comma or a line break, but may hold spaces ("Squeak Through"): split on those two only.
  const entries = trimmed.startsWith('{') ? fromJson(trimmed) : trimmed.split(/[\r\n,]+/).map((n) => ({ name: n.trim(), enabled: true, version: null }));
  const list: ModList = { mods: [], disabled: [], game: [], invalid: [], duplicates: 0 };
  const seen = new Set<string>();
  for (const { name, enabled, version } of entries) {
    if (!name) continue;
    if (seen.has(name)) {
      list.duplicates++;
      continue;
    }
    seen.add(name);
    if (!validName(name)) list.invalid.push(name);
    else if (GAME_MODS.has(name)) list.game.push({ name, enabled });
    else if (!enabled) list.disabled.push(name);
    else list.mods.push({ name, version });
  }
  if (list.mods.length > MODS_MAX) throw new ModListError(`That's ${list.mods.length} mods: an update takes at most ${MODS_MAX}.`);
  return list;
}

/** `mod-list.json`'s entries, its shape checked: an object with a `mods` list of `{ name, enabled?, version? }`. */
function fromJson(text: string): { name: string; enabled: boolean; version: string | null }[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ModListError("That isn't a mod-list.json: it isn't JSON.");
  }
  const mods = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>)['mods'] : undefined;
  if (!Array.isArray(mods)) throw new ModListError("That isn't a mod-list.json: it has no \"mods\" list.");
  return mods.map((m: unknown, i) => {
    const { name, enabled = true, version = null } = (m && typeof m === 'object' && !Array.isArray(m) ? m : {}) as Record<string, unknown>;
    if (typeof name !== 'string' || typeof enabled !== 'boolean') throw new ModListError(`That isn't a mod-list.json: mod ${i + 1} has no name, or "enabled" isn't true or false.`);
    return { name: name.trim(), enabled, version: typeof version === 'string' && VERSION.test(version) ? version : null };
  });
}

/** A name that isn't a mod's, safe to show: control characters and bidi overrides as `�`, cut to 64 characters. */
export function shown(name: string): string {
  const chars = [...name.replace(/[\p{Cc}‎‏‪-‮⁦-⁩]/gu, '�')];
  return chars.length > 64 ? `${chars.slice(0, 63).join('')}…` : chars.join('');
}

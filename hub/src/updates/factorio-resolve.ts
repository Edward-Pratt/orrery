// Dependency resolution for `FactorioCatalog.resolve` (`factorio.ts`): `resolveMods(portalMod, factorio, picks,
// gameMods)` (the releases for the version's line only; required dependencies, no prefix or `~`, added transitively at
// the newest release meeting every limit on it: the other mods' required and optional ones, and its own on the game's
// mods against the Factorio version, rounds repeated until the picks settle (`ROUNDS` at most); optional `?`/`(?)` ones
// not added; a `!` one refused while both are in, or the game's mod is enabled; what can't be met is `unresolved`: not
// on the portal, no release for the line, a limit no release meets, a game mod not enabled; a picked mod the portal
// doesn't have rejects, 404). Each mod's page comes through `portalMod`, the catalog's cached `mod(name)`.
// `ResolvedMod`, `Resolution`. Hub core.

import type { CatalogMod, GameModPick, UnresolvedDependency } from '../api.ts';
import { LIMITS } from '../protocol.ts';
import { GameRefused } from './factorio-fetch.ts';
import { choose, GAME_MODS, lineOf, type Dependency, type ModRelease, type PortalMod } from './factorio-releases.ts';

/** Resolving runs again with the limits of its own picks until they settle; this many times at most. */
const ROUNDS = 10;

/** A mod as resolved for an update: what the catalog shows, and what the update needs to fetch it. */
export type ResolvedMod = CatalogMod & { sha1: string; downloadUrl: string };
export type Resolution = { mods: ResolvedMod[]; unresolved: UnresolvedDependency[] };

/**
 * The picked mods for a Factorio version, with every required dependency (no prefix, or `~`) resolved transitively:
 * for each, the newest release for that version's line that meets every limit on it (from the other mods' required
 * and optional dependencies, and their own on the game's mods, against `factorio`). Optional dependencies aren't
 * added; a `!` one is refused while both are there. What it can't meet is in `unresolved`. `gameMods`: the game's
 * own mods enabled on the server. Rejects (404) for a picked mod the portal doesn't have, (502) if it can't be read.
 */
export async function resolveMods(portalMod: (name: string) => Promise<PortalMod | null>, factorio: string, picks: GameModPick[], gameMods: Set<string>): Promise<Resolution> {
  const line = lineOf(factorio);
  let limits = new Map<string, { by: string; dep: Dependency }[]>();
  let last = '';
  let result: Resolution = { mods: [], unresolved: [] };
  for (let round = 0; round < ROUNDS; round++) {
    const chosen = new Map<string, { mod: PortalMod; release: ModRelease; requiredBy: string | null; releases: string[] }>();
    const unresolved: UnresolvedDependency[] = [];
    const seen = new Set<string>();
    let wave = picks.map((p) => ({ name: p.name, version: p.version, by: null as string | null, dep: p.version ? `${p.name} = ${p.version}` : p.name }));
    while (wave.length) {
      wave = wave.filter((i) => !seen.has(i.name) && !!seen.add(i.name));
      await Promise.all(wave.filter((i) => !GAME_MODS.has(i.name)).map((i) => portalMod(i.name)));
      const next: typeof wave = [];
      for (const item of wave) {
        const by = item.by ?? item.name;
        if (GAME_MODS.has(item.name)) {
          if (!gameMods.has(item.name)) unresolved.push({ mod: by, dependency: item.dep, reason: `${item.name} comes with Factorio, but it isn't enabled on this server.` });
          continue;
        }
        if (chosen.size >= LIMITS.mods) {
          unresolved.push({ mod: by, dependency: item.dep, reason: `More than ${LIMITS.mods} mods.` });
          continue;
        }
        const mod = await portalMod(item.name);
        if (!mod) {
          if (item.by === null) throw new GameRefused(404, `The mod portal has no mod ${item.name}.`);
          unresolved.push({ mod: by, dependency: item.dep, reason: 'Not on the mod portal.' });
          continue;
        }
        const fits = mod.releases.filter((r) => r.line === line);
        const pick = choose(mod.name, fits, item.version, limits.get(mod.name) ?? [], factorio, gameMods);
        if ('reason' in pick) {
          unresolved.push({ mod: pick.mod ?? by, dependency: pick.dependency ?? item.dep, reason: pick.reason });
          continue;
        }
        chosen.set(mod.name, { mod, release: pick, requiredBy: item.by, releases: fits.map((r) => r.version) });
        for (const d of pick.dependencies) if (d.kind === 'required') next.push({ name: d.name, version: null, by: mod.name, dep: d.text });
      }
      wave = next;
    }
    // Incompatible mods, either way round, among the chosen ones and the game's enabled ones.
    for (const c of chosen.values()) {
      for (const d of c.release.dependencies) {
        if (d.kind !== 'incompatible') continue;
        if (chosen.has(d.name)) unresolved.push({ mod: c.mod.name, dependency: d.text, reason: `${d.name} is in the update too.` });
        else if (gameMods.has(d.name)) unresolved.push({ mod: c.mod.name, dependency: d.text, reason: `${d.name} comes with Factorio and is enabled on this server.` });
      }
    }
    result = {
      mods: [...chosen.values()].map((c) => ({
        name: c.mod.name,
        title: c.mod.title,
        version: c.release.version,
        releases: c.releases,
        requiredBy: c.requiredBy,
        sha1: c.release.sha1,
        downloadUrl: c.release.downloadUrl,
      })),
      unresolved,
    };
    // The limits these picks put on each other (an optional dependency's too: it binds once both are there).
    const next = new Map<string, { by: string; dep: Dependency }[]>();
    for (const c of chosen.values()) {
      for (const d of c.release.dependencies) {
        if (d.kind === 'incompatible' || !d.op || GAME_MODS.has(d.name)) continue;
        next.set(d.name, [...(next.get(d.name) ?? []), { by: c.mod.name, dep: d }]);
      }
    }
    const key = JSON.stringify([...chosen].map(([n, c]) => [n, c.release.version]).sort());
    if (key === last) return result;
    last = key;
    limits = next;
  }
  return { ...result, unresolved: [...result.unresolved, { mod: '', dependency: '', reason: `The mods' versions don't settle after ${ROUNDS} tries: pick versions by hand.` }] };
}

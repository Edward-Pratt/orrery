// The catalog's reads for `GameUpdates`, through `FactorioCatalog`: `catalog(id, body)` (the releases on offer and
// `resolve`, with the mod diff as `changes`: added, updated, removed by portal mods, a picked one that can't be
// resolved never "removed"), `planUpdate` (that resolve and diff, which an update uses too: the game's own mods stay
// as the Agent's `mod-list.json` has them, so dependencies are resolved, and `to` counted, against those enabled in
// its latest `installed`), `browse(id, query)` (the mod browser) and `thumbnail(id, name)` (null for a name that
// fails the Agent's check), and `check(id, body)` (the Import mod list's), each 404 unless an Agent runs the server;
// their bodies and queries are checked in `game-messages.ts`. Hub core.

import type { GameCatalog, GameUpdateRequest, ModBrowse, ModCheckAnswer } from '../api.ts';
import { GAME_MODS, gameLabel, lineOf, validName, type Resolution } from './factorio.ts';
import { nameOf, type GameCtx, type Installed } from './game-ctx.ts';
import { browseQuery, checkRequest, request } from './game-messages.ts';

export type Plan = Resolution & { changes: string[]; from: string; to: string };

export async function catalog(c: GameCtx, serverId: string, body: unknown): Promise<GameCatalog> {
  nameOf(c, serverId);
  const req = request(body);
  const installed = c.installed.get(serverId) ?? { factorio: req.factorio, mods: [] };
  const [versions, plan] = await Promise.all([c.d.catalog.releases(), planUpdate(c, req, installed)]);
  return { versions, mods: plan.mods.map(({ sha1: _, downloadUrl: __, ...m }) => m), unresolved: plan.unresolved, changes: plan.changes };
}

export async function browse(c: GameCtx, serverId: string, query: Record<string, string | undefined>): Promise<ModBrowse> {
  nameOf(c, serverId);
  const { line, ...rest } = browseQuery(query);
  return c.d.catalog.browse(line, rest);
}

export async function check(c: GameCtx, serverId: string, body: unknown): Promise<ModCheckAnswer> {
  nameOf(c, serverId);
  const req = checkRequest(body);
  const line = lineOf(req.factorio);
  return { line, mods: await c.d.catalog.check(line, req.names) };
}

export async function thumbnail(c: GameCtx, serverId: string, name: string): Promise<Uint8Array<ArrayBuffer> | null> {
  nameOf(c, serverId);
  return validName(name) ? c.d.catalog.thumbnail(name) : null;
}

/**
 * The update's mods and what it changes: the mod diff, by portal mods. The game's own come with its version, each
 * kept enabled or disabled as the Agent's `mod-list.json` has it, so dependencies are resolved against those enabled
 * in the latest `installed` (one new in the target release is enabled too, unseen before the swap: the gate catches
 * a clash with it). From and to count every enabled mod.
 */
export async function planUpdate(c: GameCtx, req: GameUpdateRequest, installed: Installed): Promise<Plan> {
  const gameMods = new Set(installed.mods.filter((m) => GAME_MODS.has(m.name)).map((m) => m.name));
  const resolved = await c.d.catalog.resolve(req.factorio, req.mods, gameMods);
  const was = installed.mods.filter((m) => !GAME_MODS.has(m.name));
  const changes: string[] = [];
  for (const m of resolved.mods) {
    const old = was.find((w) => w.name === m.name);
    if (!old) changes.push(`Added: ${m.name} ${m.version}`);
    else if (old.version !== m.version) changes.push(`Updated: ${m.name} ${old.version} → ${m.version}`);
  }
  const picked = new Set(req.mods.map((p) => p.name)); // one that can't be resolved isn't removed: it is unresolved
  for (const w of was) if (!resolved.mods.some((m) => m.name === w.name) && !picked.has(w.name)) changes.push(`Removed: ${w.name} ${w.version}`);
  return { ...resolved, changes, from: gameLabel(installed.factorio, installed.mods.length), to: gameLabel(req.factorio, gameMods.size + resolved.mods.length) };
}

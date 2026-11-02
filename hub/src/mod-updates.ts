import type { ModUpdate, ModUpdatesState } from './api.ts';
import type { Db } from './db.ts';
import { GAME_MODS, GameRefused, type FactorioCatalog } from './factorio.ts';
import { choose, compareVersions, lineOf, plain, validName } from './factorio-releases.ts';
import type { GameUpdates } from './game-updates.ts';
import type { ServerHub } from './servers.ts';
import type { FactorioMod } from './types.ts';

/** Candidates read one by one from the portal per answer; the rest are `unchecked`. */
const UPDATE_READS = 20;
/** Those reads at once. */
const READS_AT_ONCE = 4;
/** An answer is worked out again when what the server runs changed, or once it is older than this. */
const FRESH_MS = 15 * 60_000;
/** A server's set of updates is posted at most this often. */
const NOTICE_MS = 24 * 60 * 60_000;
/** Updates a notice names; `count` holds them all. */
const NOTICE_MODS = 10;
/** Keys of the set last posted kept per server. */
const KEYS_KEPT = 500;
const TITLE_MAX = 200;

type Installed = { factorio: string; mods: FactorioMod[] };
type Found = Pick<ModUpdatesState, 'updates' | 'later' | 'gone' | 'unchecked'>;

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Runs `fn` on each item, at most `n` at once. */
async function eachAtMost<T>(n: number, items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
}

/**
 * The portal mod updates of what a server runs. Its portal mods (not `GAME_MODS`; a name that fails `validName`
 * is never sent to the portal: `unchecked`) are checked against the line's list (`FactorioCatalog.check`, shared
 * with the mod browser). Each whose newest release for the line is newer than the installed one is a candidate: the
 * first `UPDATE_READS` by name are read (`mod`, cached) and given the newest release whose limits on the game's own
 * mods the installed Factorio meets: newer than the installed one, an update; else `later`. Names the portal has no
 * release of for the line are `gone`. Rejects (502) if the line's list can't be read.
 */
export async function findUpdates(catalog: FactorioCatalog, { factorio, mods }: Installed): Promise<Found> {
  const line = lineOf(factorio);
  const gameMods = new Set(mods.filter((m) => GAME_MODS.has(m.name)).map((m) => m.name));
  const portal = mods.filter((m) => !GAME_MODS.has(m.name));
  const named = portal.filter((m) => validName(m.name));
  const unchecked = portal.filter((m) => !validName(m.name)).map((m) => m.name);
  const gone: string[] = [];
  const candidates: FactorioMod[] = [];
  const checks = await catalog.check(line, named.map((m) => m.name));
  checks.forEach((c, i) => {
    if (c.found === 'missing' || c.found === 'noRelease') gone.push(c.name);
    else if (c.found === 'unchecked') unchecked.push(c.name);
    else if (c.latest !== null && compareVersions(c.latest, named[i]!.version) > 0) candidates.push(named[i]!);
  });
  candidates.sort(byName);
  unchecked.push(...candidates.slice(UPDATE_READS).map((m) => m.name));
  const updates: ModUpdate[] = [];
  const later: ModUpdatesState['later'] = [];
  await eachAtMost(READS_AT_ONCE, candidates.slice(0, UPDATE_READS), async ({ name, version }) => {
    const mod = await catalog.mod(name).catch(() => undefined);
    if (mod === undefined) return void unchecked.push(name);
    const releases = mod?.releases.filter((r) => r.line === line) ?? [];
    if (!mod || !releases.length) return void gone.push(name);
    const title = plain(mod.title, TITLE_MAX) || name;
    const pick = choose(name, releases, null, [], factorio, gameMods);
    if (!('reason' in pick) && compareVersions(pick.version, version) > 0) updates.push({ name, title, from: version, to: pick.version });
    else later.push({ name, title, latest: releases[0]!.version });
  });
  return { updates: updates.sort(byName), later: later.sort(byName), gone: gone.sort(), unchecked: unchecked.sort() };
}

export type ModUpdatesOptions = { firstMs?: number; everyMs?: number; now?: () => number };
export type ModUpdatesDeps = { hub: ServerHub; db: Db; catalog: FactorioCatalog; gameUpdates: GameUpdates; servers: string[] };

/**
 * Portal mod updates of the servers an Agent runs (`has`): `state(id)` for the Game tab, and a check every 6 hours
 * (first 10 minutes after start) that posts a `modUpdates` notice when new updates turn up, at most once a day per
 * server (the set last posted is kept in the database, so a restarted hub doesn't post it again). Hub core.
 */
export class ModUpdates {
  #d: ModUpdatesDeps;
  #o: Required<ModUpdatesOptions>;
  #known = new Map<string, { key: string; at: number; value: ModUpdatesState }>();
  #running = new Map<string, Promise<ModUpdatesState>>();
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: ModUpdatesDeps, o: ModUpdatesOptions = {}) {
    this.#d = deps;
    this.#o = { firstMs: 10 * 60_000, everyMs: 6 * 60 * 60_000, now: () => Date.now(), ...o };
  }

  start(): void {
    const tick = (ms: number) => {
      this.#timer = setTimeout(() => {
        void this.checkAll().finally(() => this.#timer && tick(this.#o.everyMs));
      }, ms);
      this.#timer.unref();
    };
    tick(this.#o.firstMs);
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  has(serverId: string): boolean {
    return this.#d.gameUpdates.has(serverId);
  }

  /**
   * What the server runs, against the portal: kept with what it runs, worked out again when that changed or after 15
   * minutes, one at a time per server. A failed read keeps the last good lists, with `error`.
   */
  state(serverId: string): Promise<ModUpdatesState> {
    const installed = this.#d.gameUpdates.state(serverId).installed;
    if (!installed) return Promise.resolve({ factorio: null, checked: null, updates: [], later: [], gone: [], unchecked: [], error: null });
    const key = JSON.stringify(installed);
    const known = this.#known.get(serverId);
    if (known?.key === key && this.#o.now() - known.at < FRESH_MS) return Promise.resolve(known.value);
    let run = this.#running.get(serverId);
    if (!run) {
      run = this.#work(serverId, installed, key).finally(() => this.#running.delete(serverId));
      this.#running.set(serverId, run);
    }
    return run;
  }

  /** Each server's check and notice; skipped while a game update runs on it, or before its Agent's first report. */
  async checkAll(): Promise<void> {
    for (const id of this.#d.servers) {
      if (!this.has(id) || this.#d.gameUpdates.busy(id)) continue;
      try {
        await this.#notice(id, await this.state(id));
      } catch (err) {
        console.error(`[mod-updates] ${id}: check failed:`, (err as Error).message);
      }
    }
  }

  async #work(serverId: string, installed: Installed, key: string): Promise<ModUpdatesState> {
    const at = this.#o.now();
    let value: ModUpdatesState;
    try {
      value = { factorio: installed.factorio, checked: at, ...(await findUpdates(this.#d.catalog, installed)), error: null };
    } catch (err) {
      const error = err instanceof GameRefused ? err.message : "The mod portal couldn't be read.";
      const last = this.#known.get(serverId)?.value;
      value = last?.checked ? { ...last, error } : { factorio: installed.factorio, checked: null, updates: [], later: [], gone: [], unchecked: [], error };
    }
    this.#known.set(serverId, { key, at, value });
    return value;
  }

  /**
   * Posts when the updates hold a key (`name@to`) the last post didn't, and that post is a day old or more. Sooner,
   * new keys wait for the next check after the day. No updates clear the stored set (keeping its time); a set that
   * only shrank posts nothing.
   */
  async #notice(serverId: string, s: ModUpdatesState): Promise<void> {
    if (s.error !== null || s.checked === null || s.factorio === null) return;
    const keys = s.updates.map((u) => `${u.name}@${u.to}`).slice(0, KEYS_KEPT);
    const last = this.#d.db.modUpdateNotice(serverId);
    if (!keys.length) {
      if (last?.mods.length) this.#d.db.setModUpdateNotice(serverId, [], last.at);
      return;
    }
    const posted = new Set(last?.mods ?? []);
    if (!keys.some((k) => !posted.has(k))) return;
    const now = this.#o.now();
    if (last && now - last.at < NOTICE_MS) return;
    this.#d.db.setModUpdateNotice(serverId, keys, now);
    const mods = s.updates.slice(0, NOTICE_MODS).map(({ name, from, to }) => ({ name, from, to }));
    this.#d.hub.publish(serverId, { severity: 'info', kind: 'modUpdates', factorio: s.factorio, mods, count: s.updates.length });
  }
}

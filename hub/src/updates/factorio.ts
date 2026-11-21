// `FactorioCatalog`, for game updates and the mod browser, through the injected `PortalFetch` (its reads, caps,
// timeouts and redirect rules in `factorio-fetch.ts`; read again after 5 minutes, as the dashboard asks on every
// change, a line's list after 15 and the categories and thumbnail paths after 6 hours (`#cached` takes a time per key,
// one read in flight per key, a failed one not kept)): `releases()` (`factorio.com/api/latest-releases`: each channel's
// headless version, one on both listed once, as stable), `sha256(version)` (`www.factorio.com/download/sha256sums/`:
// the `linux-arm64` headless build's) and `download(version)` (its `get-download` URL: the Agent's Host is ARM64),
// `mod(name)` (`mods.factorio.com/api/mods/<name>/full`; null for a 404; the answer must name the mod asked; only
// releases with a version `^\d+\.\d+\.\d+$`, a sha1, a `/download/…` link without `..` and a `factorio_version` line
// are kept, newest first; a dependency's name is the Agent's check, `^[A-Za-z0-9_. -]+$` without `..` (`validName`,
// which also refuses `.` alone: a URL reads `/api/mods/./full` as `/api/mods/full`), and a required one that fails
// makes its release unusable), `resolve(factorio, picks, gameMods)` (`factorio-resolve.ts`), `link(downloadUrl)`
// (`factorio-link.ts`), `browse(line, { q, category, sort, page })` (the mod browser: the line's list and
// `/api/categories` read in parallel, kept as checked slim rows only, the two most recently browsed lines; the rows'
// checks and the search in `factorio-browse.ts`), `thumbnail(name)` (its path from `mods.factorio.com/api/mods/<name>`,
// the short page, null also for a 404 or a page over its cap; kept 6 hours, at most 10,000 names, cleared when full;
// the image from `https://assets-mod.factorio.com<path>` alone (`THUMBS`, not in `PUBLIC_HOSTS`), following no redirect
// (502), `image/png` with the PNG signature, else 502; the 100 last used kept by their sha1; at most 4 of these reads
// at once; the path's rule and the PNG check in `factorio-thumbs.ts`); `check(line, names)` (the Import mod list's:
// nothing read for no names; each name from that line's list, the mod browser's cache, `fits` with its title and newest
// release, no read per name; a name not in it read with `mod(name)`, the first 20 only (`CHECK_READS`), through the
// thumbnails' 4-at-once slots: `fits` (a deprecated mod with a release for the line), `noRelease` or `missing`; a
// failed read, and every name past the cap, `unchecked`; 502 if the list can't be read); `GAME_MODS` (base,
// elevated-rails, quality, recycler, space-age: the dashboard's too; with the release helpers in
// `factorio-releases.ts`), `gameLabel` ("2.1.24 · 5 mods": every enabled mod, the game's own too); it re-exports
// `GameRefused` (400/404/409/429/502) and the names other modules import from these files. Hub core.

import type { FactorioRelease, GameModPick, ModBrowse, ModCheck, PortalCategory, PortalListing, PortalSort } from '../api.ts';
import { parseCategories, parseList, searchRows, TITLE_MAX } from './factorio-browse.ts';
import { CAPS, GameRefused, OverCap, PORTAL, portalRead, portalText, type PortalFetch } from './factorio-fetch.ts';
import { signedLink, type FactorioAccount } from './factorio-link.ts';
import { compareVersions, LINE, plain, release, validName, VERSION, type ModRelease, type PortalMod } from './factorio-releases.ts';
import { resolveMods, type Resolution } from './factorio-resolve.ts';
import { checkPng, THUMB_IMAGES, THUMB_NAMES, THUMB_PATH, THUMB_READS, THUMBS, thumbPathOf } from './factorio-thumbs.ts';

export { BROWSE_PAGE, CATEGORY } from './factorio-browse.ts';
export { GameRefused, type PortalFetch } from './factorio-fetch.ts';
export type { FactorioAccount } from './factorio-link.ts';
export { compareVersions, GAME_MODS, lineOf, MOD_NAME, validName, VERSION } from './factorio-releases.ts';
export type { Resolution, ResolvedMod } from './factorio-resolve.ts';

/** The Agent's Host: Factorio's ARM64 headless build (setup refuses any other machine). */
const PLATFORM = 'linux-arm64';
const LATEST = 'https://factorio.com/api/latest-releases';
const SUMS = 'https://www.factorio.com/download/sha256sums/';
/** How long an answer of factorio.com or the portal is reused: the dashboard asks the catalog on every change. */
const CACHE_MS = 5 * 60_000;
/** The mod browser's: the portal's list for a line (its `max-age=900`), its categories and a mod's thumbnail path. */
const LIST_MS = 15 * 60_000;
const SLOW_MS = 6 * 60 * 60_000;
/** How many lines' lists are kept at once, the most recently browsed. */
const LINES_KEPT = 2;
/**
 * The Import mod list's check: how many names missing from a line's list are read one by one (`mod(name)`), to tell
 * a mod with no release for the line (or a deprecated one, which the list leaves out) from one the portal hasn't got.
 */
const CHECK_READS = 20;
const SHA256 = /^[0-9a-f]{64}$/;

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/**
 * factorio.com and the mod portal, for game updates: the Factorio releases on offer (`api/latest-releases`), the
 * headless build's sha256 (`download/sha256sums/`), each mod's releases (`/api/mods/<name>/full`) and the dependencies
 * between them, resolved for a Factorio version; and, right before an update, each mod's signed download link, asked
 * with the owner's account. For the mod browser, a line's mods on the portal (`browse`) and their thumbnails
 * (`thumbnail`). Every name and version taken from the portal is checked as the Agent checks it. Hub core.
 */
export class FactorioCatalog {
  #fetch: PortalFetch;
  #account: FactorioAccount | undefined;
  #cache = new Map<string, { at: number; value: Promise<unknown> }>();
  /** The mod browser's lists in the cache (their keys), the most recently browsed last. */
  #lines: string[] = [];
  /** Each mod's thumbnail path (null: none), by name. */
  #thumbPaths = new Map<string, { at: number; value: Promise<unknown> }>();
  /** The thumbnails, by the sha1 in their path, the most recently used last. */
  #images = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  /** The portal reads for thumbnails running now, and those waiting for one to end. */
  #reads = 0;
  #waiting: (() => void)[] = [];

  constructor(fetch: PortalFetch, account?: FactorioAccount) {
    this.#fetch = fetch;
    this.#account = account;
  }

  /** The latest headless release of each channel; one on both is listed once, as stable. */
  async releases(): Promise<FactorioRelease[]> {
    const data = await this.#cached(LATEST, async () => {
      try {
        return JSON.parse(await portalText(this.#fetch, LATEST, CAPS.latest, 'factorio.com')) as unknown;
      } catch (err) {
        throw err instanceof GameRefused ? err : new GameRefused(502, "factorio.com's list of releases isn't JSON.");
      }
    });
    const out: FactorioRelease[] = [];
    for (const channel of ['stable', 'experimental'] as const) {
      const version = (data as Record<string, Record<string, unknown> | undefined> | null)?.[channel]?.headless;
      if (typeof version === 'string' && VERSION.test(version) && !out.some((r) => r.version === version)) out.push({ version, channel });
    }
    return out;
  }

  /** Where the Agent downloads a Factorio release: the headless build for its Host. */
  download(version: string): string {
    return `https://www.factorio.com/get-download/${version}/headless/${PLATFORM}`;
  }

  /** The sha256 factorio.com lists for a release's headless build; undefined if it lists none. */
  async sha256(version: string): Promise<string | undefined> {
    const sums = await this.#cached(SUMS, () => portalText(this.#fetch, SUMS, CAPS.sums, 'factorio.com'));
    const file = `factorio-headless_${PLATFORM}_${version}.tar.xz`;
    for (const line of sums.split('\n')) {
      const [hash, name] = line.trim().split(/\s+\*?/);
      if (name === file && hash && SHA256.test(hash)) return hash;
    }
    return undefined;
  }

  /** A mod's portal page: its releases that pass the checks, newest first; null if the portal has no such mod. */
  async mod(name: string): Promise<PortalMod | null> {
    const url = `${PORTAL}/api/mods/${encodeURIComponent(name)}/full`;
    return this.#cached(url, async () => {
      const text = await portalText(this.#fetch, url, CAPS.mod, 'The mod portal', true);
      if (text === null) return null;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new GameRefused(502, `The mod portal's answer for ${name} isn't JSON.`);
      }
      if (data?.name !== name) throw new GameRefused(502, `The mod portal's answer for ${name} names another mod.`);
      const releases = (Array.isArray(data.releases) ? data.releases : []).map(release).filter((r): r is ModRelease => r !== null);
      releases.sort((a, b) => compareVersions(b.version, a.version));
      const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, TITLE_MAX) : name;
      return { name, title, releases };
    });
  }

  /** The picked mods for a Factorio version, every required dependency resolved transitively (`factorio-resolve.ts`). */
  resolve(factorio: string, picks: GameModPick[], gameMods: Set<string>): Promise<Resolution> {
    return resolveMods((name) => this.mod(name), factorio, picks, gameMods);
  }

  /** A mod release's signed download link, asked with the owner's account (`factorio-link.ts`). */
  link(downloadUrl: string): Promise<string> {
    return signedLink(this.#fetch, this.#account, downloadUrl);
  }

  /**
   * The mod browser: one page (`BROWSE_PAGE`) of the portal's mods for a Factorio line (`2.1`), deprecated ones left
   * out, that match every word of `q` in their name, title or summary (case aside) and are in `category` (an id, or
   * '' for all), sorted (with a query, a mod whose name or title is it comes first); `total` counts every match. The
   * portal's list has no search, so the line's whole list is read (kept `LIST_MS`, slim rows only, the two most
   * recently browsed lines) and searched here. Rejects (400) for a category the portal doesn't list, (502) if the
   * portal can't be read.
   */
  async browse(line: string, { q, category, sort, page }: { q: string; category: string; sort: PortalSort; page: number }): Promise<ModBrowse> {
    if (!LINE.test(line)) throw new GameRefused(400, `${line} isn't a Factorio line, like 2.1.`);
    const [rows, categories] = await Promise.all([this.#list(line), this.#categories()]);
    return searchRows(line, rows, categories, { q, category, sort, page });
  }

  /**
   * The Import mod list's check of names (each already passed `validName`) for a Factorio line, in the order given:
   * from the line's list the mod browser reads (the same cache, no read per name), `fits` with its title and newest
   * release; a name not in it is read one by one (`mod(name)`, cached, sharing the thumbnails' `THUMB_READS` at once),
   * the first `CHECK_READS` only: `fits` (a deprecated mod with a release for the line), `noRelease` or `missing`; a
   * read that fails, and every name past the cap, is `unchecked`. Rejects (502) if the line's list can't be read.
   */
  async check(line: string, names: string[]): Promise<ModCheck[]> {
    if (!LINE.test(line)) throw new GameRefused(400, `${line} isn't a Factorio line, like 2.1.`);
    if (!names.length) return [];
    const listed = new Map((await this.#list(line)).map((m) => [m.name, m]));
    const unlisted = names.filter((n) => !listed.has(n)).slice(0, CHECK_READS);
    const read = new Map(
      await Promise.all(
        unlisted.map(async (name): Promise<[string, ModCheck]> => {
          let mod: PortalMod | null;
          try {
            mod = await this.#slot(() => this.mod(name));
          } catch {
            return [name, { name, found: 'unchecked', title: null, latest: null }];
          }
          if (!mod) return [name, { name, found: 'missing', title: null, latest: null }];
          const newest = mod.releases.find((r) => r.line === line);
          return [name, { name, found: newest ? 'fits' : 'noRelease', title: plain(mod.title, TITLE_MAX) || name, latest: newest?.version ?? null }];
        }),
      ),
    );
    return names.map((name) => {
      const m = listed.get(name);
      if (m) return { name, found: 'fits', title: m.title, latest: m.version };
      return read.get(name) ?? { name, found: 'unchecked', title: null, latest: null };
    });
  }

  /**
   * A mod's thumbnail, a PNG: its path from the mod's short page (`/api/mods/<name>`, kept 6 hours), the image from
   * `assets-mod.factorio.com` alone, following no redirect, `image/png` with the PNG signature (kept by its sha1, the
   * 100 last used). At most `THUMB_READS` of these portal reads at once. Null when the mod has none, or the portal no
   * such mod; rejects (502) if the portal or the image can't be read, or the image isn't a PNG.
   */
  async thumbnail(name: string): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!validName(name)) return null;
    const path = await this.#cached(name, () => this.#slot(() => this.#thumbPath(name)), SLOW_MS, this.#thumbPaths, THUMB_NAMES);
    if (path === null) return null;
    const sha = THUMB_PATH.exec(path)![1]!;
    const hit = this.#images.get(sha);
    if (hit) {
      this.#images.delete(sha);
      this.#images.set(sha, hit);
      return hit;
    }
    const image = this.#slot(() => this.#image(path));
    this.#images.set(sha, image);
    if (this.#images.size > THUMB_IMAGES) this.#images.delete(this.#images.keys().next().value!);
    image.catch(() => this.#images.get(sha) === image && this.#images.delete(sha));
    return image;
  }

  /** A line's every mod on the portal, deprecated ones left out, as checked slim rows. */
  #list(line: string): Promise<PortalListing[]> {
    const url = `${PORTAL}/api/mods?page_size=max&version=${line}&hide_deprecated=true`;
    // Only the most recently browsed lines are kept, so asking for other ones can't grow the hub's memory.
    this.#lines = [...this.#lines.filter((k) => k !== url), url];
    while (this.#lines.length > LINES_KEPT) this.#cache.delete(this.#lines.shift()!);
    return this.#cached(url, async () => parseList(await portalText(this.#fetch, url, CAPS.list, 'The mod portal'), line), LIST_MS);
  }

  /** The portal's categories: each `[id, title, description]` with an id like `mod-packs` and a title; others dropped. */
  #categories(): Promise<PortalCategory[]> {
    const url = `${PORTAL}/api/categories`;
    return this.#cached(url, async () => parseCategories(await portalText(this.#fetch, url, CAPS.latest, 'The mod portal')), SLOW_MS);
  }

  /** A mod's thumbnail path from its short page; null for no thumbnail (no such mod, a page over its cap, another mod's, none or a malformed one). */
  async #thumbPath(name: string): Promise<string | null> {
    let text: string | null;
    try {
      text = await portalText(this.#fetch, `${PORTAL}/api/mods/${encodeURIComponent(name)}`, CAPS.page, 'The mod portal', true);
    } catch (err) {
      if (err instanceof OverCap) return null;
      throw err;
    }
    if (text === null) return null;
    return thumbPathOf(text, name);
  }

  /** A thumbnail from `assets-mod.factorio.com`, by its checked path: no redirect followed, a PNG only. */
  async #image(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const who = "The mod portal's thumbnail";
    const body = (await portalRead(this.#fetch, `${THUMBS}${path}`, CAPS.image, who, { hops: 0, type: 'image/png' }))!;
    return checkPng(body, who);
  }

  /** At most `THUMB_READS` of these at once; the others wait their turn. */
  async #slot<T>(read: () => Promise<T>): Promise<T> {
    while (this.#reads >= THUMB_READS) await new Promise<void>((go) => this.#waiting.push(go));
    this.#reads++;
    try {
      return await read();
    } finally {
      this.#reads--;
      this.#waiting.shift()?.();
    }
  }

  /**
   * A read reused for `ms` (`CACHE_MS` unless said), one at a time per key (a failed one isn't kept), in `store`,
   * which is cleared once it holds `limit` keys.
   */
  #cached<T>(key: string, read: () => Promise<T>, ms = CACHE_MS, store = this.#cache, limit = Infinity): Promise<T> {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.value as Promise<T>;
    if (!hit && store.size >= limit) store.clear();
    const value = read();
    store.set(key, { at: Date.now(), value });
    value.catch(() => store.get(key)?.value === value && store.delete(key));
    return value;
  }
}

/** A Factorio version and how many mods it runs enabled (the game's own too), as an update's history row names them: "2.1.24 · 5 mods". */
export const gameLabel = (factorio: string, mods: number) => `${factorio} · ${plural(mods, 'mod')}`;

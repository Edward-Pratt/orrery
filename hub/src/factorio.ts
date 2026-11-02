import type { CatalogMod, FactorioRelease, GameModPick, ModBrowse, ModCheck, PortalCategory, PortalListing, PortalSort, UnresolvedDependency } from './api.ts';
import { LIMITS } from './protocol.ts';
import { choose, compareVersions, GAME_MODS, LINE, lineOf, plain, release, validName, VERSION, type Dependency, type ModRelease, type PortalMod } from './factorio-releases.ts';

export { compareVersions, GAME_MODS, lineOf, MOD_NAME, validName, VERSION } from './factorio-releases.ts';

/**
 * factorio.com's and the mod portal's requests (`fetch`), all with `redirect: 'manual'`: a public read follows
 * redirects itself, each checked before it is asked (`https:` on `PUBLIC_HOSTS`, 3 at most); a mod's download link
 * follows none, so its credentials never go along, and nor does a thumbnail's read from `assets-mod.factorio.com`.
 */
export type PortalFetch = (url: string, init: { redirect: 'follow' | 'manual'; signal: AbortSignal }) => Promise<Response>;

/** The owner's factorio.com account (`FACTORIO_USERNAME`, `FACTORIO_TOKEN`): only for mod download links. */
export type FactorioAccount = { username: string; token: string };

/** Why a game update action wasn't done: 400 (bad input), 404 (no such thing), 409 (not now) or 502 (factorio.com or the portal failed). */
export class GameRefused extends Error {
  readonly status: 400 | 404 | 409 | 502;
  constructor(status: 400 | 404 | 409 | 502, message: string) {
    super(message);
    this.status = status;
  }
}
/** An answer over its cap (502): a thumbnail's short page over it only means "no thumbnail". */
class OverCap extends GameRefused {}


/** The Agent's Host: Factorio's ARM64 headless build (setup refuses any other machine). */
const PLATFORM = 'linux-arm64';
const LATEST = 'https://factorio.com/api/latest-releases';
const SUMS = 'https://www.factorio.com/download/sha256sums/';
const PORTAL = 'https://mods.factorio.com';
/**
 * Where the portal's thumbnails are: the image read's own one-host pin, never a public read's (`PUBLIC_HOSTS` stays
 * the JSON allowlist), and it follows no redirect.
 */
const THUMBS = 'https://assets-mod.factorio.com';
/** Where the portal's signed download links point (S11). */
const MOD_CDN = 'dl-mod.factorio.com';
const TIMEOUT_MS = 15_000;
/** The only hosts a public read (or its redirect) goes to, over https with no port or user. */
const PUBLIC_HOSTS = new Set(['factorio.com', 'www.factorio.com', 'mods.factorio.com']);
const MAX_HOPS = 3;
/** How long an answer of factorio.com or the portal is reused: the dashboard asks the catalog on every change. */
const CACHE_MS = 5 * 60_000;
/** The mod browser's: the portal's list for a line (its `max-age=900`), its categories and a mod's thumbnail path. */
const LIST_MS = 15 * 60_000;
const SLOW_MS = 6 * 60 * 60_000;
/** `list`: a line's every mod (3.7 MB for 2.1 in 2026); `page`: a mod's short page; `image`: a thumbnail. */
const CAPS = { latest: 64 * 1024, sums: 4 * 1024 * 1024, mod: 4 * 1024 * 1024, list: 16 * 1024 * 1024, page: 512 * 1024, image: 512 * 1024 };
const TITLE_MAX = 200;
const OWNER_MAX = 64;
const SUMMARY_MAX = 500;
const CATEGORY_TITLE_MAX = 64;
/** More rows than this in a line's list: the portal changed shape, so the answer is refused. */
const LIST_ROWS = 50_000;
/** The mod browser's page size: fixed, so nobody asks for 5000 rows. */
export const BROWSE_PAGE = 24;
/** How many lines' lists are kept at once, the most recently browsed. */
const LINES_KEPT = 2;
/** Thumbnails: their paths kept by name (cleared when full), the images by sha1, and the portal reads at once. */
const THUMB_NAMES = 10_000;
const THUMB_IMAGES = 100;
const THUMB_READS = 4;
const THUMB_PATH = /^\/assets\/([0-9a-f]{40})\.thumb\.png$/;
/**
 * The Import mod list's check: how many names missing from a line's list are read one by one (`mod(name)`), to tell
 * a mod with no release for the line (or a deprecated one, which the list leaves out) from one the portal hasn't got.
 */
const CHECK_READS = 20;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A portal category's id, as the browser's `category` takes it. */
export const CATEGORY = /^[a-z0-9-]{1,32}$/;
/** Resolving runs again with the limits of its own picks until they settle; this many times at most. */
const ROUNDS = 10;
const SHA256 = /^[0-9a-f]{64}$/;

/** A mod as resolved for an update: what the catalog shows, and what the update needs to fetch it. */
export type ResolvedMod = CatalogMod & { sha1: string; downloadUrl: string };
export type Resolution = { mods: ResolvedMod[]; unresolved: UnresolvedDependency[] };


const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;


/**
 * A row of the portal's list for a line, checked and made slim; null when it has nothing to add for that line (a
 * bad name, or no newest release for it with a good version). Its category is checked against the categories later.
 */
function listing(row: unknown, line: string): PortalListing | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const name = r.name;
  if (typeof name !== 'string' || !validName(name)) return null;
  const latest = (r.latest_release && typeof r.latest_release === 'object' ? r.latest_release : {}) as Record<string, unknown>;
  const info = (latest.info_json && typeof latest.info_json === 'object' ? latest.info_json : {}) as Record<string, unknown>;
  const version = latest.version;
  if (typeof version !== 'string' || !VERSION.test(version) || info.factorio_version !== line) return null;
  const released = typeof latest.released_at === 'string' ? Date.parse(latest.released_at) : NaN;
  const downloads = r.downloads_count;
  return {
    name,
    title: plain(r.title, TITLE_MAX) || name,
    owner: plain(r.owner, OWNER_MAX),
    summary: plain(r.summary, SUMMARY_MAX, true),
    downloads: typeof downloads === 'number' && Number.isFinite(downloads) && downloads >= 0 ? Math.floor(downloads) : 0,
    version,
    updated: Number.isFinite(released) ? released : null,
    category: typeof r.category === 'string' && CATEGORY.test(r.category) ? r.category : null,
    spaceAge: r.requires_space_age === true,
    page: `${PORTAL}/mod/${encodeURIComponent(name)}`,
  };
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Each sort's order, ties by name: `name` sorts by title as the browser shows it, case aside. */
const SORTS: Record<PortalSort, (a: PortalListing, b: PortalListing) => number> = {
  downloads: (a, b) => b.downloads - a.downloads || order(a.name, b.name),
  updated: (a, b) => (b.updated ?? -1) - (a.updated ?? -1) || order(a.name, b.name),
  name: (a, b) => order(a.title.toLowerCase(), b.title.toLowerCase()) || order(a.name, b.name),
};

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
        return JSON.parse(await this.#text(LATEST, CAPS.latest, 'factorio.com')) as unknown;
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
    const sums = await this.#cached(SUMS, () => this.#text(SUMS, CAPS.sums, 'factorio.com'));
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
      const text = await this.#text(url, CAPS.mod, 'The mod portal', true);
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

  /**
   * The picked mods for a Factorio version, with every required dependency (no prefix, or `~`) resolved transitively:
   * for each, the newest release for that version's line that meets every limit on it (from the other mods' required
   * and optional dependencies, and their own on the game's mods, against `factorio`). Optional dependencies aren't
   * added; a `!` one is refused while both are there. What it can't meet is in `unresolved`. `gameMods`: the game's
   * own mods enabled on the server. Rejects (404) for a picked mod the portal doesn't have, (502) if it can't be read.
   */
  async resolve(factorio: string, picks: GameModPick[], gameMods: Set<string>): Promise<Resolution> {
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
        await Promise.all(wave.filter((i) => !GAME_MODS.has(i.name)).map((i) => this.mod(i.name)));
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
          const mod = await this.mod(item.name);
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

  /**
   * A mod release's signed download link, asked right before an update with the owner's account
   * (`mods.factorio.com<download_url>?username&token`, no redirect followed): only a redirect to
   * `https://dl-mod.factorio.com/…` whose only query key is `secure`, and which holds no credential, is passed on.
   * Rejects (409) without the account, (502) for anything else; its errors never hold the request's URL.
   */
  async link(downloadUrl: string): Promise<string> {
    const account = this.#account;
    if (!account) {
      throw new GameRefused(409, "FACTORIO_USERNAME and FACTORIO_TOKEN aren't set on the hub (/etc/orrery-factorio-account.env), so it can't get the mods' download links.");
    }
    const url = new URL(downloadUrl, PORTAL);
    if (url.origin !== PORTAL || !url.pathname.startsWith('/download/') || url.search) throw new GameRefused(502, 'The mod portal names a download outside it.');
    url.searchParams.set('username', account.username);
    url.searchParams.set('token', account.token);
    let res: Response;
    try {
      res = await this.#fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new GameRefused(502, `The mod portal didn't give a download link: ${failure(err)}.`);
    }
    await res.body?.cancel().catch(() => {});
    if (res.status < 300 || res.status > 399) {
      const hint = res.status === 401 || res.status === 403 ? ': check FACTORIO_USERNAME and FACTORIO_TOKEN' : '';
      throw new GameRefused(502, `The mod portal answered a download link with HTTP ${res.status}${hint}.`);
    }
    let to: URL;
    try {
      to = new URL(res.headers.get('location') ?? '', PORTAL);
    } catch {
      throw new GameRefused(502, "The mod portal's download link isn't a URL.");
    }
    const keys = [...to.searchParams.keys()];
    const signed = to.protocol === 'https:' && to.hostname === MOD_CDN && !to.port && !to.username && !to.password && keys.length === 1 && keys[0] === 'secure';
    const leaks = [account.token, encodeURIComponent(account.token)].some((t) => to.href.includes(t));
    if (!signed || leaks) throw new GameRefused(502, `The mod portal's download link isn't a signed ${MOD_CDN} one, so it isn't passed on.`);
    if (to.href.length > LIMITS.url) throw new GameRefused(502, `The mod portal's download link is over ${LIMITS.url} characters.`);
    return to.href;
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
    const ids = new Set(categories.map((c) => c.id));
    if (category && !ids.has(category)) throw new GameRefused(400, `The mod portal has no category ${category}.`);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const exact = q.trim().toLowerCase();
    const isExact = (m: PortalListing) => !!exact && (m.name.toLowerCase() === exact || m.title.toLowerCase() === exact);
    const found = rows.filter((m) => {
      if (category && m.category !== category) return false;
      if (!words.length) return true;
      const text = `${m.name}\n${m.title}\n${m.summary}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    found.sort((a, b) => Number(isExact(b)) - Number(isExact(a)) || SORTS[sort](a, b));
    const mods = found.slice((page - 1) * BROWSE_PAGE, page * BROWSE_PAGE).map((m) => ({ ...m, category: m.category !== null && ids.has(m.category) ? m.category : null }));
    return { line, total: found.length, mods, categories };
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
    return this.#cached(
      url,
      async () => {
        const rows = (this.#json(await this.#text(url, CAPS.list, 'The mod portal'), "The mod portal's list of mods") as { results?: unknown } | null)?.results;
        if (!Array.isArray(rows)) throw new GameRefused(502, "The mod portal's list of mods has no results.");
        if (rows.length > LIST_ROWS) throw new GameRefused(502, `The mod portal's list of mods has over ${LIST_ROWS} rows.`);
        const seen = new Set<string>();
        const out: PortalListing[] = [];
        for (const row of rows) {
          const m = listing(row, line);
          if (m && !seen.has(m.name)) {
            seen.add(m.name);
            out.push(m);
          }
        }
        return out;
      },
      LIST_MS,
    );
  }

  /** The portal's categories: each `[id, title, description]` with an id like `mod-packs` and a title; others dropped. */
  #categories(): Promise<PortalCategory[]> {
    const url = `${PORTAL}/api/categories`;
    return this.#cached(
      url,
      async () => {
        const data = this.#json(await this.#text(url, CAPS.latest, 'The mod portal'), "The mod portal's categories");
        if (!Array.isArray(data)) throw new GameRefused(502, "The mod portal's categories aren't a list.");
        const out: PortalCategory[] = [];
        for (const c of data.slice(0, 100)) {
          if (!Array.isArray(c)) continue;
          const [id, title] = c as unknown[];
          const text = plain(title, CATEGORY_TITLE_MAX);
          if (typeof id === 'string' && CATEGORY.test(id) && text && !out.some((o) => o.id === id)) out.push({ id, title: text });
        }
        return out;
      },
      SLOW_MS,
    );
  }

  /** A mod's thumbnail path from its short page; null for no thumbnail (no such mod, a page over its cap, another mod's, none or a malformed one). */
  async #thumbPath(name: string): Promise<string | null> {
    let text: string | null;
    try {
      text = await this.#text(`${PORTAL}/api/mods/${encodeURIComponent(name)}`, CAPS.page, 'The mod portal', true);
    } catch (err) {
      if (err instanceof OverCap) return null;
      throw err;
    }
    if (text === null) return null;
    let data: Record<string, unknown> | null;
    try {
      data = JSON.parse(text) as Record<string, unknown> | null;
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object' || data.name !== name || typeof data.thumbnail !== 'string') return null;
    return THUMB_PATH.test(data.thumbnail) ? data.thumbnail : null;
  }

  /** A thumbnail from `assets-mod.factorio.com`, by its checked path: no redirect followed, a PNG only. */
  async #image(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const who = "The mod portal's thumbnail";
    const body = (await this.#read(`${THUMBS}${path}`, CAPS.image, who, { hops: 0, type: 'image/png' }))!;
    if (body.byteLength < PNG.byteLength || !body.subarray(0, PNG.byteLength).equals(PNG)) throw new GameRefused(502, `${who} isn't a PNG.`);
    return body;
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

  /** A public answer's JSON; 502 naming `what` when it isn't. */
  #json(text: string, what: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GameRefused(502, `${what} isn't JSON.`);
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

  /** A public page's text, at most `cap` bytes; null for a 404 when `missing` allows it. */
  async #text(url: string, cap: number, who: string, missing: true): Promise<string | null>;
  async #text(url: string, cap: number, who: string): Promise<string>;
  async #text(url: string, cap: number, who: string, missing = false): Promise<string | null> {
    const body = await this.#read(url, cap, who, { missing });
    return body === null ? null : body.toString('utf8');
  }

  /**
   * A public answer's bytes, at most `cap` (counted as read: `content-length` is only a first check), within
   * `TIMEOUT_MS`; null for a 404 when `missing` allows it. It follows at most `hops` redirects (3 unless said; 0: any
   * redirect is refused), each checked before it is asked: https on `PUBLIC_HOSTS`, no port, no user. `type`: the
   * media type the answer must have.
   */
  async #read(url: string, cap: number, who: string, { missing = false, hops = MAX_HOPS, type }: { missing?: boolean; hops?: number; type?: string } = {}): Promise<Buffer<ArrayBuffer> | null> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    for (let at = url, hop = 0; ; hop++) {
      try {
        res = await this.#fetch(at, { redirect: 'manual', signal });
      } catch (err) {
        throw new GameRefused(502, `${who} can't be read: ${failure(err)}.`);
      }
      if (res.status < 300 || res.status > 399) break;
      // A redirect, followed only once its target is checked: never to http, another host or a port.
      await res.body?.cancel().catch(() => {});
      if (!hops) throw new GameRefused(502, `${who} redirected, which is never followed.`);
      if (hop >= hops) throw new GameRefused(502, `${who} redirected more than ${hops} times.`);
      let next: URL;
      try {
        next = new URL(res.headers.get('location') ?? '', at);
      } catch {
        throw new GameRefused(502, `${who} redirected to something that isn't a URL.`);
      }
      if (next.protocol !== 'https:') throw new GameRefused(502, `${who} redirected away from https.`);
      if (!PUBLIC_HOSTS.has(next.hostname) || next.port || next.username || next.password) {
        throw new GameRefused(502, `${who} redirected away from ${[...PUBLIC_HOSTS].join(', ')}.`);
      }
      at = next.href;
    }
    if (missing && res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new GameRefused(502, `${who} can't be read: HTTP ${res.status}.`);
    }
    if (type !== undefined && (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== type) {
      await res.body?.cancel().catch(() => {});
      throw new GameRefused(502, `${who} isn't ${type}.`);
    }
    if (Number(res.headers.get('content-length') ?? 0) > cap) {
      await res.body?.cancel().catch(() => {});
      throw new OverCap(502, `${who}'s answer is over ${cap} bytes.`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = res.body?.getReader();
      for (;;) {
        const chunk = reader && (await reader.read());
        if (!chunk || chunk.done) break;
        size += chunk.value.byteLength;
        if (size > cap) {
          await reader.cancel().catch(() => {});
          throw new OverCap(502, `${who}'s answer is over ${cap} bytes.`);
        }
        chunks.push(chunk.value);
      }
    } catch (err) {
      if (err instanceof GameRefused) throw err;
      throw new GameRefused(502, `${who} can't be read: ${failure(err)}.`);
    }
    return Buffer.concat(chunks);
  }
}

/** Why a request failed, in words that never hold its URL. */
function failure(err: unknown): string {
  const e = err as { name?: string; cause?: { code?: unknown } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timed out';
  return typeof e?.cause?.code === 'string' ? e.cause.code : 'the request failed';
}

/** A Factorio version and how many mods it runs enabled (the game's own too), as an update's history row names them: "2.1.24 · 5 mods". */
export const gameLabel = (factorio: string, mods: number) => `${factorio} · ${plural(mods, 'mod')}`;

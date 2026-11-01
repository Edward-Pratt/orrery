import type { CatalogMod, FactorioRelease, GameModPick, UnresolvedDependency } from './api.ts';
import { LIMITS } from './protocol.ts';

/**
 * factorio.com's and the mod portal's requests (`fetch`), all with `redirect: 'manual'`: a public read follows
 * redirects itself, each checked before it is asked (`https:` on `PUBLIC_HOSTS`, 3 at most); a mod's download link
 * follows none, so its credentials never go along.
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

/** A mod's name as the Agent accepts it (and no `..`): also every name taken from the portal. */
export const MOD_NAME = /^[A-Za-z0-9_. -]+$/;
export const validName = (name: string) => name.length <= LIMITS.text && MOD_NAME.test(name) && !name.includes('..');
/** A Factorio or mod version as the Agent accepts it. */
export const VERSION = /^\d+\.\d+\.\d+$/;
/**
 * The mods that come with Factorio itself: not on the mod portal, at the game's own version, enabled or not by the
 * server's `mod-list.json` (the dashboard's list is the same).
 */
export const GAME_MODS = new Set(['base', 'elevated-rails', 'quality', 'recycler', 'space-age']);

/** The Agent's Host: Factorio's ARM64 headless build (setup refuses any other machine). */
const PLATFORM = 'linux-arm64';
const LATEST = 'https://factorio.com/api/latest-releases';
const SUMS = 'https://www.factorio.com/download/sha256sums/';
const PORTAL = 'https://mods.factorio.com';
/** Where the portal's signed download links point (S11). */
const MOD_CDN = 'dl-mod.factorio.com';
const TIMEOUT_MS = 15_000;
/** The only hosts a public read (or its redirect) goes to, over https with no port or user. */
const PUBLIC_HOSTS = new Set(['factorio.com', 'www.factorio.com', 'mods.factorio.com']);
const MAX_HOPS = 3;
/** How long an answer of factorio.com or the portal is reused: the dashboard asks the catalog on every change. */
const CACHE_MS = 5 * 60_000;
const CAPS = { latest: 64 * 1024, sums: 4 * 1024 * 1024, mod: 4 * 1024 * 1024 };
const TITLE_MAX = 200;
/** Resolving runs again with the limits of its own picks until they settle; this many times at most. */
const ROUNDS = 10;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LINE = /^\d+\.\d+$/;

type Op = '<' | '<=' | '=' | '>=' | '>';
/** A release's dependency: `required` (no prefix, or `~`), `optional` (`?`, `(?)`), `incompatible` (`!`). */
type Dependency = { kind: 'required' | 'optional' | 'incompatible'; name: string; op?: Op; version?: string; text: string };
/** A release from the portal that passed every check: `bad` is a required dependency it names in a way no mod can have. */
type ModRelease = { version: string; line: string; sha1: string; downloadUrl: string; dependencies: Dependency[]; bad: string | null };
/** A mod on the portal: its releases that passed the checks, newest first. */
type PortalMod = { name: string; title: string; releases: ModRelease[] };

/** A mod as resolved for an update: what the catalog shows, and what the update needs to fetch it. */
export type ResolvedMod = CatalogMod & { sha1: string; downloadUrl: string };
export type Resolution = { mods: ResolvedMod[]; unresolved: UnresolvedDependency[] };

/** A version as numbers, a missing part as 0 ("2.1" is 2.1.0). */
const parts = (v: string) => [...v.split('.').map(Number), 0, 0].slice(0, 3);
/** Below 0: `a` is older. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
function meets(version: string, op: Op, limit: string): boolean {
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
function release(r: unknown): ModRelease | null {
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

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/**
 * factorio.com and the mod portal, for game updates: the Factorio releases on offer (`api/latest-releases`), the
 * headless build's sha256 (`download/sha256sums/`), each mod's releases (`/api/mods/<name>/full`) and the dependencies
 * between them, resolved for a Factorio version; and, right before an update, each mod's signed download link, asked
 * with the owner's account. Every name and version taken from the portal is checked as the Agent checks it. Hub core.
 */
export class FactorioCatalog {
  #fetch: PortalFetch;
  #account: FactorioAccount | undefined;
  #cache = new Map<string, { at: number; value: Promise<unknown> }>();

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
          const pick = this.#choose(mod.name, fits, item.version, limits.get(mod.name) ?? [], factorio, gameMods);
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

  /** The newest release that fits every limit; else why not, as an unresolved dependency's parts. */
  #choose(
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

  /** A read reused for `CACHE_MS` (a failed one isn't kept). */
  #cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
    const value = read();
    this.#cache.set(key, { at: Date.now(), value });
    value.catch(() => this.#cache.get(key)?.value === value && this.#cache.delete(key));
    return value;
  }

  /** A public page's text, at most `cap` bytes; null for a 404 when `missing` allows it. */
  async #text(url: string, cap: number, who: string, missing: true): Promise<string | null>;
  async #text(url: string, cap: number, who: string): Promise<string>;
  async #text(url: string, cap: number, who: string, missing = false): Promise<string | null> {
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
      if (hop >= MAX_HOPS) throw new GameRefused(502, `${who} redirected more than ${MAX_HOPS} times.`);
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
    if (Number(res.headers.get('content-length') ?? 0) > cap) {
      await res.body?.cancel().catch(() => {});
      throw new GameRefused(502, `${who}'s answer is over ${cap} bytes.`);
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
          throw new GameRefused(502, `${who}'s answer is over ${cap} bytes.`);
        }
        chunks.push(chunk.value);
      }
    } catch (err) {
      if (err instanceof GameRefused) throw err;
      throw new GameRefused(502, `${who} can't be read: ${failure(err)}.`);
    }
    return Buffer.concat(chunks).toString('utf8');
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

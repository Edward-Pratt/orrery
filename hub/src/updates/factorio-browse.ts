// The mod browser's rules for `FactorioCatalog.browse` (`factorio.ts`), pure: the portal's list has no search, so
// `mods.factorio.com/api/mods?page_size=max&version=<line>&hide_deprecated=true` is read whole with `/api/categories`
// (the catalog's reads and cache), and `parseList(text, line)` keeps checked slim rows only: a row is dropped unless
// its name passes the Agent's check and its newest release has a version `^\d+\.\d+\.\d+$` for that line; title (200),
// owner (64) and summary (500, with `…`) plain text on one line, control characters and bidi overrides out; downloads a
// finite number ≥ 0, else 0; a category one the portal lists, else null; `page` the portal URL built from the name;
// over 50,000 rows refused, 502. `parseCategories(text)`: a category id `^[a-z0-9-]{1,32}$` (`CATEGORY`) with a title,
// others dropped. `searchRows(line, rows, categories, query)`: every word of `q` in the name, title or summary, case
// aside, then the category (400 for one the portal doesn't list), sorted by downloads, newest release or title (ties by
// name), a name or title equal to `q` first, a page of `BROWSE_PAGE` (24) with the total. Hub core.

import type { ModBrowse, PortalCategory, PortalListing, PortalSort } from '../api.ts';
import { GameRefused, PORTAL, portalJson } from './factorio-fetch.ts';
import { plain, validName, VERSION } from './factorio-releases.ts';

export const TITLE_MAX = 200;
const OWNER_MAX = 64;
const SUMMARY_MAX = 500;
const CATEGORY_TITLE_MAX = 64;
/** More rows than this in a line's list: the portal changed shape, so the answer is refused. */
const LIST_ROWS = 50_000;
/** The mod browser's page size: fixed, so nobody asks for 5000 rows. */
export const BROWSE_PAGE = 24;
/** A portal category's id, as the browser's `category` takes it. */
export const CATEGORY = /^[a-z0-9-]{1,32}$/;

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

/** A line's list from the portal (its text), as checked slim rows, one per name. */
export function parseList(text: string, line: string): PortalListing[] {
  const rows = (portalJson(text, "The mod portal's list of mods") as { results?: unknown } | null)?.results;
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
}

/** The portal's categories (its text): each `[id, title, description]` with an id like `mod-packs` and a title; others dropped. */
export function parseCategories(text: string): PortalCategory[] {
  const data = portalJson(text, "The mod portal's categories");
  if (!Array.isArray(data)) throw new GameRefused(502, "The mod portal's categories aren't a list.");
  const out: PortalCategory[] = [];
  for (const c of data.slice(0, 100)) {
    if (!Array.isArray(c)) continue;
    const [id, title] = c as unknown[];
    const text = plain(title, CATEGORY_TITLE_MAX);
    if (typeof id === 'string' && CATEGORY.test(id) && text && !out.some((o) => o.id === id)) out.push({ id, title: text });
  }
  return out;
}

/**
 * One page (`BROWSE_PAGE`) of a line's rows that match every word of `q` in their name, title or summary (case aside)
 * and are in `category` (an id, or '' for all), sorted (with a query, a mod whose name or title is it comes first);
 * `total` counts every match. Rejects (400) for a category the portal doesn't list.
 */
export function searchRows(line: string, rows: PortalListing[], categories: PortalCategory[], { q, category, sort, page }: { q: string; category: string; sort: PortalSort; page: number }): ModBrowse {
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

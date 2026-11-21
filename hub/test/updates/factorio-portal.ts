// The catalog tests' fake factorio.com and mod portal, shared by `test/updates/factorio*.test.ts`: `portal(pages, mods)`
// (pages by URL, a mod's by its name, every request recorded), `rel` (a portal release), `row` (a row of a line's
// list), the mod browser's `LIST`, `CATEGORIES`, `CATS` and default query `browse`, `resolved` (a resolution as
// lines), `GAME` (the game's mods enabled) and `ACCOUNT` (a factorio.com account).

import { createHash } from 'node:crypto';
import type { PortalSort } from '../../src/api.ts';
import type { FactorioCatalog, PortalFetch } from '../../src/updates/factorio.ts';

export const MODS = 'https://mods.factorio.com/api/mods/';
export const ACCOUNT = { username: 'owner', token: 'secret-token-0123456789' };
export const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** A portal release: `factorio` its line, `deps` its `info_json.dependencies`. */
export const rel = (name: string, version: string, factorio = '2.1', deps: string[] = ['base >= 2.0.0'], extra: object = {}) => ({
  version,
  sha1: sha1(`${name}@${version}`),
  download_url: `/download/${name}/${sha1(name).slice(0, 24)}`,
  file_name: `${name}_${version}.zip`,
  released_at: '2026-10-01T00:00:00.000Z',
  info_json: { factorio_version: factorio, dependencies: deps },
  ...extra,
});

export type Page = { status?: number; body?: unknown; headers?: Record<string, string>; url?: string };

/** A fake factorio.com and mod portal: `pages` by URL (a mod's by its name), every request recorded. */
export function portal(pages: Record<string, Page>, mods: Record<string, { title?: string; releases: unknown[] }> = {}) {
  const asked: { url: string; redirect: string }[] = [];
  const fetch: PortalFetch = async (url, init) => {
    asked.push({ url, redirect: init.redirect });
    const name = url.startsWith(MODS) ? decodeURIComponent(url.slice(MODS.length).replace(/\/full$/, '')) : undefined;
    const page: Page | undefined = name !== undefined && mods[name] ? { body: { name, title: mods[name].title ?? name, releases: mods[name].releases } } : pages[url];
    if (!page) return new Response('not found', { status: 404 });
    const body = typeof page.body === 'string' || page.body === undefined ? page.body : JSON.stringify(page.body);
    const res = new Response(body ?? null, { status: page.status ?? 200, headers: page.headers });
    if (page.url) Object.defineProperty(res, 'url', { value: page.url });
    return res;
  };
  return { fetch, asked };
}

export const resolved = (r: Awaited<ReturnType<FactorioCatalog['resolve']>>) => r.mods.map((m) => `${m.name} ${m.version}${m.requiredBy ? ` < ${m.requiredBy}` : ''}`);
export const GAME = new Set(['base', 'space-age', 'quality', 'elevated-rails']);

// The mod browser.
export const LIST = (line = '2.1') => `https://mods.factorio.com/api/mods?page_size=max&version=${line}&hide_deprecated=true`;
export const CATEGORIES = 'https://mods.factorio.com/api/categories';
export const CATS = [
  ['content', 'Content', 'Mods introducing new content into the game.'],
  ['tweaks', 'Tweaks', 'Small changes.'],
  ['mod-packs', 'Mod packs', 'Collections of mods.'],
];
/** A row of the portal's list for a line: its newest release for that line. */
export const row = (name: string, extra: Record<string, unknown> = {}, release: Record<string, unknown> = {}) => ({
  name,
  title: name,
  owner: 'someone',
  summary: `About ${name}`,
  downloads_count: 10,
  category: 'content',
  score: 1,
  latest_release: { version: '1.0.0', released_at: '2026-10-01T00:00:00.000Z', sha1: sha1(name), info_json: { factorio_version: '2.1' }, ...release },
  ...extra,
});
export const browse: { q: string; category: string; sort: PortalSort; page: number } = { q: '', category: '', sort: 'downloads', page: 1 };

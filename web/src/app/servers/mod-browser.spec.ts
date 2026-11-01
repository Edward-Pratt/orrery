import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ModBrowse, PortalListing } from '@hub/api';
import { type BrowseStatus, ModBrowser, SEARCH_WAIT_MS } from './mod-browser';

const BASE = '/api/servers/space/game';
const listing = (name: string, more: Partial<PortalListing> = {}): PortalListing => ({
  name,
  title: name.toUpperCase(),
  owner: 'someone',
  summary: `What ${name} does.`,
  downloads: 1000,
  version: '1.0.0',
  updated: Date.UTC(2026, 9, 1),
  category: 'content',
  spaceAge: false,
  page: `https://mods.factorio.com/mod/${encodeURIComponent(name)}`,
  ...more,
});
const CATEGORIES = [
  { id: 'content', title: 'Content' },
  { id: 'mod-packs', title: 'Mod packs' },
];
const browse = (mods: PortalListing[], total = mods.length): ModBrowse => ({ line: '2.1', total, mods, categories: CATEGORIES });
const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => listing(`mod-${from + i}`));
const STATUS: BrowseStatus = { checking: false, changes: 0, unresolved: 0, error: false };

type Inputs = { factorio: string; picks: string[]; installed: string[]; required: Map<string, string>; status: BrowseStatus };

/** The browser on its own, as the update sheet shows it; its first read is left unanswered. */
async function setup(more: Partial<Inputs> = {}) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(ModBrowser);
  const inputs: Inputs = { factorio: '2.1.24', picks: ['orrery'], installed: ['base', 'orrery'], required: new Map(), status: STATUS, ...more };
  fixture.componentRef.setInput('base', BASE);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  const added: string[] = [];
  let backs = 0;
  fixture.componentInstance.add.subscribe((name) => added.push(name));
  fixture.componentInstance.back.subscribe(() => backs++);
  document.body.appendChild(fixture.nativeElement);
  const render = async (ms = 10) => (await new Promise((r) => setTimeout(r, ms)), fixture.detectChanges(), await fixture.whenStable());
  await render();
  const backend = TestBed.inject(HttpTestingController);
  const el = fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const all = (sel: string) => [...el.querySelectorAll<HTMLElement>(sel)];
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  const reads = () => backend.match((r) => r.url === `${BASE}/mods`);
  /** The one read in flight, its query as a string. */
  const read = () => {
    const [req, ...rest] = reads();
    expect(rest).toEqual([]);
    expect(req).toBeDefined();
    return { req: req!, query: req!.request.params.toString() };
  };
  const answer = async (req: TestRequest, body: ModBrowse) => (req.flush(body), await render());
  const set = async (sel: string, value: string, event: 'input' | 'change') => {
    const e = q<HTMLInputElement | HTMLSelectElement>(sel);
    e.value = value;
    e.dispatchEvent(new Event(event));
    await render();
  };
  const row = (name: string) => q(`[data-listing="${name}"]`);
  return { fixture, backend, el, q, all, text, render, reads, read, answer, set, row, added, backs: () => backs };
}

afterEach(() => document.body.replaceChildren());

describe('mod browser', () => {
  it('focuses the search box, shows skeletons, and asks page 1 of the picked version, most downloaded first', async () => {
    const { q, read, el } = await setup();
    expect(document.activeElement).toBe(q('[data-browse-search]'));
    expect(read().query).toBe('factorio=2.1.24&sort=downloads&page=1');
    expect(q('[data-browse-skeleton]')).not.toBeNull();
    expect(el.textContent).toContain('Mods for Factorio 2.1, deprecated ones hidden.');
  });

  it('shows each mod as text: title, owner, a compact download count, its version, badges and the portal link', async () => {
    const { read, answer, row, text, q, all } = await setup();
    const pack = listing('se-pack', { title: '<b>x</b>', owner: 'Earendel', downloads: 1_234_567, version: '0.7.3', category: 'mod-packs', spaceAge: true });
    await answer(read().req, browse([pack, listing('flib', { owner: '', summary: '' })], 312));
    expect(q('[data-browse-skeleton]')).toBeNull();
    const r = row('se-pack');
    expect(r.querySelector('[data-title]')!.textContent).toBe('<b>x</b>');
    expect(r.querySelector('b')).toBeNull();
    const compact = new Intl.NumberFormat(undefined, { notation: 'compact' }).format(1_234_567);
    expect(text(r.querySelector('[data-meta]'))).toBe(`by Earendel · ${compact} downloads · 0.7.3`);
    expect(r.querySelector('[data-meta] span')!.getAttribute('title')).toBe(`${new Intl.NumberFormat().format(1_234_567)} downloads`);
    expect(text(r.querySelector('[data-summary]'))).toBe('What se-pack does.');
    expect([...r.querySelectorAll('[data-badge]')].map(text)).toEqual(['Mod pack', 'Space Age']);
    const link = r.querySelector<HTMLAnchorElement>('[data-portal]')!;
    expect(link.href).toBe('https://mods.factorio.com/mod/se-pack');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.getAttribute('aria-label')).toBe('<b>x</b> on the mod portal');
    const img = r.querySelector<HTMLImageElement>('[data-thumb]')!;
    expect(img.getAttribute('src')).toBe(`${BASE}/mods/se-pack/thumbnail`);
    expect(img.alt).toBe('');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(text(row('flib').querySelector('[data-meta]'))).toMatch(/^\S+ downloads · 1\.0\.0$/);
    expect(row('flib').querySelector('[data-summary]')).toBeNull();
    expect(row('flib').querySelector('[data-badge]')).toBeNull();
    expect(text(q('[data-browse-count]'))).toBe('Showing 2 of 312');
    expect(q('[data-browse-count]').getAttribute('aria-live')).toBe('polite');
    expect(all('[data-browse-category] option').map(text)).toEqual(['All categories', 'Content', 'Mod packs']);
  });

  it('shows a placeholder when a thumbnail fails', async () => {
    const { read, answer, row, render } = await setup();
    await answer(read().req, browse([listing('flib')]));
    row('flib').querySelector('[data-thumb]')!.dispatchEvent(new Event('error'));
    await render();
    expect(row('flib').querySelector('[data-thumb]')).toBeNull();
    expect(row('flib').querySelector('[data-no-thumb]')).not.toBeNull();
  });

  it('asks once typing stops, drops an older answer, and asks page 1 again on a category or sort change', async () => {
    const { read, reads, answer, set, render, text, q } = await setup();
    await answer(read().req, browse(page(1, 24), 100));
    await set('[data-browse-search]', 'sq', 'input');
    await set('[data-browse-search]', 'squeak', 'input');
    expect(reads()).toEqual([]); // still typing
    await render(SEARCH_WAIT_MS);
    const first = read();
    expect(first.query).toBe('factorio=2.1.24&q=squeak&sort=downloads&page=1');
    // A category change while that read runs: the older read is cancelled, never shown.
    await set('[data-browse-category]', 'mod-packs', 'change');
    expect(first.req.cancelled).toBe(true);
    const second = read();
    expect(second.query).toBe('factorio=2.1.24&q=squeak&category=mod-packs&sort=downloads&page=1');
    await answer(second.req, browse([listing('squeak-pack')]));
    expect(text(q('[data-browse-count]'))).toBe('Showing 1 of 1');
    await set('[data-browse-sort]', 'updated', 'change');
    expect(read().query).toBe('factorio=2.1.24&q=squeak&category=mod-packs&sort=updated&page=1');
  });

  it("says in words what each mod is to the update, and Add hands its name to the sheet", async () => {
    const { read, answer, row, text, added } = await setup({
      picks: ['orrery', 'squeak-through-2'],
      installed: ['base', 'orrery', 'flib', 'RateCalculator'],
      required: new Map([['stdlib', 'squeak-through-2']]),
    });
    await answer(
      read().req,
      browse(['orrery', 'squeak-through-2', 'stdlib', 'RateCalculator', 'bigger-belts', 'base'].map((n) => listing(n))),
    );
    const button = (name: string) => row(name).querySelector<HTMLButtonElement>('[data-add-mod]')!;
    expect(text(button('orrery'))).toBe('Installed');
    expect(button('orrery').disabled).toBe(true);
    expect(text(button('squeak-through-2'))).toBe('Added');
    expect(button('squeak-through-2').disabled).toBe(true);
    expect(text(button('stdlib'))).toBe('Required by squeak-through-2');
    expect(button('stdlib').disabled).toBe(true);
    expect(text(button('RateCalculator'))).toBe('Add back');
    expect(text(button('bigger-belts'))).toBe('Add');
    expect(button('bigger-belts').getAttribute('aria-label')).toBe('Add BIGGER-BELTS');
    expect(row('base')).toBeNull(); // the game's own: never picked
    button('bigger-belts').click();
    button('RateCalculator').click();
    expect(added).toEqual(['bigger-belts', 'RateCalculator']);
  });

  it('counts the changes in the footer, and Review the update goes back', async () => {
    const { fixture, q, text, render, backs } = await setup({ status: { ...STATUS, checking: true, changes: null } });
    expect(text(q('[data-browse-changes]'))).toBe('Checking with the mod portal…');
    fixture.componentRef.setInput('status', { ...STATUS, changes: 10 });
    await render();
    expect(text(q('[data-browse-changes]'))).toBe('10 changes');
    fixture.componentRef.setInput('status', { ...STATUS, changes: 1 });
    await render();
    expect(text(q('[data-browse-changes]'))).toBe('1 change');
    fixture.componentRef.setInput('status', { ...STATUS, changes: 2, unresolved: 1 });
    await render();
    expect(text(q('[data-browse-changes]'))).toBe("A dependency can't be met");
    fixture.componentRef.setInput('status', { ...STATUS, changes: null, error: true });
    await render();
    expect(text(q('[data-browse-changes]'))).toBe('The catalog refused: review the update.');
    q('[data-browse-review]').click();
    expect(backs()).toBe(1);
  });

  it('loads more pages, keeps the rows when one fails, and has no Load more once every row is shown', async () => {
    const { read, answer, q, all, text, render } = await setup();
    await answer(read().req, browse(page(1, 24), 30));
    q('[data-browse-more]').focus();
    q('[data-browse-more]').click();
    await render();
    const more = read();
    expect(more.query).toBe('factorio=2.1.24&sort=downloads&page=2');
    expect(q('[data-browse-more]').getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(q('[data-browse-more]'));
    q('[data-browse-more]').click(); // a second click while it loads asks nothing more
    await render();
    more.req.flush("The mod portal can't be read: timed out.", { status: 502, statusText: 'Bad Gateway' });
    await render();
    expect(all('[data-listing]')).toHaveLength(24);
    expect(text(q('[data-browse-more-error]'))).toBe("The mod portal can't be read: timed out.");
    expect(text(q('[data-browse-more]'))).toBe('Retry');
    q('[data-browse-more]').click();
    await render();
    const again = read();
    expect(again.query).toBe('factorio=2.1.24&sort=downloads&page=2');
    await answer(again.req, browse(page(25, 6), 30));
    expect(all('[data-listing]').map((r) => r.getAttribute('data-listing'))).toEqual(page(1, 30).map((m) => m.name));
    expect(text(q('[data-browse-count]'))).toBe('Showing 30 of 30');
    expect(q('[data-browse-more]')).toBeNull();
    expect(q('[data-browse-more-error]')).toBeNull();
  });

  it('says when nothing matches, and Clear search asks again without the query', async () => {
    const { read, answer, set, render, q, text } = await setup();
    await answer(read().req, browse(page(1, 3)));
    await set('[data-browse-category]', 'content', 'change');
    await answer(read().req, browse(page(1, 2)));
    await set('[data-browse-search]', 'nothing like it', 'input');
    await render(SEARCH_WAIT_MS);
    await answer(read().req, browse([], 0));
    expect(text(q('[data-browse-empty]'))).toBe('No mods for Factorio 2.1 match "nothing like it" in Content.');
    q('[data-browse-clear]').click();
    await render();
    expect(read().query).toBe('factorio=2.1.24&category=content&sort=downloads&page=1');
    expect(q<HTMLInputElement>('[data-browse-search]').value).toBe('');
    expect(document.activeElement).toBe(q('[data-browse-search]'));
  });

  it("shows the hub's error with Retry, and names the hub release a hub without the route needs", async () => {
    const { read, answer, q, text, render } = await setup();
    read().req.flush("The mod portal can't be read: timed out.", { status: 502, statusText: 'Bad Gateway' });
    await render();
    expect(text(q('[data-browse-error] p'))).toBe("The mod portal can't be read: timed out.");
    expect(q('[data-browse-error]').getAttribute('role')).toBe('alert');
    expect(q('[data-browse-skeleton]')).toBeNull();
    q('[data-browse-retry]').click();
    await render();
    read().req.flush('404 Not Found', { status: 404, statusText: 'Not Found' });
    await render();
    expect(text(q('[data-browse-error] p'))).toBe('This hub has no mod browser yet: deploy hub-v2.16.0 or later.');
    q('[data-browse-retry]').click();
    await render();
    await answer(read().req, browse([listing('flib')]));
    expect(q('[data-browse-error]')).toBeNull();
    expect(q('[data-listing="flib"]')).not.toBeNull();
  });
});

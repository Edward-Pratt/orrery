// What `mod-browser.spec.ts` stands on: portal listings and answers to feed the browser, and `setup()`, the browser on
// its own with the helpers its tests read and drive it through.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ModBrowse, PortalListing } from '@hub/api';
import { expect } from 'vitest';
import { type BrowseStatus, ModBrowser } from './mod-browser';

export const BASE = '/api/servers/space/game';
export const listing = (name: string, more: Partial<PortalListing> = {}): PortalListing => ({
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
export const browse = (mods: PortalListing[], total = mods.length): ModBrowse => ({ line: '2.1', total, mods, categories: CATEGORIES });
export const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => listing(`mod-${from + i}`));
export const STATUS: BrowseStatus = { checking: false, changes: 0, unresolved: 0, error: false };

type Inputs = { factorio: string; picks: string[]; installed: string[]; required: Map<string, string>; status: BrowseStatus };

/** The browser on its own, as the update sheet shows it; its first read is left unanswered. */
export async function setup(more: Partial<Inputs> = {}) {
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

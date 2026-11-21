// What the Game tab's specs stand on (`game.spec.ts`, `game-summary.spec.ts`, `game-update-view.spec.ts`,
// `game-sheet.spec.ts`): a factorio server's card and detail, game states, catalog answers, portal mod updates, and
// `setup()`, the server's Game tab opened through the routes with the helpers its tests read and drive it through.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { CatalogMod, GameCatalog, GameState, ModUpdatesState, Notice, PackUpdateRow, ServerCard, ServerDetail, TargetEvent } from '@hub/api';
import { expect } from 'vitest';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, loggedIn, settle, until } from '../testing';
import routes from './routes';

/**
 * The one request `match` picks, once it has been sent: a request the page sends after a debounce or a lazy chunk
 * may not be there yet when its view shows, so `expectOne` right away would fail on a slow machine.
 */
export async function sent(backend: HttpTestingController, match: Parameters<HttpTestingController['match']>[0], step: () => Promise<unknown>) {
  let found: ReturnType<HttpTestingController['match']> = [];
  await until(() => (found = backend.match(match)).length > 0, step);
  expect(found.length).toBe(1);
  return found[0]!;
}

export const CARD: ServerCard = {
  id: 'space',
  name: 'Space',
  game: 'factorio',
  rate: { label: 'UPS', max: 60 },
  online: true,
  hung: false,
  paused: false,
  tps: 60,
  players: ['Alex', 'Sam'],
  uptimeDay: 1,
  restart: null,
  lagging: false,
  service: { id: 'factorio', state: 'active' },
  features: { chat: true, tps: true, quests: false, console: true, update: true },
  packUpdate: null,
};
export const DETAIL = { card: CARD, service: null, top: { day: [], week: [], all: [] }, backups: { configured: false }, pack: false, logs: false } as unknown as ServerDetail;
export const row = (more: Partial<PackUpdateRow>): PackUpdateRow => ({
  id: 1,
  from: '2.1.23 · 2 mods',
  to: '2.1.24 · 3 mods',
  changes: ['Added: flib 0.16.1'],
  by: 'alex',
  started: Date.UTC(2026, 9, 20, 10),
  finished: Date.UTC(2026, 9, 20, 10, 6),
  outcome: 'ok',
  step: 'gate',
  backup: 'orrery-pre-update-2.1.23-20261020T100000Z.zip',
  log: '',
  ...more,
});
export const STATE: GameState = {
  installed: {
    factorio: '2.1.24',
    mods: [
      { name: 'base', version: '2.1.24' },
      { name: 'elevated-rails', version: '2.1.24' },
      { name: 'quality', version: '2.1.24' },
      { name: 'space-age', version: '2.1.24' },
      { name: 'orrery', version: '1.0.0' },
      { name: 'flib', version: '0.16.1' },
      { name: 'RateCalculator', version: '3.3.2' },
    ],
  },
  history: [row({})],
  running: null,
  blocked: null,
};
export const mod = (name: string, releases: string[], more: Partial<CatalogMod> = {}): CatalogMod => ({ name, title: name.toUpperCase(), version: releases[0]!, releases, requiredBy: null, ...more });
/** The catalog for what the server runs now: nothing changes. */
export const SAME: GameCatalog = {
  versions: [
    { version: '2.1.25', channel: 'stable' },
    { version: '2.2.0', channel: 'experimental' },
  ],
  mods: [mod('orrery', ['1.0.1', '1.0.0']), mod('flib', ['0.16.2', '0.16.1']), mod('RateCalculator', ['3.3.3', '3.3.2'])],
  unresolved: [],
  changes: [],
};
export const PICKS = [
  { name: 'orrery', version: '1.0.0' },
  { name: 'flib', version: '0.16.1' },
  { name: 'RateCalculator', version: '3.3.2' },
];

/** Portal mod updates: none, as of 14:02 UTC. */
export const NO_UPDATES: ModUpdatesState = { factorio: '2.1.24', checked: Date.UTC(2026, 10, 1, 14, 2), updates: [], later: [], gone: [], unchecked: [], error: null };

/** Opens the server's Game tab and answers its detail, game state and portal mod updates (404: an older hub). */
export async function setup(state: GameState = STATE, card: ServerCard = CARD, updates: ModUpdatesState | 404 = NO_UPDATES) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [loggedIn(), provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }, { provide: RETRY_MS, useValue: 0 }],
  });
  const harness = await RouterTestingHarness.create();
  const backend = TestBed.inject(HttpTestingController);
  await harness.navigateByUrl('/space/game');
  backend.expectOne('/api/servers/space').flush({ ...DETAIL, card });
  await settle();
  harness.fixture.detectChanges();
  await settle();
  backend.expectOne('/api/servers/space/game').flush(state);
  const el = harness.routeNativeElement as HTMLElement;
  const render = async (ms = 10) => (await new Promise((r) => setTimeout(r, ms)), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  await render();
  for (const r of backend.match('/api/servers/space/game/updates')) {
    if (updates === 404) r.flush('Not Found', { status: 404, statusText: 'Not Found' });
    else r.flush(updates);
  }
  await render();
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => (el.querySelector<T>(sel) ?? document.querySelector<T>(sel))!;
  const all = (sel: string) => [...document.querySelectorAll(sel)];
  const choose = async (sel: string, value: string) => {
    const select = q<HTMLSelectElement>(sel);
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await render();
  };
  /** Answers the catalog request the sheet just made, checking what it asked. */
  const catalog = async (answer: GameCatalog, mods?: { name: string; version: string | null }[], factorio = '2.1.24') => {
    const req = await sent(backend, '/api/servers/space/game/catalog', render);
    expect(req.request.method).toBe('POST');
    if (mods) expect(req.request.body).toEqual({ factorio, mods });
    req.flush(answer);
    await render();
  };
  /** Opens Update game and answers its first catalog request. */
  const open = async (answer: GameCatalog = SAME) => {
    q('[data-update]').click();
    await render();
    await catalog(answer, PICKS);
  };
  const go = () => q<HTMLButtonElement>('[data-update-go]');
  const type = async (sel: string, value: string) => {
    const input = q<HTMLInputElement>(sel);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  /** Answers the reload a change or an event asks for (debounced). */
  const reload = async (next: GameState) => {
    await render(70);
    backend.expectOne('/api/servers/space/game').flush(next);
    await render();
  };
  let n = 1;
  const notice = async (e: Notice) => {
    events.push(n++, { ...e, type: 'notice', serverId: 'space' });
    await render();
  };
  const target = async (e: TargetEvent) => {
    events.push(n++, e);
    await render();
  };
  return { harness, backend, events, el, render, text, q, all, choose, type, catalog, open, go, reload, notice, target };
}

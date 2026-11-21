// What the Pack tab's specs stand on (`pack.spec.ts`, `pack-adopt.spec.ts`, `pack-summary.spec.ts`,
// `pack-extras.spec.ts`, `pack-edits.spec.ts`): a server card and detail, pack states, library entries, and `setup()`,
// the server's Pack tab opened through the routes with the helpers its tests read and drive it through.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { Extra, LibraryPack, LibraryState, Notice, PackState, PackUpdateRow, ServerCard, ServerDetail } from '@hub/api';
import { expect } from 'vitest';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, loggedIn, settle } from '../testing';
import routes from './routes';

export const CARD: ServerCard = {
  id: 'gtnh',
  name: 'GTNH',
  game: 'minecraft',
  rate: { label: 'TPS', max: 20 },
  online: true,
  hung: false,
  paused: false,
  tps: 20,
  players: ['Steve', 'Alex', 'Kestrel'],
  uptimeDay: 1,
  restart: null,
  lagging: false,
  service: { id: 'gtnh', state: 'active' },
  features: { chat: true, tps: true, quests: true, console: true, update: false },
  packUpdate: { running: false, rolledBack: null },
};
export const DETAIL = { card: CARD, service: null, top: { day: [], week: [], all: [] }, backups: { configured: false }, pack: true } as unknown as ServerDetail;
const KEPT = { server: ['config/JourneyMapServer', 'journeymap/'], builtIn: ['World/', 'server.properties', 'logs/'] };
export const EMPTY: PackState = {
  installed: null,
  kept: KEPT,
  extras: [],
  edits: [],
  pending: [],
  history: [],
  running: null,
  mod: 'mods/gtnhdiscord-1.4.0.jar',
  blocked: null,
  rolledBack: null,
  packFiles: [],
  runtime: { name: null, pending: false, unitLines: null },
};
export const extra = (target: string, more: Partial<Extra> = {}): Extra => ({
  id: target.length,
  target,
  sha256: 'a',
  label: '',
  note: '',
  by: 'alex',
  at: Date.UTC(2026, 8, 1),
  removed: false,
  replaces: false,
  change: null,
  ...more,
});
export const row = (more: Partial<PackUpdateRow>): PackUpdateRow => ({
  id: 1,
  from: '2.7.3',
  to: '2.7.4',
  changes: null,
  by: 'alex',
  started: Date.UTC(2026, 8, 20, 10),
  finished: Date.UTC(2026, 8, 20, 10, 9),
  outcome: 'ok',
  step: 'gate',
  backup: '2026-09-20-10-00-00.zip',
  log: '',
  ...more,
});
export const INSTALLED: PackState = {
  ...EMPTY,
  installed: {
    name: 'GT New Horizons',
    version: '2.7.4',
    source: 'https://github.com/GTNewHorizons/pack/releases/download/2.7.4/GT_New_Horizons_2.7.4_Server_Java_17-21.zip',
    sha256: '9f2c1e0123456789abcdef',
    by: 'alex',
    at: Date.UTC(2026, 8, 20),
    how: 'adopted',
  },
  extras: [
    extra('mods/journeymap-fairplay.jar', { label: '5.2.6', note: 'fairplay build' }),
    extra('config/forge.cfg', { replaces: true }),
  ],
  edits: [{ id: 7, path: 'startserver.sh', find: '-Xmx6G', replace: '-Xmx12G', note: 'heap', by: 'alex', at: 0, failedOn: null }],
  history: [row({})],
  packFiles: ['config/forge.cfg', 'mods/gregtech.jar'],
};

const entry = (id: number, version: string, mc = '1.7.10'): LibraryPack => ({
  id,
  name: 'GT New Horizons',
  version,
  mc,
  loader: 'forge',
  sha256: 'a',
  size: 1,
  source: 'x',
  by: 'alex',
  at: 0,
  usedBy: [],
});
const RUNTIME = { name: 'temurin-21.0.8+9', label: 'Temurin 21.0.8+9', feature: 21, size: 1, sha256: 'a', by: 'alex', at: 0, usedBy: [] };
const LIBRARY: LibraryState = { packs: [entry(2, '2.7.5'), entry(1, '2.7.4')], runtimes: [RUNTIME], running: null };

/** Opens the server's Pack tab and answers its detail and pack state. */
export async function setup(state: PackState = INSTALLED, card: ServerCard = CARD) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [loggedIn(), provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }, { provide: RETRY_MS, useValue: 0 }],
  });
  const harness = await RouterTestingHarness.create();
  const backend = TestBed.inject(HttpTestingController);
  await harness.navigateByUrl('/gtnh/pack');
  backend.expectOne('/api/servers/gtnh').flush({ ...DETAIL, card });
  await settle();
  harness.fixture.detectChanges();
  await settle();
  backend.expectOne('/api/servers/gtnh/pack').flush(state);
  const el = harness.routeNativeElement as HTMLElement;
  const render = async (ms = 10) => (await new Promise((r) => setTimeout(r, ms)), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  await render();
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => (el.querySelector<T>(sel) ?? document.querySelector<T>(sel))!;
  const type = async (sel: string, value: string) => {
    const input = q<HTMLInputElement>(sel);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  /** Picks a library version in the Adopt or Update picker. */
  const pick = async (id: number) => {
    const select = q<HTMLSelectElement>('[data-pick]');
    select.value = String(id);
    select.dispatchEvent(new Event('change'));
    await render();
  };
  /** Answers the dashboard's read of the library. */
  const library = async (state = LIBRARY) => {
    const reqs = backend.match('/api/library');
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) r.flush(state);
    await render();
  };
  /** Answers the reload a change or an event asks for (debounced). */
  const reload = async (next: PackState) => {
    await render(70);
    backend.expectOne('/api/servers/gtnh/pack').flush(next);
    await render();
  };
  let n = 1;
  const notice = async (e: Notice) => {
    events.push(n++, { ...e, type: 'notice', serverId: 'gtnh' });
    await render();
  };
  return { harness, backend, events, el, render, text, q, type, pick, library, reload, notice };
}

// What the server page's specs stand on (`server.spec.ts`, `server-chat.spec.ts`, `server-history.spec.ts`,
// `server-console.spec.ts`, `server-players.spec.ts`, `server-backups.spec.ts`, `server-saves.spec.ts`): a Minecraft
// server's card, one without the mod and a factorio one, `detail()`, `setup()`, the page opened through the routes at a
// URL with the helpers its tests read and drive it through, and `debounce()`, the page's refetch waited out.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { By } from '@angular/platform-browser';
import type { ServerCard, ServerDetail, ServiceStatus } from '@hub/api';
import { TimeSeries } from '../chart';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, loggedIn, settle } from '../testing';
import routes from './routes';

export const CARD: ServerCard = {
  lagging: false,
  service: null,
  id: 'gtnh',
  name: 'GTNH',
  game: 'minecraft',
  rate: { label: 'TPS', max: 20 },
  online: true,
  hung: false,
  paused: false,
  tps: 20,
  players: ['Steve'],
  uptimeDay: 1,
  restart: null,
  features: { chat: true, tps: true, quests: true, console: true, update: false },
  packUpdate: null,
};
export const NO_MOD: ServerCard = { ...CARD, id: 'site', name: 'Website', tps: null, players: [], features: { chat: false, tps: false, quests: false, console: false, update: false } };
export const FACTORIO: ServerCard = { ...CARD, id: 'space', name: 'Space Age', game: 'factorio', rate: { label: 'UPS', max: 60 }, tps: 59 };

/** A server's detail, as the hub answers it, with nothing in it but the card. */
export const detail = (card: ServerCard, more: Partial<ServerDetail> = {}) =>
  ({ card, service: null, top: { day: [], week: [], all: [] }, backups: { configured: false }, pack: false, ...more }) as ServerDetail;

/** Opens `url` (e.g. `/gtnh/chat`) straight away, as a reload would, and answers the server's detail. */
export async function setup(url: string, card = CARD, service: ServiceStatus | null = null, more: Partial<ServerDetail> = {}) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [loggedIn(),
      provideRouter(routes),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: FETCH, useValue: events.fetch },
      { provide: RETRY_MS, useValue: 0 },
    ],
  });
  const harness = await RouterTestingHarness.create();
  const backend = TestBed.inject(HttpTestingController);
  await harness.navigateByUrl(url);
  backend.expectOne(`/api/servers/${card.id}`).flush({ ...detail(card), service, ...more });
  const el = harness.routeNativeElement as HTMLElement;
  const render = async () => (await settle(), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  await render();
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  /** Each chat line's text, without its time. */
  const chat = () =>
    [...el.querySelectorAll('[data-chat] li')].map((li) => {
      const line = li.cloneNode(true) as Element;
      line.querySelector('time')?.remove();
      return text(line);
    });
  const tabs = () => [...el.querySelectorAll('[data-sections] a')].map(text);
  /** What the chart titled `title` draws: each series' name and points. */
  const chart = (title: string) =>
    (harness.fixture.debugElement.query(By.css(`[data-chart="${title}"] app-time-series`))?.componentInstance as TimeSeries | undefined)
      ?.series()
      .map((s) => [s.name, s.points]);
  /** The top of the scale of the chart titled `title`. */
  const chartMax = (title: string) =>
    (harness.fixture.debugElement.query(By.css(`[data-chart="${title}"] app-time-series`))?.componentInstance as TimeSeries | undefined)?.max();
  return { backend, events, el, render, chat, tabs, text, chart, chartMax };
}

/** Waits out the server page's debounced refetch. */
export const debounce = () => new Promise((r) => setTimeout(r, 80));

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { By } from '@angular/platform-browser';
import type { ServerCard, ServerDetail, ServerHistory, ServiceStatus } from '@hub/api';
import { TimeSeries } from '../chart';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, settle } from '../testing';
import routes from './routes';

const CARD: ServerCard = {
  id: 'gtnh',
  name: 'GTNH',
  online: true,
  hung: false,
  tps: 20,
  players: ['Steve'],
  uptimeDay: 1,
  restart: null,
  features: { chat: true, tps: true, quests: true },
};
const NO_MOD: ServerCard = { ...CARD, id: 'site', name: 'Website', tps: null, players: [], features: { chat: false, tps: false, quests: false } };

/** Opens `url` (e.g. `/gtnh/chat`) straight away, as a reload would, and answers the server's detail. */
async function setup(url: string, card = CARD, service: ServiceStatus | null = null) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [
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
  backend.expectOne(`/api/servers/${card.id}`).flush({ card, service } as ServerDetail);
  const el = harness.routeNativeElement as HTMLElement;
  const render = async () => (await settle(), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  await render();
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  const chat = () => [...el.querySelectorAll('[data-chat] li')].map(text);
  const tabs = () => [...el.querySelectorAll('[data-sections] a')].map(text);
  /** What the chart titled `title` draws: each series' name and points. */
  const chart = (title: string) =>
    (harness.fixture.debugElement.query(By.css(`[data-chart="${title}"] app-time-series`))?.componentInstance as TimeSeries | undefined)
      ?.series()
      .map((s) => [s.name, s.points]);
  return { backend, events, el, render, chat, tabs, text, chart };
}

describe('server page', () => {
  it('shows an overview, with a Chat section for a server with the mod', async () => {
    const { el, tabs, text } = await setup('/gtnh');
    expect(text(el.querySelector('h1'))).toBe('GTNH Online');
    expect(tabs()).toEqual(['Overview', 'Chat', 'History']);
    expect(text(el.querySelector('[data-players]'))).toBe('Steve');
    expect(el.querySelector('[data-chat]')).toBeNull();
  });

  it('has no Chat section for a server without the mod, even when linked to', async () => {
    const { el, tabs } = await setup('/site/chat', NO_MOD);
    expect(tabs()).toEqual(['Overview', 'History']);
    expect(el.querySelector('[data-chat]')).toBeNull();
    expect(el.querySelector('[data-no-chat]')).not.toBeNull();
  });

  it('explains an unknown server', async () => {
    const events = fakeEvents();
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/nope');
    TestBed.inject(HttpTestingController).expectOne('/api/servers/nope').flush('Not Found', { status: 404, statusText: 'Not Found' });
    harness.fixture.detectChanges();
    expect(harness.routeNativeElement?.textContent).toContain('No such server.');
  });

  it('shows the labelled service actions only when a service is linked', async () => {
    const unlinked = await setup('/gtnh');
    expect(unlinked.el.querySelector('[data-service-actions]')).toBeNull();
    TestBed.resetTestingModule();
    const gtnh: ServiceStatus = { id: 'gtnh', unit: 'gtnh.service', state: 'active', sub: 'running', checks: [] };
    const linked = await setup('/gtnh/chat', CARD, gtnh);
    const section = linked.el.querySelector('[data-service-actions]');
    expect(linked.text(section?.querySelector('h2'))).toBe('Service gtnh.service active (running)');
    expect([...section!.querySelectorAll('[data-action]')].map((b) => b.textContent)).toEqual(['Start', 'Stop', 'Restart']);
    linked.events.push(1, { target: 'service', id: 'gtnh', type: 'state', state: 'inactive', sub: 'dead' });
    await linked.render();
    expect(section?.querySelector('h2')?.textContent).toContain('inactive (dead)');
  });
});

describe('server chat section', () => {
  it('shows recent chat from the replay, then live lines, for this server only', async () => {
    const { events, render, chat } = await setup('/gtnh/chat');
    events.push(1, { serverId: 'gtnh', type: 'join', player: 'Steve' });
    events.push(2, { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' });
    events.push(3, { serverId: 'other', type: 'chat', player: 'Alex', message: 'elsewhere' });
    events.push(4, { serverId: 'gtnh', type: 'tps', tps: 19 });
    await render();
    expect(chat()).toEqual(['Steve joined', 'Steve: hi']);
    events.push(5, { serverId: 'gtnh', type: 'say', author: 'alex', message: 'hello from Discord' });
    events.push(6, { serverId: 'gtnh', type: 'death', player: 'Steve', message: 'Steve fell' });
    await render();
    expect(chat()).toEqual(['Steve joined', 'Steve: hi', 'alex (Discord or dashboard): hello from Discord', 'Steve fell']);
  });

  it('sends a message as JSON, and explains a 409 as the server being offline', async () => {
    const { backend, el, render } = await setup('/gtnh/chat');
    const input = el.querySelector<HTMLInputElement>('[data-chat-form] input')!;
    const form = el.querySelector('[data-chat-form]')!;
    input.value = 'hello';
    form.dispatchEvent(new Event('submit'));
    const req = backend.expectOne('/api/servers/gtnh/chat');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ message: 'hello' });
    expect(req.request.headers.get('content-type') ?? req.request.detectContentTypeHeader()).toBe('application/json');
    req.flush(null, { status: 204, statusText: 'No Content' });
    expect(input.value).toBe('');

    input.value = 'anyone?';
    form.dispatchEvent(new Event('submit'));
    backend.expectOne('/api/servers/gtnh/chat').flush('GTNH is offline', { status: 409, statusText: 'Conflict' });
    await render();
    expect(el.querySelector('[role=alert]')?.textContent).toContain("GTNH is offline: the message wasn't sent.");
  });
});

const HISTORY: ServerHistory = {
  tps: [{ ts: 1, tps: 19.5 }, { ts: 2, tps: 12 }],
  players: [{ ts: 0, count: 0 }, { ts: 1, count: 1 }, { ts: 3, count: 1 }],
  uptime: [{ ts: 0, state: 'unknown' }, { ts: 1, state: 'up' }, { ts: 2, state: 'hung' }],
  asOf: 10,
};

describe('server history section', () => {
  it('graphs TPS, players and uptime for the last 24 hours, then the chosen period', async () => {
    const { backend, el, render, chart, tabs } = await setup('/gtnh/history');
    expect(tabs()).toContain('History');
    backend.expectOne('/api/servers/gtnh/history?hours=24').flush(HISTORY);
    await render();
    expect(chart('TPS')).toEqual([['TPS', [[1, 19.5], [2, 12]]]]);
    expect(chart('Players')).toEqual([['Players', [[0, 0], [1, 1], [3, 1]]]]);
    // Up 1, hung 0.5, down 0, unknown a gap; the last state lasts until now.
    const [[, uptime]] = chart('Uptime')! as [string, [number, number][]][];
    expect(uptime.slice(0, 3)).toEqual([[0, NaN], [1, 1], [2, 0.5]]);
    expect(uptime.at(-1)![1]).toBe(0.5);

    [...el.querySelectorAll<HTMLButtonElement>('[data-period]')].find((b) => b.textContent?.trim() === '7 d')!.click();
    await render();
    backend.expectOne('/api/servers/gtnh/history?hours=168').flush({ ...HISTORY, tps: [] });
    await render();
    expect(chart('TPS')).toEqual([['TPS', []]]);
  });

  it('extends the graphs from live events newer than the history, ignoring the replay it already holds', async () => {
    const { backend, events, render, chart } = await setup('/gtnh/history');
    events.push(9, { serverId: 'gtnh', type: 'join', player: 'Old' }); // counted in the history already
    backend.expectOne('/api/servers/gtnh/history?hours=24').flush(HISTORY);
    events.push(10, { serverId: 'gtnh', type: 'tps', tps: 19 });
    events.push(11, { serverId: 'gtnh', type: 'tps', tps: 18 });
    events.push(12, { serverId: 'gtnh', type: 'join', player: 'Alex' });
    events.push(13, { serverId: 'other', type: 'join', player: 'Elsewhere' });
    events.push(14, { serverId: 'gtnh', type: 'recovered' });
    events.push(15, { serverId: 'gtnh', type: 'leave', player: 'Steve' });
    events.push(16, { serverId: 'gtnh', type: 'crashed' });
    await render();
    const values = (title: string) => (chart(title)![0]![1] as [number, number][]).map((p) => p[1]);
    expect(values('TPS')).toEqual([19.5, 12, 18]);
    expect(values('Players')).toEqual([0, 1, 1, 2, 1, 0]);
    expect(values('Uptime')).toEqual([NaN, 1, 0.5, 1, 0, 0]);
    backend.verify();
  });

  it('has no TPS graph without the mod', async () => {
    const { backend, render, chart } = await setup('/site/history', NO_MOD);
    backend.expectOne('/api/servers/site/history?hours=24').flush({ ...HISTORY, tps: null });
    await render();
    expect(chart('TPS')).toBeUndefined();
    expect(chart('Players')).toBeDefined();
  });

  it('links to the audit log filtered to this server', async () => {
    const { el } = await setup('/gtnh');
    expect(el.querySelector('a[data-audit]')?.getAttribute('href')).toBe('/audit?server=gtnh');
  });
});

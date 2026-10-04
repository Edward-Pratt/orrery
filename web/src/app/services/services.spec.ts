import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { CheckStatus, Integrations, ServerCard, ServiceStatus } from '@hub/api';
import { HlmToaster } from '@spartan-ng/helm/sonner';
import { FETCH, RETRY_MS } from '../events';
import { Feedback } from '../feedback';
import { dialog, dialogButton, fakeEvents, settle, toasts } from '../testing';
import Services from './services';

const ALL: Integrations = { minecraft: true, discord: false, web: true, checks: true, host: false, systemd: true, github: false, library: false };
const svc = (id: string, state: string | null, checks: string[] = []): ServiceStatus => ({ id, unit: `${id}.service`, state, sub: state, checks });
const GRAFANA = svc('grafana', 'active', ['grafana']);
const CADDY = svc('caddy', 'inactive');
const check = (id: string, over: Partial<CheckStatus> = {}): CheckStatus => ({ id, url: `https://${id}.example`, up: true, ms: 42, error: null, checkedAt: 1, service: null, ...over });
const CARD: ServerCard = {
  id: 'creative',
  name: 'Creative',
  online: true,
  hung: false,
  tps: 20,
  players: [],
  uptimeDay: 1,
  restart: null,
  lagging: false,
  service: { id: 'mc', state: 'active' },
  features: { chat: true, tps: true, quests: false },
  packUpdate: null,
};

@Component({ imports: [HlmToaster, Services], template: `<hlm-toaster /><app-services />` })
class Page {}

async function setup(on: Integrations = ALL, data: { services?: ServiceStatus[]; checks?: CheckStatus[]; cards?: ServerCard[] } = {}) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: FETCH, useValue: events.fetch },
      { provide: RETRY_MS, useValue: 0 },
    ],
  });
  const fixture = TestBed.createComponent(Page);
  const backend = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  const skeletonAtStart = !!(fixture.nativeElement as HTMLElement).querySelector('[data-skeleton]');
  backend.expectOne('/api/integrations').flush(on);
  await settle();
  if (on.systemd) backend.expectOne('/api/services').flush(data.services ?? [GRAFANA, CADDY]);
  if (on.checks) backend.expectOne('/api/checks').flush(data.checks ?? [check('grafana'), check('api', { up: false, ms: null, error: 'timeout' })]);
  if (on.minecraft) backend.expectOne('/api/servers').flush(data.cards ?? []);
  const el = fixture.nativeElement as HTMLElement;
  const render = async () => (await settle(), fixture.detectChanges(), await fixture.whenStable(), await settle());
  await render();
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  const row = (id: string) => el.querySelector<HTMLElement>(`[data-service=${id}]`)!;
  const button = (id: string, action: string) => row(id).querySelector<HTMLButtonElement>(`[data-action=${action}]`);
  /** Opens a row's ⋯ menu and clicks the item. */
  const menu = async (id: string, action: string) => {
    button(id, 'more')!.click();
    await render();
    document.querySelector<HTMLElement>(`[data-slot=dropdown-menu-item][data-action=${action}]`)!.click();
    await render();
  };
  return { skeletonAtStart, events, backend, el, render, text, row, button, menu, feedback: TestBed.inject(Feedback) };
}

describe('services page', () => {
  afterEach(() => {
    document.querySelectorAll('[data-sonner-toaster], .cdk-overlay-container > *').forEach((n) => n.remove());
  });

  it('shows each service as a dot and a word, with its checks as chips', async () => {
    const { text, row } = await setup();
    expect(text(row('grafana').querySelector('[data-state]'))).toBe('active');
    expect(text(row('caddy').querySelector('[data-state]'))).toBe('inactive');
    expect(text(row('grafana').querySelector('[data-checks]'))).toBe('grafana ✓ 42 ms');
    expect(row('caddy').querySelector('[data-check]')).toBeNull();
  });

  it('lists checks no service shows under Standalone checks', async () => {
    const { el, text } = await setup();
    expect(text(el.querySelector('h2'))).toBe('Standalone checks');
    expect(text(el.querySelector('[data-standalone=api]'))).toContain('api ✗ timeout');
    expect(el.querySelector('[data-standalone=grafana]')).toBeNull();
  });

  it('updates a chip from a live checked result', async () => {
    const { events, render, text, row } = await setup();
    events.push(1, { target: 'check', id: 'grafana', type: 'checked', status: check('grafana', { up: false, ms: null, error: 'HTTP 503' }) });
    await render();
    expect(text(row('grafana').querySelector('[data-checks]'))).toBe('grafana ✗ HTTP 503');
  });

  it('fetches the services again on a service event, without a toast', async () => {
    const { events, backend, render, text, row, feedback } = await setup();
    const toasted = [vi.spyOn(feedback, 'ok'), vi.spyOn(feedback, 'failed')];
    events.push(1, { target: 'service', id: 'caddy', type: 'state', state: 'active', sub: 'running' });
    await new Promise((r) => setTimeout(r, 80));
    backend.expectOne('/api/services').flush([GRAFANA, svc('caddy', 'failed')]);
    backend.expectOne('/api/servers').flush([]); // a card carries its service's state
    await render();
    expect(text(row('caddy').querySelector('[data-state]'))).toBe('failed');
    toasted.forEach((t) => expect(t).not.toHaveBeenCalled());
  });

  it('starts a stopped service without asking, and stops one after a dialog', async () => {
    const { backend, render, button, menu } = await setup();
    expect(button('caddy', 'restart')).toBeNull();
    button('caddy', 'start')!.click();
    await render();
    expect(dialog()).toBeNull();
    const start = backend.expectOne('/api/services/caddy/start');
    expect(start.request.detectContentTypeHeader()).toBe('application/json');
    start.flush({ at: null });
    await render();
    expect(toasts()).toEqual(['Start sent to caddy.service.']);

    await menu('grafana', 'stop');
    expect(dialog()?.textContent).toContain('Stop grafana.service?');
    backend.expectNone('/api/services/grafana/stop');
    dialogButton('cancel').click();
    await render();
    backend.expectNone('/api/services/grafana/stop');
    await menu('grafana', 'stop');
    dialogButton('ok').click();
    await render();
    backend.expectOne('/api/services/grafana/stop').flush({ at: null });
  });

  it('asks before restarting a service that runs no server', async () => {
    const { backend, render, button } = await setup();
    expect(button('grafana', 'start')).toBeNull();
    button('grafana', 'restart')!.click();
    await render();
    expect(dialog()?.textContent).toContain('Restart grafana.service?');
    dialogButton('ok').click();
    await render();
    backend.expectOne('/api/services/grafana/restart').flush({ at: null });
  });

  it("toasts a failure with the hub's message", async () => {
    const { backend, render, button } = await setup();
    button('caddy', 'start')!.click();
    backend.expectOne('/api/services/caddy/start').flush('systemctl failed', { status: 502, statusText: 'Bad Gateway' });
    await render();
    expect(toasts()[0]).toContain('Start of caddy.service failed: systemctl failed');
  });

  it('links a service that runs a server to it, with the server actions', async () => {
    const { el, row, text, button, backend, render } = await setup(ALL, { services: [svc('mc', 'active')], cards: [CARD] });
    expect(text(row('mc').querySelector('[data-runs]'))).toBe('runs Creative →');
    expect(row('mc').querySelector('[data-runs]')?.getAttribute('href')).toBe('/servers/creative');
    expect(row('mc').querySelector('app-server-actions')).not.toBeNull();
    expect(button('mc', 'console')).not.toBeNull(); // the server's actions, not the plain Restart
    expect(button('mc', 'more')).not.toBeNull();
    button('mc', 'restart')!.click(); // the server's own: a countdown, no dialog
    await render();
    expect(dialog()).toBeNull();
    expect(backend.expectOne('/api/servers/creative/restart').request.body).toEqual({ minutes: 5 });
    expect(el.querySelector('[data-action=logs]')).toBeNull();
  });

  it('opens the logs in a sheet, and Refresh fetches them again', async () => {
    const { backend, render, menu } = await setup();
    await menu('grafana', 'logs');
    backend.expectOne('/api/services/grafana/logs').flush({ lines: ['one', 'two'] });
    await render();
    const sheet = () => document.querySelector<HTMLElement>('[data-slot=sheet-content]');
    expect(sheet()?.textContent).toContain('grafana.service logs');
    expect(sheet()?.querySelector('[data-logs]')?.textContent).toBe('one\ntwo');
    sheet()!.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    backend.expectOne('/api/services/grafana/logs').flush({ lines: ['three'] });
    await render();
    expect(sheet()?.querySelector('[data-logs]')?.textContent).toBe('three');
  });

  it('shows skeletons until loaded, then an empty state', async () => {
    const { skeletonAtStart, el, text } = await setup(ALL, { services: [], checks: [], cards: [] });
    expect(skeletonAtStart).toBe(true);
    expect(el.querySelector('[data-skeleton]')).toBeNull();
    expect(text(el)).toContain('Nothing to show');
  });

  it('is titled Checks, holding only checks, when systemd is off', async () => {
    const { el, text } = await setup({ ...ALL, systemd: false, github: false, minecraft: false });
    expect(text(el.querySelector('h1'))).toBe('Checks');
    expect(el.querySelector('[data-service]')).toBeNull();
    expect(el.querySelector('h2')).toBeNull();
    expect([...el.querySelectorAll('[data-standalone]')].map((e) => e.getAttribute('data-standalone'))).toEqual(['grafana', 'api']);
  });
});

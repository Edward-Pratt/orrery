import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { ServerCard } from '@hub/api';
import { HlmToaster } from '@spartan-ng/helm/sonner';
import { FETCH, RETRY_MS } from '../events';
import { dialog, dialogButton, fakeEvents, settle, toasts } from '../testing';
import Cards from './cards';

const GTNH: ServerCard = {
  id: 'gtnh',
  name: 'GTNH',
  online: true,
  hung: false,
  tps: 19.5,
  players: [],
  uptimeDay: 1,
  restart: null,
  lagging: false,
  service: { id: 'gtnh-svc', state: 'active' },
  features: { chat: true, tps: true, quests: true },
  packUpdate: null,
};
const SITE: ServerCard = {
  ...GTNH,
  id: 'site',
  name: 'Website',
  tps: null,
  online: false,
  service: null,
  features: { chat: false, tps: false, quests: false },
};

@Component({ imports: [HlmToaster, Cards], template: `<hlm-toaster /><app-cards />` })
class Page {}

async function setup(cards: ServerCard[] = [GTNH, SITE]) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: ':id', children: [] }]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: FETCH, useValue: events.fetch },
      { provide: RETRY_MS, useValue: 0 },
    ],
  });
  const fixture = TestBed.createComponent(Page);
  const backend = TestBed.inject(HttpTestingController);
  const el = fixture.nativeElement as HTMLElement;
  await fixture.whenStable();
  const skeleton = !!el.querySelector('[data-skeleton]');
  backend.expectOne('/api/servers').flush(cards);
  await settle();
  await fixture.whenStable();
  const text = (server: string, field: string) => el.querySelector(`[data-server=${server}] [data-${field}]`)?.textContent?.trim();
  /** The actions a row has, in the order shown. */
  const actions = (server: string) => [...el.querySelectorAll(`[data-server=${server}] [data-action]`)].map((b) => b.getAttribute('data-action'));
  const button = (server: string, action: string) => el.querySelector<HTMLButtonElement>(`[data-server=${server}] [data-action=${action}]`)!;
  const render = async () => (await settle(), fixture.detectChanges(), await fixture.whenStable(), await settle());
  /** Opens the ⋯ menu; its items are in the overlay. */
  const menu = async (server: string) => {
    button(server, 'more').click();
    await render();
    return [...document.querySelectorAll<HTMLButtonElement>('[hlmDropdownMenuItem], [data-slot=dropdown-menu-item]')];
  };
  const refetch = async (list: ServerCard[]) => {
    await new Promise((r) => setTimeout(r, 80));
    backend.expectOne('/api/servers').flush(list);
    await render();
  };
  /** The cards change on the hub: a join event has them fetched again. */
  let n = 100;
  const change = (list: ServerCard[]) => (events.push(n++, { serverId: 'gtnh', type: 'join', player: 'x' }), refetch(list));
  return { fixture, el, backend, events, text, actions, button, render, menu, refetch, change, skeleton };
}

const item = (items: HTMLButtonElement[], label: string) => items.find((i) => i.textContent?.trim() === label)!;

describe('server rows', () => {
  afterEach(() => {
    document.querySelectorAll('[data-sonner-toaster], .cdk-overlay-container > *').forEach((n) => n.remove());
  });

  it('shows a skeleton while loading, and a sentence with no servers', async () => {
    const { skeleton, el } = await setup([]);
    expect(skeleton).toBe(true);
    expect(el.textContent).toContain('No servers yet');
  });

  it('shows TPS only for a server with the mod', async () => {
    const { text } = await setup();
    expect(text('gtnh', 'tps')).toBe('19.5');
    expect(text('site', 'tps')).toBeUndefined();
  });

  it('offers the actions its state allows', async () => {
    const { actions, change } = await setup();
    expect(actions('gtnh')).toEqual(['restart', 'console', 'more']); // online
    expect(actions('site')).toEqual([]); // offline, no linked service to start
    await change([GTNH, { ...SITE, service: { id: 'site-svc', state: 'inactive' } }]);
    expect(actions('site')).toEqual(['start']);
    await change([GTNH, { ...GTNH, id: 'p', name: 'P', restart: { at: Date.now() + 60_000, by: 'alex', stop: false } }]);
    expect(actions('p')).toEqual(['cancel']);
  });

  it('shows the state as a word, amber when lagging', async () => {
    const { text, change } = await setup();
    expect(text('gtnh', 'state')).toBe('Online');
    expect(text('site', 'state')).toBe('Offline');
    await change([{ ...GTNH, lagging: true }, SITE]);
    expect(text('gtnh', 'state')).toBe('Lagging');
  });

  it('disables Start, with a reason, while its service is starting', async () => {
    const { button, text, change } = await setup([{ ...SITE, service: { id: 's', state: 'activating' } }]);
    expect(button('site', 'start').disabled).toBe(true);
    expect(text('site', 'blocked')).toBe('Starting');
    await change([{ ...SITE, service: { id: 's', state: 'inactive' } }]);
    expect(button('site', 'start').disabled).toBe(false);
  });

  it('posts Restart as a 5-minute countdown without asking', async () => {
    const { backend, button, render, refetch } = await setup();
    button('gtnh', 'restart').click();
    await render();
    expect(dialog()).toBeNull();
    const req = backend.expectOne('/api/servers/gtnh/restart');
    expect(req.request.body).toEqual({ minutes: 5 });
    expect(req.request.detectContentTypeHeader()).toBe('application/json');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await render();
    expect(toasts()).toEqual(['GTNH restarts in 5 minutes.']);
    await refetch([{ ...GTNH, restart: { at: Date.now() + 300_000, by: 'alex', stop: false } }, SITE]);
  });

  it('asks before Stop, and on a linked server calls the service’s stop', async () => {
    const { backend, menu, render } = await setup();
    const items = await menu('gtnh');
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Stop', 'Restart now']);
    item(items, 'Stop').click();
    await render();
    expect(dialog()?.textContent).toContain('Stop GTNH?');
    backend.expectNone('/api/services/gtnh-svc/stop');
    dialogButton('ok').click();
    await render();
    backend.expectOne('/api/services/gtnh-svc/stop').flush({ at: null });
    await render();
    expect(toasts()).toEqual(['Stop sent to GTNH.']);
  });

  it('asks before Restart now, then posts a 0-minute countdown', async () => {
    const { backend, menu, render } = await setup();
    item(await menu('gtnh'), 'Restart now').click();
    await render();
    expect(dialog()?.textContent).toContain('Restart GTNH now?');
    backend.expectNone('/api/servers/gtnh/restart');
    dialogButton('ok').click();
    await render();
    expect(backend.expectOne('/api/servers/gtnh/restart').request.body).toEqual({ minutes: 0 });
  });

  it('starts a linked server through its service, without asking', async () => {
    const { backend, button, render } = await setup([{ ...SITE, service: { id: 'site-svc', state: 'inactive' } }]);
    button('site', 'start').click();
    await render();
    expect(dialog()).toBeNull();
    backend.expectOne('/api/services/site-svc/start').flush({ at: null });
  });

  it('cancels a pending restart', async () => {
    const pending = { ...GTNH, restart: { at: Date.now() + 120_000, by: 'alex', stop: false } };
    const { backend, button, text, render, refetch } = await setup([pending]);
    expect(text('gtnh', 'restart-left')).toMatch(/^in (2 m|1 m 5\d s)$/);
    button('gtnh', 'cancel').click();
    backend.expectOne('/api/servers/gtnh/restart/cancel').flush(null, { status: 204, statusText: 'No Content' });
    await render();
    await refetch([GTNH]);
    expect(button('gtnh', 'cancel')).toBeNull();
  });

  it('updates TPS from an event without fetching, and refetches on a join, on lag and on its service’s state', async () => {
    const { backend, events, text, render, refetch } = await setup();
    events.push(1, { serverId: 'gtnh', type: 'tps', tps: 12.25 });
    await new Promise((r) => setTimeout(r, 80));
    await render();
    expect(text('gtnh', 'tps')).toBe('12.3');
    backend.verify();
    events.push(2, { serverId: 'gtnh', type: 'join', player: 'Steve' });
    await refetch([{ ...GTNH, players: ['Steve'] }, SITE]);
    expect(text('gtnh', 'players')).toBe('1');
    events.push(3, { serverId: 'gtnh', type: 'notice', severity: 'warning', kind: 'lag', tps: 10, worst: null });
    await refetch([{ ...GTNH, lagging: true }, SITE]);
    expect(text('gtnh', 'state')).toBe('Lagging');
    events.push(4, { target: 'service', id: 'gtnh-svc', type: 'state', state: 'inactive', sub: 'dead' });
    await refetch([{ ...GTNH, online: false, service: { id: 'gtnh-svc', state: 'inactive' } }, SITE]);
    expect(text('gtnh', 'state')).toBe('Offline');
  });

  it('opens the server page from a tap on the row, but not from a button', async () => {
    const { el, button, render } = await setup();
    const router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigate');
    expect(button('gtnh', 'console').getAttribute('href')).toBe('/servers/gtnh/console'); // the Console tab
    button('gtnh', 'console').click();
    expect(nav).not.toHaveBeenCalled();
    el.querySelector<HTMLElement>('[data-server=gtnh] [data-tps]')!.click();
    await render();
    expect(nav).toHaveBeenCalledWith(['/servers', 'gtnh']);
    expect(el.querySelector('[data-server=gtnh] a')?.getAttribute('href')).toBe('/servers/gtnh');
  });
});

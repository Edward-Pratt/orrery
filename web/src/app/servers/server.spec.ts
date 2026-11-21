import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { BackupsAnswer, PendingRestart, ServiceStatus } from '@hub/api';
import { FETCH } from '../events';
import { dialog, dialogButton, fakeEvents, loggedIn } from '../testing';
import routes from './routes';
import { CARD, debounce, detail, FACTORIO, NO_MOD, setup } from './server.testing';

describe('server page', () => {
  it('shows an overview, with a Chat section for a server with the mod', async () => {
    const { el, tabs, text } = await setup('/gtnh');
    expect(text(el.querySelector('h1'))).toBe('GTNH Online');
    expect(tabs()).toEqual(['Overview', 'Console', 'Chat', 'Players', 'History']);
    expect(text(el.querySelector('[data-players]'))).toBe('Online now (1)Steve');
    expect(el.querySelector('[data-chat]')).toBeNull();
  });

  it('has no Chat section for a server without the mod, even when linked to', async () => {
    const { el, tabs } = await setup('/site/chat', NO_MOD);
    expect(tabs()).toEqual(['Overview', 'Players', 'History']);
    expect(el.querySelector('[data-chat]')).toBeNull();
    expect(el.querySelector('[data-no-chat]')).not.toBeNull();
  });

  it('explains an unknown server', async () => {
    const events = fakeEvents();
    TestBed.configureTestingModule({
      providers: [loggedIn(), provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/nope');
    TestBed.inject(HttpTestingController).expectOne('/api/servers/nope').flush('Not Found', { status: 404, statusText: 'Not Found' });
    harness.fixture.detectChanges();
    expect(harness.routeNativeElement?.textContent).toContain('No such server.');
  });

  it('names the linked service under the header, and follows its state', async () => {
    const unlinked = await setup('/gtnh');
    expect(unlinked.el.querySelector('[data-service-line]')).toBeNull();
    TestBed.resetTestingModule();
    const gtnh: ServiceStatus = { id: 'gtnh', unit: 'gtnh.service', state: 'active', sub: 'running', checks: [] };
    const linked = await setup('/gtnh/chat', { ...CARD, service: { id: 'gtnh', state: 'active' } }, gtnh);
    expect(linked.text(linked.el.querySelector('[data-service-line]'))).toBe('runs as gtnh.service, active');
    linked.events.push(1, { target: 'service', id: 'gtnh', type: 'state', state: 'inactive', sub: 'dead' });
    await linked.render();
    expect(linked.text(linked.el.querySelector('[data-service-line]'))).toBe('runs as gtnh.service, inactive');
  });

  it('shows the Console tab only with the console feature', async () => {
    expect((await setup('/space', FACTORIO)).tabs()).toEqual(['Overview', 'Console', 'Chat', 'Players', 'History']);
    TestBed.resetTestingModule();
    expect((await setup('/gtnh', { ...CARD, features: { ...CARD.features, console: false } })).tabs()).toEqual(['Overview', 'Chat', 'Players', 'History']);
  });

  it("names a factorio server's Backups tab Saves", async () => {
    const saves: BackupsAnswer = { configured: true, backups: [], free: null, growth: null, minFree: 0 };
    expect((await setup('/space', FACTORIO, null, { backups: saves })).tabs()).toEqual(['Overview', 'Console', 'Chat', 'Players', 'History', 'Saves']);
  });

  it('shows the Backups tab only when the server has a backup folder', async () => {
    expect((await setup('/gtnh', CARD, null, { backups: { configured: true, backups: [], free: null, growth: 0, minFree: 0 } })).tabs()).toContain('Backups');
    TestBed.resetTestingModule();
    expect((await setup('/gtnh')).tabs()).not.toContain('Backups');
  });

  it('redirects the old stats path to players', async () => {
    const { el, tabs } = await setup('/gtnh/stats', CARD, null, { top: { day: [], week: [], all: [] } });
    expect(TestBed.inject(Router).url).toBe('/gtnh/players');
    expect(el.querySelector('[data-lookup]')).not.toBeNull();
    expect(tabs()).toContain('Players');
  });

  describe('header menu', () => {
    const open = async (linked = false) => {
      const gtnh: ServiceStatus = { id: 'gtnh', unit: 'gtnh.service', state: 'active', sub: 'running', checks: [] };
      const page = await setup('/gtnh', linked ? { ...CARD, service: { id: 'gtnh', state: 'active' } } : CARD, linked ? gtnh : null);
      page.el.querySelector<HTMLButtonElement>('[data-action=more]')!.click();
      await page.render();
      const items = () => [...document.querySelectorAll<HTMLElement>('[data-slot=dropdown-menu-item]')];
      return { ...page, items };
    };

    it('has Stop, Restart now, Restart in… and the server’s audit log', async () => {
      const { items } = await open(true);
      expect(items().map((i) => i.textContent?.trim())).toEqual(['Stop', 'Restart now', 'Restart in…', 'Audit log for this server']);
      expect(items().at(-1)!.getAttribute('href')).toBe('/audit?server=gtnh');
    });

    it('has no Stop without a linked service', async () => {
      const { items } = await open();
      expect(items().map((i) => i.textContent?.trim())).toEqual(['Restart now', 'Restart in…', 'Audit log for this server']);
    });

    it('navigates to the audit log filtered to this server', async () => {
      const { items, render } = await open();
      items().at(-1)!.click();
      await render();
      expect(TestBed.inject(Router).url).toBe('/audit?server=gtnh');
    });

    it('Restart in… posts the chosen minutes', async () => {
      const { backend, el, items, render } = await open();
      items().find((i) => i.textContent?.includes('Restart in'))!.click();
      await render();
      el.querySelector<HTMLInputElement>('[data-restart-form] input')!.value = '10';
      el.querySelector('[data-restart-form]')!.dispatchEvent(new Event('submit'));
      const req = backend.expectOne('/api/servers/gtnh/restart');
      expect(req.request.body).toEqual({ minutes: 10 });
      req.flush(null, { status: 204, statusText: 'No Content' });
    });

    it('Stop confirms, then calls the service’s stop on a linked server', async () => {
      const { backend, items, render } = await open(true);
      items()[0]!.click();
      await render();
      expect(dialog()?.textContent).toContain('Stop GTNH?');
      dialogButton('ok').click();
      await render();
      backend.expectOne('/api/services/gtnh/stop').flush({ at: null });
    });
  });
});

describe('server restarts', () => {
  const PENDING: PendingRestart = { at: new Date(2026, 8, 27, 18, 30).getTime(), by: 'bob', stop: false };
  const restartText = (el: HTMLElement) => el.querySelector('[data-restart-pending]')?.textContent?.replace(/\s+/g, ' ').trim();

  it('shows a pending restart on the Overview, and Cancel sends the cancel', async () => {
    const { backend, el, render } = await setup('/gtnh', { ...CARD, restart: { ...PENDING, by: 'alex' } });
    expect(el.querySelector('[data-restart-pending-section] [data-restart-pending]')?.textContent?.replace(/\s+/g, ' ').trim()).toContain('Restart at 18:30:00');
    el.querySelector<HTMLButtonElement>('[data-restart-pending-section] [data-action=cancel]')!.click();
    backend.expectOne('/api/servers/gtnh/restart/cancel').flush(null, { status: 204, statusText: 'No Content' });
    await debounce();
    backend.expectOne('/api/servers/gtnh').flush(detail(CARD));
    await render();
    expect(el.querySelector('[data-restart-pending-section]')).toBeNull();
  });

  it('counts down to it, second by second', async () => {
    const { el, render } = await setup('/gtnh', { ...CARD, restart: { at: Date.now() + 90_400, by: 'bob', stop: false } });
    const left = () => el.querySelector('[data-restart-left]')?.textContent?.trim();
    expect(left()).toBe('in 1 m 30 s');
    await new Promise((r) => setTimeout(r, 1_000));
    await render();
    expect(left()).toBe('in 1 m 29 s');
  });

  it('shows a countdown scheduled elsewhere, a service stop included, from the stream', async () => {
    const { backend, events, el, render } = await setup('/gtnh');
    events.push(1, { serverId: 'gtnh', type: 'notice', severity: 'info', kind: 'restartScheduled', ms: 300_000, by: 'bob', stop: true });
    await debounce();
    backend.expectOne('/api/servers/gtnh').flush(detail({ ...CARD, restart: { ...PENDING, stop: true } }));
    await render();
    expect(restartText(el)).toContain('Stop at 18:30:00');
  });
});

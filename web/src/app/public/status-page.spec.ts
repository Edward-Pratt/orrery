import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { reflectComponentType } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { PublicServer, PublicStatus } from '@hub/api';
import { App } from '../app';
import { isStatusPath, POLL_MS, StatusPage } from './status-page';

const server = (s: Partial<PublicServer> & Pick<PublicServer, 'name' | 'state'>): PublicServer => ({ game: 'minecraft', players: [], uptimeWeek: null, uptimeMonth: null, ...s });
const ANSWER: PublicStatus = {
  servers: [
    server({ name: 'GTNH', state: 'up', players: ['Steve', 'Alex'], uptimeWeek: 0.992, uptimeMonth: 0.9875 }),
    server({ name: 'Factorio', game: 'factorio', state: 'paused', uptimeMonth: 1 }),
    server({ name: 'TFC', state: 'hung' }),
    server({ name: 'Old', state: 'down' }),
  ],
};

/** The page with a fake hub; time is fake, so each poll comes only when the test moves it on. */
async function open() {
  vi.useFakeTimers();
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(StatusPage);
  const backend = TestBed.inject(HttpTestingController);
  await vi.advanceTimersByTimeAsync(0);
  const render = async () => (await vi.advanceTimersByTimeAsync(0), fixture.detectChanges(), fixture.nativeElement as HTMLElement);
  return { backend, render };
}

const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('the Status page', () => {
  afterEach(() => (vi.useRealTimers(), document.documentElement.classList.remove('dark')));

  it('asks the hub for /api/public/status and nothing else, then shows each server', async () => {
    const { backend, render } = await open();
    backend.expectOne('/api/public/status').flush(ANSWER);
    backend.verify();
    const el = await render();
    const cards = [...el.querySelectorAll('[data-server]')];
    expect(cards.map((c) => text(c.querySelector('h2')))).toEqual(['GTNH', 'Factorio', 'TFC', 'Old']);
    expect(cards.map((c) => text(c.querySelector('app-status')))).toEqual(['Up', 'Up · paused', 'Not responding', 'Down']);
    expect(text(cards[0]!.querySelector('[data-players]'))).toBe('2 online: Steve, Alex');
    expect(text(cards[1]!.querySelector('[data-players]'))).toBe('Nobody on');
    expect(text(cards[0]!.querySelector('[data-uptime]'))).toBe('99.2% this week · 98.8% this month');
    expect(text(cards[1]!.querySelector('[data-uptime]'))).toBe('100% this month');
    expect(cards[2]!.querySelector('[data-uptime]')).toBeNull();
    expect(text(el.querySelector('[data-updated]'))).toBe('Updated just now');
    expect(document.title).toBe('orrery status');
  });

  it("keeps the last answer greyed out under \"Can't reach orrery right now\" when the hub fails, and clears it on the next answer", async () => {
    const { backend, render } = await open();
    backend.expectOne('/api/public/status').flush(ANSWER);
    await render();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    backend.expectOne('/api/public/status').flush('Not logged in', { status: 401, statusText: 'Unauthorized' });
    let el = await render();
    expect(text(el.querySelector('[data-unreachable]'))).toBe("Can't reach orrery right now.");
    expect(el.querySelectorAll('[data-server]').length).toBe(4);
    expect(el.querySelector('ul')!.classList).toContain('opacity-50');
    expect(text(el.querySelector('[data-updated]'))).toBe('Updated 30 s ago');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    backend.expectOne('/api/public/status').flush({ servers: [server({ name: 'GTNH', state: 'down' })] });
    el = await render();
    expect(el.querySelector('[data-unreachable]')).toBeNull();
    expect(el.querySelectorAll('[data-server]').length).toBe(1);
  });

  it('says so when the hub has never answered', async () => {
    const { backend, render } = await open();
    backend.expectOne('/api/public/status').flush('Bad gateway', { status: 502, statusText: 'Bad Gateway' });
    const el = await render();
    expect(text(el.querySelector('[data-unreachable]'))).toBe("Can't reach orrery right now.");
    expect(el.querySelector('[data-server]')).toBeNull();
  });

  it("boots into index.html's one root element, as the dashboard does", () => {
    expect(reflectComponentType(StatusPage)?.selector).toBe(reflectComponentType(App)?.selector);
  });

  it('is the page for /status, with or without a trailing slash, and for nothing else', () => {
    expect(['/status', '/status/'].map(isStatusPath)).toEqual([true, true]);
    expect(['/', '/servers', '/statuses', '/status/x'].map(isStatusPath)).toEqual([false, false, false, false]);
  });
});

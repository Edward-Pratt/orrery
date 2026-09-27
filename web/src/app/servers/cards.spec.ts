import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ServerCard } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, settle } from '../testing';
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
  features: { chat: true, tps: true, quests: true },
};
const SITE: ServerCard = {
  ...GTNH,
  id: 'site',
  name: 'Website',
  tps: null,
  features: { chat: false, tps: false, quests: false },
};

async function setup() {
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
  const fixture = TestBed.createComponent(Cards);
  const backend = TestBed.inject(HttpTestingController);
  backend.expectOne('/api/servers').flush([GTNH, SITE]);
  await settle();
  await fixture.whenStable();
  const text = (server: string, field: string) =>
    (fixture.nativeElement as HTMLElement).querySelector(`[data-server=${server}] [data-${field}]`)?.textContent?.trim();
  return { fixture, backend, events, text };
}

describe('server cards', () => {
  it('shows TPS only for a server with the mod', async () => {
    const { text } = await setup();
    expect(text('gtnh', 'tps')).toBe('19.5');
    expect(text('site', 'tps')).toBeUndefined();
  });

  it('updates TPS from a TPS event, without fetching', async () => {
    const { fixture, backend, events, text } = await setup();
    events.push(1, { serverId: 'gtnh', type: 'tps', tps: 12.25 });
    await new Promise((r) => setTimeout(r, 80));
    await fixture.whenStable();
    expect(text('gtnh', 'tps')).toBe('12.3');
    backend.verify();
  });

  it('fetches the cards again after a join', async () => {
    const { fixture, backend, events, text } = await setup();
    events.push(1, { serverId: 'gtnh', type: 'join', player: 'Steve' });
    await new Promise((r) => setTimeout(r, 80));
    backend.expectOne('/api/servers').flush([{ ...GTNH, players: ['Steve'] }, SITE]);
    await fixture.whenStable();
    expect(text('gtnh', 'players')).toBe('Steve');
  });

  it('schedules and cancels a countdown restart from the card, only for a server with the mod', async () => {
    const { fixture, backend } = await setup();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-server=site] [data-restart-form]')).toBeNull();
    const form = el.querySelector('[data-server=gtnh] [data-restart-form]')!;
    form.querySelector('input')!.value = '2';
    form.dispatchEvent(new Event('submit'));
    const req = backend.expectOne('/api/servers/gtnh/restart');
    expect(req.request.body).toEqual({ minutes: 2 });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await new Promise((r) => setTimeout(r, 80));
    const at = Date.now() + 120_000;
    backend.expectOne('/api/servers').flush([{ ...GTNH, restart: { at, by: 'alex', stop: false } }, SITE]);
    await fixture.whenStable();
    expect(el.querySelector('[data-server=gtnh] [data-restart-left]')?.textContent?.trim()).toMatch(/^in (2 m|1 m 5\d s)$/);

    el.querySelector<HTMLButtonElement>('[data-server=gtnh] [data-restart-cancel]')!.click();
    backend.expectOne('/api/servers/gtnh/restart/cancel').flush(null, { status: 204, statusText: 'No Content' });
    await new Promise((r) => setTimeout(r, 80));
    backend.expectOne('/api/servers').flush([GTNH, SITE]);
    await fixture.whenStable();
    expect(el.querySelector('[data-server=gtnh] [data-restart-pending]')).toBeNull();
  });

  it('still links each card to its server page', async () => {
    const { fixture } = await setup();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-server=gtnh] a')?.getAttribute('href')).toBe('/gtnh');
  });
});

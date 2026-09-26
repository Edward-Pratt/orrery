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
});

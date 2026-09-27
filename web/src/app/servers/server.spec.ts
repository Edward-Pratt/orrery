import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { ServerCard, ServerDetail, ServiceStatus } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, settle } from '../testing';
import ServerPage from './server';

const CARD: ServerCard = {
  id: 'gtnh',
  name: 'GTNH',
  online: true,
  hung: false,
  tps: 20,
  players: [],
  uptimeDay: 1,
  restart: null,
  features: { chat: true, tps: true, quests: true },
};

async function setup(card = CARD, service: ServiceStatus | null = null) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: FETCH, useValue: events.fetch },
      { provide: RETRY_MS, useValue: 0 },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: card.id }) } } },
    ],
  });
  const fixture = TestBed.createComponent(ServerPage);
  const backend = TestBed.inject(HttpTestingController);
  backend.expectOne(`/api/servers/${card.id}`).flush({ card, service } as ServerDetail);
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const render = async () => (await settle(), await fixture.whenStable());
  const chat = () => [...el.querySelectorAll('[data-chat] li')].map((li) => li.textContent!.replace(/\s+/g, ' ').trim());
  return { backend, events, el, render, chat };
}

describe('server page chat', () => {
  it('shows recent chat from the replay, then live lines, for this server only', async () => {
    const { events, render, chat } = await setup();
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
    const { backend, el, render } = await setup();
    await render();
    const input = el.querySelector('input')!;
    const form = el.querySelector('form')!;
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

  it('has no chat for a server without the mod', async () => {
    const { el, render } = await setup({ ...CARD, id: 'site', name: 'Website', features: { chat: false, tps: false, quests: false } });
    await render();
    expect(el.querySelector('[data-chat]')).toBeNull();
    expect(el.querySelector('[data-no-chat]')).not.toBeNull();
  });

  it('shows the labelled service actions only when a service is linked', async () => {
    const unlinked = await setup();
    await unlinked.render();
    expect(unlinked.el.querySelector('[data-service-actions]')).toBeNull();
    TestBed.resetTestingModule();
    const gtnh: ServiceStatus = { id: 'gtnh', unit: 'gtnh.service', state: 'active', sub: 'running', checks: [] };
    const linked = await setup(CARD, gtnh);
    await linked.render();
    const section = linked.el.querySelector('[data-service-actions]');
    expect(section?.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Service gtnh.service active (running)');
    expect([...section!.querySelectorAll('[data-action]')].map((b) => b.textContent)).toEqual(['Start', 'Stop', 'Restart']);
    linked.events.push(1, { target: 'service', id: 'gtnh', type: 'state', state: 'inactive', sub: 'dead' });
    await linked.render();
    expect(section?.querySelector('h2')?.textContent).toContain('inactive (dead)');
  });
});

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { Me, ServerCard, ServerDetail } from '@hub/api';
import { FETCH } from '../events';
import { fakeEvents, loggedIn, settle, VIEWER } from '../testing';
import routes from './routes';

const GTNH: ServerCard = {
  lagging: false,
  service: { id: 'gtnh', state: 'active' },
  id: 'gtnh',
  name: 'GTNH',
  game: 'minecraft',
  rate: { label: 'TPS', max: 20 },
  online: true,
  hung: false,
  paused: false,
  tps: 20,
  players: [],
  uptimeDay: 1,
  restart: null,
  features: { chat: true, tps: true, quests: true, console: true, update: false },
  packUpdate: null,
};
const BACKUPS = { configured: true, backups: [{ name: 'a.zip', size: 1, mtimeMs: 0 }], free: null, growth: null, minFree: 0 } as ServerDetail['backups'];
/** Operator on gtnh alone: chat, control, moderation, its service and the service's logs. */
const OPERATOR: Me = {
  ...VIEWER,
  permissions: ['servers.chat', 'servers.control', 'servers.moderation', 'services.control', 'services.logs'].map((permission) => ({ permission, servers: ['gtnh'] })) as Me['permissions'],
};

/** Opens the server page at `url` as `me`, with logs, a pack and backups. */
async function open(me: Me, url: string, card = GTNH) {
  TestBed.configureTestingModule({
    providers: [loggedIn(me), provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: fakeEvents().fetch }],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const service = card.service && { id: card.service.id, unit: `${card.id}.service`, state: 'active', sub: 'running', checks: [] };
  const detail = { card, service, top: { day: [], week: [], all: [] }, backups: BACKUPS, pack: true, logs: true } as unknown as ServerDetail;
  TestBed.inject(HttpTestingController).expectOne(`/api/servers/${card.id}`).flush(detail);
  await settle();
  harness.fixture.detectChanges();
  const el = harness.routeNativeElement as HTMLElement;
  return { el, tabs: () => [...el.querySelectorAll('[data-sections] a')].map((a) => a.textContent!.trim()), actions: () => [...el.querySelectorAll('header [data-action]')].map((b) => b.getAttribute('data-action')) };
}

describe('what a user may do on a server page', () => {
  it('a viewer gets the reads only: no Console, Logs or Pack tab, no actions', async () => {
    const { tabs, actions } = await open(VIEWER, '/gtnh');
    expect(tabs()).toEqual(['Overview', 'Chat', 'Players', 'History', 'Backups']);
    expect(actions()).toEqual([]);
  });

  it("a viewer's chat is read only and their backups list has no actions", async () => {
    const chat = await open(VIEWER, '/gtnh/chat');
    expect(chat.el.querySelector('[data-chat]')).not.toBeNull();
    expect(chat.el.querySelector('[data-chat-form]')).toBeNull();
    TestBed.resetTestingModule();
    const backups = await open(VIEWER, '/gtnh/backups');
    expect(backups.el.querySelector('[data-backup]')).not.toBeNull();
    expect(backups.el.querySelector('[data-backup-start]')).toBeNull();
    expect(backups.el.querySelector('[data-backup-more]')).toBeNull();
  });

  it('an operator scoped to gtnh restarts and chats there, without the console or the audit link', async () => {
    const { tabs, actions, el } = await open(OPERATOR, '/gtnh/chat');
    expect(tabs()).toEqual(['Overview', 'Chat', 'Players', 'History', 'Backups']);
    expect(actions()).toEqual(['restart', 'more']);
    expect(el.querySelector('[data-chat-form]')).not.toBeNull();
  });

  it('the same operator gets nothing on another server', async () => {
    const { actions, el } = await open(OPERATOR, '/tfc/chat', { ...GTNH, id: 'tfc', name: 'TFC', service: { id: 'tfc', state: 'active' } });
    expect(actions()).toEqual([]);
    expect(el.querySelector('[data-chat-form]')).toBeNull();
  });
});

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { CheckStatus, DeploysAnswer, Integrations, Me, ServerCard, ServiceStatus } from '@hub/api';
import { App } from './app';
import { BackupProgress } from './servers/backup-progress';
import { FETCH } from './events';
import { dialogButton, fakeEvents, settle } from './testing';

const ALEX: Me = { id: '5', username: 'alex', avatar: null };
const ALL: Integrations = { minecraft: true, discord: true, web: true, checks: true, host: true, systemd: true, github: false, library: false };
const card = (id: string, more: Partial<ServerCard> = {}): ServerCard => ({
  id,
  name: id.toUpperCase(),
  online: true,
  hung: false,
  tps: 20,
  players: [],
  uptimeDay: 1,
  restart: null,
  lagging: false,
  service: null,
  features: { chat: true, tps: true, quests: false },
  packUpdate: null,
  ...more,
});
const service = (id: string, state: string, sub = 'x'): ServiceStatus => ({ id, unit: `${id}.service`, state, sub, checks: [] });
const check = (id: string, up: boolean | null): CheckStatus => ({ id, url: 'http://x', up, ms: 1, error: up === false ? 'HTTP 500' : null, checkedAt: 1, service: null });

/** Opens the shell logged in, answering what the attention strip fetches. */
async function open(cards: ServerCard[], services: ServiceStatus[] = [], checks: CheckStatus[] = [], deploys?: DeploysAnswer) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }],
  });
  const fixture = TestBed.createComponent(App);
  const backend = TestBed.inject(HttpTestingController);
  await settle();
  backend.expectOne('/api/me').flush(ALEX);
  await settle();
  backend.match('/api/integrations').forEach((r) => r.flush({ ...ALL, github: !!deploys }));
  await settle();
  if (deploys) backend.expectOne('/api/deploys').flush(deploys);
  backend.expectOne('/api/servers').flush(cards);
  backend.expectOne('/api/services').flush(services);
  backend.expectOne('/api/checks').flush(checks);
  const el = fixture.nativeElement as HTMLElement;
  const render = async () => (await settle(), fixture.detectChanges(), await fixture.whenStable());
  await render();
  const lines = () => [...el.querySelectorAll('[data-item]')].map((li) => li.textContent!.replace(/\s+/g, ' ').trim());
  const badges = () => [...el.querySelectorAll('aside nav a')].flatMap((a) => (a.querySelector('[data-badge]') ? [a.textContent!.replace(/\s+/g, ' ').trim()] : []));
  /** Answers the refetch a card-changing event causes. */
  const refetch = async (cards: ServerCard[], services?: ServiceStatus[]) => {
    await new Promise((r) => setTimeout(r, 80));
    backend.expectOne('/api/servers').flush(cards);
    if (services) backend.expectOne('/api/services').flush(services);
    await render();
  };
  return { fixture, backend, events, el, render, lines, badges, refetch };
}

const DAY = 24 * 60 * 60_000;
/** The hub runs hub-v2.5.0; hub-v2.6.0 was published `daysAgo`. */
const deploys = (daysAgo: number): DeploysAnswer => ({
  hub: {
    running: 'hub-v2.5.0',
    latest: 'hub-v2.6.0',
    releases: [{ tag: 'hub-v2.6.0', publishedAt: Date.now() - daysAgo * DAY, assets: [] }, { tag: 'hub-v2.5.0', publishedAt: 0, assets: [] }],
  },
  web: { running: null, latest: null, releases: [] },
  mod: { latest: null, releases: [], servers: [] },
  checkedAt: Date.now(),
  error: null,
  newerAfterDays: 14,
  history: [],
  older: false,
  packing: [],
});

describe('the attention strip', () => {
  it('shows a newer release only once it has waited past newerAfterDays, linking to Releases', async () => {
    expect((await open([], [], [], deploys(3))).lines()).toEqual([]);
    TestBed.resetTestingModule();
    const { lines, badges } = await open([], [], [], deploys(20));
    expect(lines()).toEqual(['Hub can update to hub-v2.6.0 Releases']);
    expect(badges()).toEqual(['Host 1']);
  });

  it('shows an unexpected offline, but not a server an admin stopped', async () => {
    const { el, lines } = await open([
      card('crashed', { online: false, service: { id: 'crashed', state: 'failed' } }),
      card('nomod', { online: false, service: { id: 'nomod', state: 'active' } }),
      card('stopped', { online: false, service: { id: 'stopped', state: 'inactive' } }),
      card('starting', { online: false, service: { id: 'starting', state: 'activating' } }),
    ]);
    expect(lines()).toEqual(['CRASHED is offline: its service failed Start', 'NOMOD is offline: its service runs, the mod is not connected Restart']);
    expect(el.querySelector('[data-attention]')).not.toBeNull();
  });

  it('shows a server with no linked service whenever it is offline', async () => {
    const { lines } = await open([card('site', { online: false })]);
    expect(lines()).toEqual(['SITE is offline']);
  });

  it('offers the pre-update backup after a pack update rolled back, linking to the Pack tab, until a later update', async () => {
    const rolledBack = { running: false, rolledBack: { to: '2.7.5', backup: '2026-10-02-12-00-00.zip' } };
    const { el, lines, events, refetch, render } = await open([card('gtnh', { packUpdate: rolledBack })]);
    expect(lines()).toEqual(['GTNH rolled back its pack update to 2.7.5: the world may have changed on load Restore…']);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    el.querySelector<HTMLButtonElement>('[data-fix]')!.click();
    await render();
    expect(navigate).toHaveBeenCalledWith(['/servers', 'gtnh', 'pack']);
    events.push(1, { type: 'notice', serverId: 'gtnh', severity: 'info', kind: 'packUpdateStarted', from: '2.7.4', to: '2.7.5', by: 'alex' });
    await refetch([card('gtnh', { packUpdate: { running: true, rolledBack: null } })]);
    expect(lines()).toEqual([]);
  });

  it('shows a lagging server', async () => {
    const { lines } = await open([card('gtnh', { lagging: true })]);
    expect(lines()).toEqual(['GTNH is lagging']);
  });

  it('shows a pending restart with Cancel, which sends the cancel', async () => {
    const { backend, el, lines } = await open([card('gtnh', { restart: { at: Date.now() + 90_000, by: 'bob', stop: false } })]);
    expect(lines()[0]).toMatch(/^GTNH restarts at \d\d:\d\d:\d\d, in 1 m \d+ s Cancel$/);
    el.querySelector<HTMLButtonElement>('[data-fix]')!.click();
    backend.expectOne('/api/servers/gtnh/restart/cancel').flush(null, { status: 204, statusText: 'No Content' });
  });

  it('starts a failed server through its service without asking', async () => {
    const { backend, el } = await open([card('crashed', { online: false, service: { id: 'crashed-svc', state: 'failed' } })]);
    el.querySelector<HTMLButtonElement>('[data-fix]')!.click();
    await settle();
    backend.expectOne('/api/services/crashed-svc/start').flush({ at: null });
  });

  it('asks before restarting a service that runs without the mod', async () => {
    const { backend, el, render } = await open([card('nomod', { online: false, service: { id: 'nomod-svc', state: 'active' } })]);
    el.querySelector<HTMLButtonElement>('[data-fix]')!.click();
    await settle();
    backend.expectNone('/api/services/nomod-svc/restart');
    dialogButton('ok').click();
    await render();
    backend.expectOne('/api/services/nomod-svc/restart').flush({ at: null });
  });

  it('shows a check that is down', async () => {
    const { lines } = await open([], [], [check('site', false), check('api', true), check('new', null)]);
    expect(lines()).toEqual(['site is down: HTTP 500']);
  });

  it('shows a failed service, but not twice when it runs a server', async () => {
    const { lines } = await open(
      [card('gtnh', { online: false, service: { id: 'gtnh', state: 'failed' } })],
      [service('gtnh', 'failed'), service('backup', 'failed'), service('ok', 'active')],
    );
    expect(lines()).toEqual(['GTNH is offline: its service failed Start', 'backup.service failed Start']);
  });

  it('shows a failed service whose server is online, since no server item covers it', async () => {
    const { lines } = await open([card('gtnh', { service: { id: 'gtnh', state: 'failed' } })], [service('gtnh', 'failed')]);
    expect(lines()).toEqual(['gtnh.service failed Start']);
  });

  it('clears an offline item when its server comes back, and a restart item when it is cancelled', async () => {
    const { events, lines, refetch } = await open([
      card('a', { online: false }),
      card('b', { restart: { at: Date.now() + 60_000, by: 'bob', stop: false } }),
    ]);
    expect(lines()).toHaveLength(2);
    events.push(1, { serverId: 'a', type: 'connected' } as never);
    events.push(2, { serverId: 'b', type: 'notice', severity: 'info', kind: 'restartCancelled' } as never);
    await refetch([card('a'), card('b')]);
    expect(lines()).toEqual([]);
  });

  it('clears an item when a live event clears its condition, and hides the strip when empty', async () => {
    const { el, events, lines, render, refetch } = await open(
      [card('gtnh', { lagging: true }), card('site')],
      [service('backup', 'failed')],
      [check('web', false)],
    );
    expect(lines()).toHaveLength(3);
    events.push(1, { serverId: 'gtnh', type: 'notice', severity: 'info', kind: 'lagRecovered' } as never);
    await refetch([card('gtnh'), card('site')]);
    expect(lines()).toHaveLength(2);
    events.push(2, { target: 'check', id: 'web', type: 'checked', status: check('web', true) });
    await render();
    expect(lines()).toHaveLength(1);
    events.push(3, { target: 'service', id: 'backup', type: 'state', state: 'active', sub: 'running' });
    await refetch([card('gtnh'), card('site')], [service('backup', 'active')]);
    expect(lines()).toEqual([]);
    expect(el.querySelector('[data-attention]')).toBeNull();
  });

  it('counts the items on the Servers and Services entries', async () => {
    const { badges } = await open(
      [card('a', { lagging: true }), card('b', { online: false }), card('c')],
      [service('backup', 'failed')],
      [check('web', false)],
    );
    expect(badges()).toEqual(['Servers 2', 'Services 2']); // a down check counts on the page that shows it
  });

  it('shows a backup started here while it runs, until its finished notice', async () => {
    const { events, lines, render } = await open([card('gtnh')]);
    TestBed.inject(BackupProgress).begin('gtnh', 'backup');
    await render();
    expect(lines()).toEqual(['GTNH is backing up']);
    events.push(1, { serverId: 'gtnh', type: 'notice', severity: 'good', kind: 'backupFinished', detail: 'done' });
    await render();
    expect(lines()).toEqual([]);
  });
});

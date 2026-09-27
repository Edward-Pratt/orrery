import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { By } from '@angular/platform-browser';
import type { BackupsAnswer, PendingRestart, PlayerAnswer, ServerCard, ServerDetail, ServerHistory, ServiceStatus } from '@hub/api';
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

/** A server's detail, as the hub answers it, with nothing in it but the card. */
const detail = (card: ServerCard, more: Partial<ServerDetail> = {}) =>
  ({ card, service: null, top: { day: [], week: [], all: [] }, backups: { configured: false }, ...more }) as ServerDetail;

/** Opens `url` (e.g. `/gtnh/chat`) straight away, as a reload would, and answers the server's detail. */
async function setup(url: string, card = CARD, service: ServiceStatus | null = null, more: Partial<ServerDetail> = {}) {
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
  backend.expectOne(`/api/servers/${card.id}`).flush({ ...detail(card), service, ...more });
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
    expect(tabs()).toEqual(['Overview', 'Chat', 'Console', 'History', 'Stats']);
    expect(text(el.querySelector('[data-players]'))).toBe('Steve');
    expect(el.querySelector('[data-chat]')).toBeNull();
  });

  it('has no Chat section for a server without the mod, even when linked to', async () => {
    const { el, tabs } = await setup('/site/chat', NO_MOD);
    expect(tabs()).toEqual(['Overview', 'History', 'Stats']);
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
    backend.expectNone('/api/servers/gtnh/history?hours=24');
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

/** Waits out the server page's debounced refetch. */
const debounce = () => new Promise((r) => setTimeout(r, 80));

describe('server console section', () => {
  const submit = (el: HTMLElement, command: string) => {
    el.querySelector<HTMLInputElement>('[data-console-form] input')!.value = command;
    el.querySelector('[data-console-form]')!.dispatchEvent(new Event('submit'));
  };
  const entries = (el: HTMLElement) =>
    [...el.querySelectorAll('[data-console] > li')].map((li) => [...li.querySelectorAll('b, [data-by], [data-line]')].map((e) => e.textContent).join(' | '));

  it('posts a command and shows its output, then later output and others\' commands from the stream', async () => {
    const { backend, events, el, render, tabs } = await setup('/gtnh/console');
    expect(tabs()).toContain('Console');
    events.push(1, { serverId: 'gtnh', type: 'console', command: 'list', by: 'discord:bob (2)', output: ['1 player online'] });
    submit(el, 'spark profiler');
    const req = backend.expectOne('/api/servers/gtnh/command');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ command: 'spark profiler' });
    // The hub puts the output on the stream too, just before it answers: that copy is the one shown.
    events.push(2, { serverId: 'gtnh', type: 'console', command: 'spark profiler', by: 'web:alex (5)', output: ['Profiler started'] });
    req.flush({ output: ['Profiler started'] });
    await render();
    expect(el.querySelector<HTMLInputElement>('[data-console-form] input')!.value).toBe('');
    events.push(3, { serverId: 'gtnh', type: 'console', command: 'spark profiler', by: 'web:alex (5)', output: ['https://spark.lucko.me/abc'], late: true });
    await render();
    expect(entries(el)).toEqual([
      '> list | discord:bob (2) | 1 player online',
      '> spark profiler | web:alex (5) | Profiler started',
      '> spark profiler (later) | web:alex (5) | https://spark.lucko.me/abc',
    ]);
  });

  it('explains offline, timed out and empty commands', async () => {
    const { backend, el, render } = await setup('/gtnh/console');
    const alert = () => el.querySelector('[role=alert]')?.textContent?.trim();
    for (const [status, body, shown] of [
      [409, 'GTNH is offline', 'GTNH is offline: the command wasn\'t run.'],
      [502, 'Command timed out', 'No answer from GTNH: Command timed out'],
      [400, 'Give a command', 'Give a command.'],
    ] as const) {
      submit(el, 'list');
      backend.expectOne('/api/servers/gtnh/command').flush(body, { status, statusText: 'Error' });
      await render();
      expect(alert()).toBe(shown);
    }
  });

  it('has no Console section for a server without the mod', async () => {
    const { el, tabs } = await setup('/site/console', NO_MOD);
    expect(tabs()).not.toContain('Console');
    expect(el.querySelector('[data-console-form]')).toBeNull();
  });
});

describe('server restarts', () => {
  const PENDING: PendingRestart = { at: new Date(2026, 8, 27, 18, 30).getTime(), by: 'bob', stop: false };
  const restartText = (el: HTMLElement) => el.querySelector('[data-restart-pending]')?.textContent?.replace(/\s+/g, ' ').trim();

  it('schedules a countdown restart in whole minutes, shows it, and cancels it', async () => {
    const { backend, el, render } = await setup('/gtnh');
    const minutes = el.querySelector<HTMLInputElement>('[data-restart-form] input')!;
    minutes.value = '10';
    el.querySelector('[data-restart-form]')!.dispatchEvent(new Event('submit'));
    const req = backend.expectOne('/api/servers/gtnh/restart');
    expect(req.request.body).toEqual({ minutes: 10 });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await debounce();
    backend.expectOne('/api/servers/gtnh').flush(detail({ ...CARD, restart: { ...PENDING, by: 'alex' } }));
    await render();
    expect(restartText(el)).toBe('Restart at 18:30:00 by alex');

    el.querySelector<HTMLButtonElement>('[data-restart-cancel]')!.click();
    backend.expectOne('/api/servers/gtnh/restart/cancel').flush(null, { status: 204, statusText: 'No Content' });
    await debounce();
    backend.expectOne('/api/servers/gtnh').flush(detail(CARD));
    await render();
    expect(restartText(el)).toBeUndefined();
  });

  it("shows the hub's 409 when one is already pending", async () => {
    const { backend, el, render } = await setup('/gtnh');
    el.querySelector('[data-restart-form]')!.dispatchEvent(new Event('submit'));
    backend.expectOne('/api/servers/gtnh/restart').flush('A restart is already scheduled: cancel it first.', { status: 409, statusText: 'Conflict' });
    await render();
    expect(el.querySelector('[role=alert]')?.textContent?.trim()).toBe('A restart is already scheduled: cancel it first.');
  });

  it('shows a countdown scheduled elsewhere, a service stop included, from the stream', async () => {
    const { backend, events, el, render } = await setup('/gtnh');
    events.push(1, { serverId: 'gtnh', type: 'notice', severity: 'info', kind: 'restartScheduled', ms: 300_000, by: 'bob', stop: true });
    await debounce();
    backend.expectOne('/api/servers/gtnh').flush(detail({ ...CARD, restart: { ...PENDING, stop: true } }));
    await render();
    expect(restartText(el)).toBe('Stop at 18:30:00 by bob');
  });
});

describe('server stats section', () => {
  const H = 3_600_000;
  const TOP: ServerDetail['top'] = {
    day: [{ player: 'Steve', ms: 2 * H + 5 * 60_000 }, { player: 'Alex', ms: 45_000 }],
    week: [{ player: 'Steve', ms: 30 * H }],
    all: [],
  };
  const lists = (el: HTMLElement) =>
    Object.fromEntries(
      [...el.querySelectorAll('[data-top]')].map((l) => [
        l.getAttribute('data-top'),
        [...l.querySelectorAll('li')].map((li) => li.textContent?.replace(/\s+/g, ' ').trim()),
      ]),
    );
  const lookup = async (el: HTMLElement, name: string) => {
    el.querySelector<HTMLInputElement>('[data-lookup] input')!.value = name;
    el.querySelector('[data-lookup]')!.dispatchEvent(new Event('submit'));
  };
  const found = (el: HTMLElement) => {
    const card = el.querySelector('[data-player]');
    return card ? [...card.querySelectorAll('h3, dt, dd')].map((e) => e.textContent?.trim()).join(' ') : undefined;
  };

  it('lists the most-played for the last day, week and all time, with durations', async () => {
    const { el, tabs } = await setup('/gtnh/stats', CARD, null, { top: TOP });
    expect(tabs()).toContain('Stats');
    expect(lists(el)).toEqual({
      day: ['1. Steve 2 h 5 m', '2. Alex 45 s'],
      week: ['1. Steve 1 d 6 h'],
      all: ['No playtime recorded.'],
    });
  });

  it('looks a player up: playtime and last seen, online or not; a name never seen is said so', async () => {
    const { backend, el, render } = await setup('/gtnh/stats', CARD, null, { top: TOP });
    await lookup(el, 'Steve');
    backend.expectOne('/api/servers/gtnh/players/Steve').flush({ found: true, player: 'Steve', totalMs: 30 * H, weekMs: 3 * H, lastSeen: { online: true } } satisfies PlayerAnswer);
    await render();
    expect(found(el)).toBe('Steve Total 1 d 6 h Last 7 days 3 h Last seen online now');

    const seen = new Date(2026, 8, 20, 21, 15).getTime();
    await lookup(el, 'alex');
    backend.expectOne('/api/servers/gtnh/players/alex').flush({ found: true, player: 'Alex', totalMs: 60_000, weekMs: 0, lastSeen: seen } satisfies PlayerAnswer);
    await render();
    expect(found(el)).toBe('Alex Total 1 m Last 7 days 0 s Last seen 2026-09-20 21:15');

    await lookup(el, 'Nobody');
    backend.expectOne('/api/servers/gtnh/players/Nobody').flush('Not Found', { status: 404, statusText: 'Not Found' });
    await render();
    expect(found(el)).toBeUndefined();
    expect(el.querySelector('[data-never]')?.textContent?.trim()).toBe('Nobody: never seen here.');
  });

  it('opens a top player in the lookup', async () => {
    const { backend, el } = await setup('/gtnh/stats', CARD, null, { top: TOP });
    el.querySelector<HTMLButtonElement>('[data-top=day] li button')!.click();
    backend.expectOne('/api/servers/gtnh/players/Steve');
  });
});

describe('server backups section', () => {
  const GB = 1024 ** 3;
  const BACKUPS: BackupsAnswer = {
    configured: true,
    backups: [
      { name: '2026-09-27-06-00-00.zip', size: 3 * GB, mtimeMs: new Date(2026, 8, 27, 6, 5).getTime() },
      { name: '2026-09-26-06-00-00.zip', size: 2.5 * GB, mtimeMs: new Date(2026, 8, 26, 6, 4).getTime() },
    ],
    free: 40 * GB,
    growth: 0.5 * GB,
    minFree: 10 * GB,
  };
  const rows = (el: HTMLElement) =>
    [...el.querySelectorAll('[data-backup]')].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent?.trim()));
  const summary = (el: HTMLElement) => [...el.querySelectorAll('[data-backup-summary] dd')].map((d) => d.textContent?.trim());

  it('lists backups newest first with sizes, the total, free space and growth', async () => {
    const { el, tabs } = await setup('/gtnh/backups', CARD, null, { backups: BACKUPS });
    expect(tabs()).toContain('Backups');
    expect(rows(el)).toEqual([
      ['2026-09-27-06-00-00.zip', '2026-09-27 06:05', '3.0 GB'],
      ['2026-09-26-06-00-00.zip', '2026-09-26 06:04', '2.5 GB'],
    ]);
    expect(summary(el)).toEqual(['2', '5.5 GB', '40.0 GB', '+512.0 MB/day']);
    expect(el.querySelector('[data-low-space]')).toBeNull();
  });

  it('warns when free space is under the minimum', async () => {
    const { el } = await setup('/gtnh/backups', CARD, null, { backups: { ...BACKUPS, free: 4 * GB } });
    expect(el.querySelector('[data-low-space]')?.textContent).toContain('under the 10.0 GB minimum');
  });

  it('has no Backups section without a backup folder', async () => {
    const { el, tabs } = await setup('/gtnh/backups');
    expect(tabs()).not.toContain('Backups');
    expect(el.querySelector('[data-backup-start]')).toBeNull();
  });

  it("starts a backup and shows the command's reply; a finished notice refreshes the list", async () => {
    const { backend, events, el, render } = await setup('/gtnh/backups', CARD, null, { backups: BACKUPS });
    el.querySelector<HTMLButtonElement>('[data-backup-start]')!.click();
    const req = backend.expectOne('/api/servers/gtnh/backup');
    expect(req.request.method).toBe('POST');
    req.flush({ output: ['Backup started'] });
    await render();
    expect(el.querySelector('[data-backup-reply]')?.textContent?.trim()).toBe('Backup started');

    events.push(1, { serverId: 'gtnh', type: 'notice', severity: 'good', kind: 'backupFinished', detail: 'done' });
    await debounce();
    const newer = { name: '2026-09-27-18-00-00.zip', size: GB, mtimeMs: new Date(2026, 8, 27, 18, 1).getTime() };
    backend.expectOne('/api/servers/gtnh').flush(detail(CARD, { backups: { ...BACKUPS, backups: [newer, ...BACKUPS.backups] } }));
    await render();
    expect(rows(el).map((r) => r[0])).toEqual(['2026-09-27-18-00-00.zip', '2026-09-27-06-00-00.zip', '2026-09-26-06-00-00.zip']);
  });

  it('explains offline: the button is disabled, and a 409 is shown', async () => {
    const offline = await setup('/gtnh/backups', { ...CARD, online: false }, null, { backups: BACKUPS });
    expect(offline.el.querySelector<HTMLButtonElement>('[data-backup-start]')!.disabled).toBe(true);
    expect(offline.el.textContent).toContain('GTNH is offline: a backup needs it running.');
    TestBed.resetTestingModule();

    const { backend, el, render } = await setup('/gtnh/backups', CARD, null, { backups: BACKUPS });
    el.querySelector<HTMLButtonElement>('[data-backup-start]')!.click();
    backend.expectOne('/api/servers/gtnh/backup').flush('GTNH is offline', { status: 409, statusText: 'Conflict' });
    await render();
    expect(el.querySelector('[role=alert]')?.textContent?.trim()).toBe('GTNH is offline: a backup needs it running.');
  });
});

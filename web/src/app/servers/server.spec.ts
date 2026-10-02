import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { By } from '@angular/platform-browser';
import type { BackupsAnswer, PendingRestart, PlayerAnswer, ServerCard, ServerDetail, ServerHistory, ServiceStatus } from '@hub/api';
import { TimeSeries } from '../chart';
import { FETCH, RETRY_MS } from '../events';
import { Feedback } from '../feedback';
import { dialog, dialogButton, fakeEvents, settle } from '../testing';
import routes from './routes';

const CARD: ServerCard = {
  lagging: false,
  service: null,
  id: 'gtnh',
  name: 'GTNH',
  online: true,
  hung: false,
  tps: 20,
  players: ['Steve'],
  uptimeDay: 1,
  restart: null,
  features: { chat: true, tps: true, quests: true },
  packUpdate: null,
};
const NO_MOD: ServerCard = { ...CARD, id: 'site', name: 'Website', tps: null, players: [], features: { chat: false, tps: false, quests: false } };

/** A server's detail, as the hub answers it, with nothing in it but the card. */
const detail = (card: ServerCard, more: Partial<ServerDetail> = {}) =>
  ({ card, service: null, top: { day: [], week: [], all: [] }, backups: { configured: false }, pack: false, ...more }) as ServerDetail;

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
  /** Each chat line's text, without its time. */
  const chat = () =>
    [...el.querySelectorAll('[data-chat] li')].map((li) => {
      const line = li.cloneNode(true) as Element;
      line.querySelector('time')?.remove();
      return text(line);
    });
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
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }],
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

describe('server chat section', () => {
  it('shows recent chat from the replay, then live lines, for this server only', async () => {
    const { events, render, chat } = await setup('/gtnh/chat');
    events.push(1, { serverId: 'gtnh', type: 'join', player: 'Steve' });
    events.push(2, { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' });
    events.push(3, { serverId: 'other', type: 'chat', player: 'Alex', message: 'elsewhere' });
    events.push(4, { serverId: 'gtnh', type: 'tps', tps: 19 });
    await render();
    expect(chat()).toEqual(['Steve joined', 'Steve: hi']);
    events.push(5, { serverId: 'gtnh', type: 'say', author: 'alex', message: 'hello from Discord', source: 'discord' });
    events.push(6, { serverId: 'gtnh', type: 'death', player: 'Steve', message: 'Steve fell' });
    await render();
    expect(chat()).toEqual(['Steve joined', 'Steve: hi', 'alex Discord: hello from Discord', 'Steve fell']);
  });

  it('tags each sent line with where it came from, and leaves game chat untagged', async () => {
    const { el, events, render } = await setup('/gtnh/chat');
    events.push(1, { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' });
    events.push(2, { serverId: 'gtnh', type: 'say', author: 'bob', message: 'from Discord', source: 'discord' });
    events.push(3, { serverId: 'gtnh', type: 'say', author: 'alex', message: 'from here', source: 'dashboard', avatar: 'https://x/a.png' });
    await render();
    const tags = [...el.querySelectorAll('[data-chat] li')].map((li) => li.querySelector('[data-source]')?.textContent?.trim() ?? null);
    expect(tags).toEqual([null, 'Discord', 'Dashboard']);
  });

  it("starts each line with its local time, the day too before today, and the full date on hover", async () => {
    // Local-time dates, so the expected times hold in any zone.
    vi.useFakeTimers({ now: new Date(2026, 8, 30, 15, 0), toFake: ['Date'] });
    try {
      const { el, events, render } = await setup('/gtnh/chat');
      const earlier = new Date(2026, 8, 29, 23, 30).getTime();
      const today = new Date(2026, 8, 30, 9, 5).getTime();
      events.push(1, { serverId: 'gtnh', type: 'join', player: 'Steve' }, earlier);
      events.push(2, { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' }, today);
      await render();
      const times = [...el.querySelectorAll('[data-chat] li time')];
      expect(times.map((t) => t.textContent?.trim())).toEqual(['29 Sep 23:30', '09:05']);
      expect(times.map((t) => t.getAttribute('datetime'))).toEqual([new Date(earlier).toISOString(), new Date(today).toISOString()]);
      expect(times[1]!.getAttribute('title')).toBe('Wednesday 30 September 2026, 09:05:00');
    } finally {
      vi.useRealTimers();
    }
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
        [...l.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim()).join(' ')),
      ]),
    );
  const lookup = async (el: HTMLElement, name: string) => {
    el.querySelector<HTMLInputElement>('[data-lookup] input')!.value = name;
    el.querySelector('[data-lookup]')!.dispatchEvent(new Event('submit'));
  };
  const found = (el: Element) => {
    const card = el.querySelector('[data-player]');
    return card ? [...card.querySelectorAll('h3, dt, dd')].map((e) => e.textContent?.trim()).join(' ') : undefined;
  };
  const STEVE: PlayerAnswer = { found: true, player: 'Steve', totalMs: 30 * H, weekMs: 3 * H, lastSeen: { online: true } };

  it('lists the most-played for the last day, week and all time, with durations', async () => {
    const { el, tabs } = await setup('/gtnh/players', CARD, null, { top: TOP });
    expect(tabs()).toContain('Players');
    expect(lists(el)).toEqual({
      day: ['1 Steve 2 h 5 m', '2 Alex 45 s'],
      week: ['1 Steve 1 d 6 h'],
      all: ['No playtime recorded.'],
    });
  });

  it('says what goes here while nobody has played', async () => {
    const { el } = await setup('/gtnh/players');
    expect(el.querySelector('[data-empty]')?.textContent).toContain('Nobody has played yet');
    expect(el.querySelector('[data-top]')).toBeNull();
  });

  it('shows one list at a time on a phone, chosen with the Day / Week / All control', async () => {
    const { el, render } = await setup('/gtnh/players', CARD, null, { top: TOP });
    const hidden = () => [...el.querySelectorAll('[data-list]')].filter((l) => l.classList.contains('max-sm:hidden')).map((l) => l.getAttribute('data-list'));
    expect(hidden()).toEqual(['week', 'all']);
    el.querySelector<HTMLButtonElement>('[data-show=week]')!.click();
    await render();
    expect(hidden()).toEqual(['day', 'all']);
  });

  it('looks a player up as a card: playtime and last seen, online or not; a name never seen is said so', async () => {
    const { backend, el, render } = await setup('/gtnh/players', CARD, null, { top: TOP });
    await lookup(el, 'Steve');
    await render();
    expect(el.querySelector('[data-skeleton]')).not.toBeNull();
    backend.expectOne('/api/servers/gtnh/players/Steve').flush(STEVE);
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
    const { backend, el } = await setup('/gtnh/players', CARD, null, { top: TOP });
    el.querySelector<HTMLButtonElement>('[data-top=day] button')!.click();
    backend.expectOne('/api/servers/gtnh/players/Steve');
  });

  describe('player card anywhere', () => {
    const card = () => found(dialog()!);

    it('opens from a name in the Overview’s online list', async () => {
      const { backend, el, render } = await setup('/gtnh');
      el.querySelector<HTMLButtonElement>('[data-player-name] button')!.click();
      await render();
      backend.expectOne('/api/servers/gtnh/players/Steve').flush(STEVE);
      await render();
      expect(card()).toBe('Steve Total 1 d 6 h Last 7 days 3 h Last seen online now');
      dialogButton('cancel').click();
    });

    it('opens from a name in chat, and says when the name was never seen', async () => {
      const { backend, events, el, render } = await setup('/gtnh/chat');
      events.push(1, { serverId: 'gtnh', type: 'chat', player: 'Nobody', message: 'hi' });
      await render();
      el.querySelector<HTMLButtonElement>('[data-chat] button')!.click();
      await render();
      backend.expectOne('/api/servers/gtnh/players/Nobody').flush('Not Found', { status: 404, statusText: 'Not Found' });
      await render();
      expect(dialog()?.querySelector('[data-never]')?.textContent?.trim()).toBe('Nobody: never seen here.');
      dialogButton('cancel').click();
    });
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
    [...el.querySelectorAll('[data-backup]')].map((r) => [...r.querySelectorAll('td')].slice(0, 3).map((td) => td.textContent?.trim()));
  const tiles = (el: HTMLElement) => Object.fromEntries([...el.querySelectorAll('[data-tile]')].map((t) => [t.getAttribute('data-tile'), t.querySelector('[data-value]')?.textContent?.trim()]));

  it('lists backups newest first with sizes, and shows the count, total, free space and growth as tiles', async () => {
    const { el, tabs } = await setup('/gtnh/backups', CARD, null, { backups: BACKUPS });
    expect(tabs()).toContain('Backups');
    expect(rows(el)).toEqual([
      ['2026-09-27-06-00-00.zip', '2026-09-27 06:05', '3.0 GB'],
      ['2026-09-26-06-00-00.zip', '2026-09-26 06:04', '2.5 GB'],
    ]);
    expect(tiles(el)).toEqual({ count: '2', total: '5.5 GB', free: '40.0 GB', growth: '+512.0 MB/day' });
    expect(el.querySelector('[data-tile=free]')!.getAttribute('data-state')).toBe('ok');
  });

  it('turns Free amber when it is under the minimum', async () => {
    const { el } = await setup('/gtnh/backups', CARD, null, { backups: { ...BACKUPS, free: 4 * GB } });
    const free = el.querySelector('[data-tile=free]')!;
    expect(free.getAttribute('data-state')).toBe('warn');
    expect(free.querySelector('[data-value]')!.classList).toContain('text-status-warn');
    expect(free.textContent).toContain('under the 10.0 GB minimum');
  });

  it('has no Backups section without a backup folder', async () => {
    const { el, tabs } = await setup('/gtnh/backups');
    expect(tabs()).not.toContain('Backups');
    expect(el.querySelector('[data-backup-start]')).toBeNull();
  });

  it('says there are no backups yet, with a Start backup action', async () => {
    const { backend, el, render } = await setup('/gtnh/backups', CARD, null, { backups: { ...BACKUPS, backups: [] } });
    expect(el.querySelector('[data-empty]')?.textContent).toContain('No backups yet');
    el.querySelector<HTMLButtonElement>('[data-backup-start-empty]')!.click();
    backend.expectOne('/api/servers/gtnh/backup').flush({ output: [] });
    await render();
  });

  it('starts a backup without asking, shows it running from the live feed, and a finished notice ends it and refreshes the list', async () => {
    const { backend, events, el, render } = await setup('/gtnh/backups', CARD, null, { backups: BACKUPS });
    el.querySelector<HTMLButtonElement>('[data-backup-start]')!.click();
    expect(dialog()).toBeNull();
    const req = backend.expectOne('/api/servers/gtnh/backup');
    expect(req.request.method).toBe('POST');
    req.flush({ output: ['Backup started'] });
    await render();
    // The command's reply text isn't shown; the tab shows the backup running.
    expect(el.textContent).not.toContain('Backup started');
    expect(el.querySelector('[data-progress]')?.textContent).toContain('Backup running');
    expect(el.querySelector<HTMLButtonElement>('[data-backup-start]')!.disabled).toBe(true);

    events.push(1, { serverId: 'gtnh', type: 'notice', severity: 'good', kind: 'backupFinished', detail: 'done' });
    await debounce();
    const newer = { name: '2026-09-27-18-00-00.zip', size: GB, mtimeMs: new Date(2026, 8, 27, 18, 1).getTime() };
    backend.expectOne('/api/servers/gtnh').flush(detail(CARD, { backups: { ...BACKUPS, backups: [newer, ...BACKUPS.backups] } }));
    await render();
    expect(el.querySelector('[data-progress]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-backup-start]')!.disabled).toBe(false);
    expect(rows(el).map((r) => r[0])).toEqual(['2026-09-27-18-00-00.zip', '2026-09-27-06-00-00.zip', '2026-09-26-06-00-00.zip']);
  });

  it('explains offline: the button is disabled, and a 409 is a toast', async () => {
    const offline = await setup('/gtnh/backups', { ...CARD, online: false }, null, { backups: BACKUPS });
    expect(offline.el.querySelector<HTMLButtonElement>('[data-backup-start]')!.disabled).toBe(true);
    expect(offline.el.textContent).toContain('GTNH is offline: a backup needs it running.');
    TestBed.resetTestingModule();

    const { backend, el, render } = await setup('/gtnh/backups', CARD, null, { backups: BACKUPS });
    const failed = vi.spyOn(TestBed.inject(Feedback), 'failed');
    el.querySelector<HTMLButtonElement>('[data-backup-start]')!.click();
    backend.expectOne('/api/servers/gtnh/backup').flush('GTNH is offline', { status: 409, statusText: 'Conflict' });
    await render();
    expect(failed).toHaveBeenCalledWith('Starting the backup', expect.objectContaining({ error: 'GTNH is offline' }));
    expect(el.querySelector('[data-progress]')).toBeNull();
  });
});

describe('restoring a backup', () => {
  const GB = 1024 ** 3;
  const BACKUPS: BackupsAnswer = {
    configured: true,
    backups: [{ name: '2026-09-27-06-00-00.zip', size: GB, mtimeMs: 0 }],
    free: 40 * GB,
    growth: null,
    minFree: 10 * GB,
  };
  const GTNH: ServiceStatus = { id: 'gtnh', unit: 'gtnh.service', state: 'active', sub: 'running', checks: [] };
  /** Opens the first row's ⋯ menu; Restore is in the overlay. */
  const openMenu = async (page: { el: HTMLElement; render: () => Promise<void> }) => {
    page.el.querySelector<HTMLButtonElement>('[data-backup-more]')!.click();
    await page.render();
  };
  const restoreButton = () => document.querySelector<HTMLButtonElement>('[data-restore]')!;
  const why = () => document.querySelector('[data-restore-why]')?.textContent?.trim();
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  it('is disabled with a reason until the linked service is stopped, following live state', async () => {
    const page = await setup('/gtnh/backups', { ...CARD, online: false }, GTNH, { backups: BACKUPS });
    await openMenu(page);
    expect(restoreButton().disabled).toBe(true);
    expect(why()).toBe('To restore a backup, stop gtnh.service first.');
    page.events.push(1, { target: 'service', id: 'gtnh', type: 'state', state: 'inactive', sub: 'dead' });
    await page.render();
    expect(restoreButton().disabled).toBe(false);
    expect(why()).toBeUndefined();
  });

  it('is disabled without a linked service', async () => {
    const page = await setup('/gtnh/backups', CARD, null, { backups: BACKUPS });
    await openMenu(page);
    expect(restoreButton().disabled).toBe(true);
    expect(why()).toContain('no linked service');
  });

  it("asks for the server's name before restoring, then reports it as a toast, not the script's output", async () => {
    const stopped = { ...GTNH, state: 'inactive', sub: 'dead' };
    const page = await setup('/gtnh/backups', { ...CARD, online: false }, stopped, { backups: BACKUPS });
    const { backend, el, render } = page;
    await openMenu(page);
    restoreButton().click();
    await render();
    expect(dialog()?.textContent).toContain('pre-restore');
    const confirm = dialogButton('ok');
    expect(confirm.disabled).toBe(true);
    type(document.querySelector<HTMLInputElement>('[data-confirm-typed]')!, 'gtnh');
    await render();
    expect(confirm.disabled).toBe(true);
    type(document.querySelector<HTMLInputElement>('[data-confirm-typed]')!, 'GTNH');
    await render();
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await render();
    const req = backend.expectOne('/api/servers/gtnh/restore');
    expect(req.request.body).toEqual({ name: '2026-09-27-06-00-00.zip' });
    expect(el.querySelector('[data-progress]')?.textContent).toContain('Restoring 2026-09-27-06-00-00.zip');
    req.flush({ output: ['Restored 2026-09-27-06-00-00.zip into /srv/GTNH/World.', 'Next: sudo systemctl start gtnh.service'] });
    await render();
    expect(el.querySelector('[data-progress]')).toBeNull();
    expect(el.textContent).not.toContain('Next: sudo systemctl');
  });

  it("shows the hub's refusal", async () => {
    const stopped = { ...GTNH, state: 'inactive', sub: 'dead' };
    const page = await setup('/gtnh/backups', { ...CARD, online: false }, stopped, { backups: BACKUPS });
    const { backend, render } = page;
    const failed = vi.spyOn(TestBed.inject(Feedback), 'failed');
    await openMenu(page);
    restoreButton().click();
    await render();
    type(document.querySelector<HTMLInputElement>('[data-confirm-typed]')!, 'GTNH');
    await render();
    dialogButton('ok').click();
    await render();
    backend.expectOne('/api/servers/gtnh/restore').flush('The restore failed: restore-backup: unzip failed', { status: 502, statusText: 'Bad Gateway' });
    await render();
    expect(failed).toHaveBeenCalledWith('Restoring 2026-09-27-06-00-00.zip', expect.objectContaining({ error: 'The restore failed: restore-backup: unzip failed' }));
  });
});

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { DeploysAnswer, HostSample, Integrations, Release } from '@hub/api';
import { TimeSeries } from '../chart';
import { FETCH, RETRY_MS } from '../events';
import { dialog, dialogButton, fakeEvents, settle } from '../testing';
import Host from './host';

const GB = 1024 ** 3;
const SAMPLE: HostSample = {
  ts: 1,
  cpu: 0.25,
  load: [0.5, 0.25, 0.125],
  memory: { used: 4 * GB, total: 16 * GB },
  disks: [{ mount: '/', free: 50 * GB, total: 100 * GB }],
};
const EARLIER: HostSample = { ...SAMPLE, ts: 0, cpu: 0.5, disks: [...SAMPLE.disks, { mount: '/data', free: 1 * GB, total: 2 * GB }] };

const ON: Integrations = { minecraft: true, discord: false, web: true, checks: false, host: true, systemd: false, github: false };

async function setup(sample: HostSample = SAMPLE, answer = true, on = ON) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: FETCH, useValue: events.fetch },
      { provide: RETRY_MS, useValue: 0 },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  const backend = TestBed.inject(HttpTestingController);
  const render = async () => (await settle(), await fixture.whenStable());
  await render();
  backend.expectOne('/api/integrations').flush(on);
  if (answer) backend.expectOne('/api/host').flush({ id: 'oracle', sample });
  const el = fixture.nativeElement as HTMLElement;
  const tiles = () => [...el.querySelectorAll('[data-tile]')].map((t) => `${t.getAttribute('data-tile')}:${t.getAttribute('data-state')}`);
  const text = (sel: string) => el.querySelector(sel)?.textContent?.trim();
  /** What the chart titled `title` draws: each series' name and points. */
  const chart = (title: string) =>
    (fixture.debugElement.query(By.css(`[data-chart="${title}"] app-time-series`)).componentInstance as TimeSeries)
      .series()
      .map((s) => [s.name, s.points]);
  const period = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('[data-period]')].find((b) => b.textContent?.trim() === label)!.click();
  return { fixture, events, backend, el, render, text, tiles, chart, period };
}

describe('host page', () => {
  it('shows a tile for CPU, load, memory and each disk, then updates them from each live sample', async () => {
    const { events, backend, render, text, tiles } = await setup({ ...SAMPLE, disks: [...SAMPLE.disks, { mount: '/data', free: 30 * GB, total: 100 * GB }] });
    backend.expectOne('/api/host/samples?hours=24').flush([]);
    await render();
    expect(text('h1')).toBe('Host oracle');
    expect(tiles()).toEqual(['cpu:ok', 'load:ok', 'memory:ok', 'disk:/:ok', 'disk:/data:ok']);
    expect(text('[data-value=cpu]')).toBe('25%');
    expect(text('[data-value=load]')).toBe('0.50 · 0.25 · 0.13');
    expect(text('[data-value=memory]')).toBe('25%');
    expect(text('[data-detail=memory]')).toBe('4.0 of 16.0 GB');
    expect(text('[data-value="disk:/"]')).toBe('50.0 GB free');

    const next = { ...SAMPLE, ts: 2, cpu: 0.9, memory: { used: 15 * GB, total: 16 * GB } };
    events.push(1, { target: 'host', id: 'oracle', type: 'sample', sample: next });
    await render();
    expect(text('[data-value=cpu]')).toBe('90%');
    expect(text('[data-detail=memory]')).toBe('15.0 of 16.0 GB');
    expect(tiles().slice(0, 3)).toEqual(['cpu:warn', 'load:ok', 'memory:warn']);
  });

  it('warns amber, then red, past a threshold; a disk when under 20%, then 10%, free', async () => {
    const low = { ...SAMPLE, cpu: 0.97, disks: [{ mount: '/', free: 15 * GB, total: 100 * GB }, { mount: '/data', free: 5 * GB, total: 100 * GB }, { mount: '/big', free: 90 * GB, total: 100 * GB }] };
    const { backend, render, tiles } = await setup(low);
    backend.expectOne('/api/host/samples?hours=24').flush([]);
    await render();
    expect(tiles()).toEqual(['cpu:down', 'load:ok', 'memory:ok', 'disk:/:warn', 'disk:/data:down', 'disk:/big:ok']);
  });

  it('shows skeleton tiles until the first answer', async () => {
    const { el, backend, render } = await setup(SAMPLE, false);
    expect(el.querySelector('[data-skeleton]')).not.toBeNull();
    backend.expectOne('/api/host').flush({ id: 'oracle', sample: SAMPLE });
    await render();
    expect(el.querySelector('[data-skeleton]')).toBeNull();
    backend.expectOne('/api/host/samples?hours=24').flush([]);
  });

  it('graphs the last 24 hours, then the chosen period, a series per mount', async () => {
    const { backend, render, chart, period } = await setup();
    backend.expectOne('/api/host/samples?hours=24').flush([EARLIER, SAMPLE]);
    await render();
    expect(chart('CPU')).toEqual([['CPU', [[0, 0.5], [1, 0.25]]]]);
    expect(chart('Load')).toEqual([['1 min', [[0, 0.5], [1, 0.5]]]]);
    expect(chart('Memory')).toEqual([['Used', [[0, 0.25], [1, 0.25]]]]);
    expect(chart('Disk free')).toEqual([
      ['/', [[0, 50 * GB], [1, 50 * GB]]],
      ['/data', [[0, 1 * GB]]],
    ]);

    // A slow long period is dropped when a shorter one is chosen before it answers.
    period('90 d');
    await render();
    const slow = backend.expectOne('/api/host/samples?hours=2160');
    period('1 h');
    await render();
    expect(slow.cancelled).toBe(true);
    backend.expectOne('/api/host/samples?hours=1').flush([SAMPLE]);
    await render();
    expect(chart('CPU')).toEqual([['CPU', [[1, 0.25]]]]);
  });

  it('appends each live sample to the graph without fetching again', async () => {
    const { events, backend, render, chart } = await setup();
    backend.expectOne('/api/host/samples?hours=24').flush([EARLIER, SAMPLE]);
    await render();
    events.push(1, { target: 'host', id: 'oracle', type: 'sample', sample: SAMPLE }); // the replay's latest: already drawn
    events.push(2, { target: 'host', id: 'oracle', type: 'sample', sample: { ...SAMPLE, ts: 2, cpu: 1 } });
    await render();
    expect(chart('CPU')).toEqual([['CPU', [[0, 0.5], [1, 0.25], [2, 1]]]]);
    backend.verify();
  });
});

const DAY = 24 * 60 * 60_000;
const rel = (tag: string, daysAgo = 1): Release => ({ tag, publishedAt: Date.now() - daysAgo * DAY, assets: [] });
const ANSWER: DeploysAnswer = {
  hub: { running: 'hub-v2.5.0', latest: 'hub-v2.6.0', releases: [rel('hub-v2.6.0'), rel('hub-v2.5.0'), rel('hub-v2.4.0')] },
  web: { running: 'web-v0.5.0', latest: 'web-v0.5.0', releases: [rel('web-v0.5.0'), rel('web-v0.4.1')] },
  mod: { latest: 'mod-v1.4.0', releases: [rel('mod-v1.4.0'), rel('mod-v1.3.0')], servers: [{ id: 'gtnh', name: 'GTNH', running: 'mod-v1.3.0' }] },
  checkedAt: Date.now(),
  error: null,
  newerAfterDays: 14,
  history: [{ id: 1, part: 'web', target: 'production', from: 'web-v0.4.1', to: 'web-v0.5.0', by: 'web:alex (5)', started: 1, finished: 2, outcome: 'ok', log: 'installed' }],
  older: false,
};

describe('host page releases', () => {
  async function releases(answer: DeploysAnswer = ANSWER) {
    const h = await setup(SAMPLE, true, { ...ON, github: true });
    h.backend.expectOne('/api/host/samples?hours=24').flush([]);
    await h.render();
    h.backend.expectOne('/api/deploys').flush(answer);
    await h.render();
    const row = (key: string) => h.el.querySelector<HTMLElement>(`[data-row="${key}"]`)!;
    const rowText = (key: string) => row(key).textContent!.replace(/\s+/g, ' ').trim();
    /** Opens a row's picker, picks `tag` (else the preselected latest) and asks to deploy. */
    const deploy = async (key: string, tag?: string) => {
      row(key).querySelector<HTMLButtonElement>('[data-deploy]')!.click();
      await h.render();
      const select = row(key).querySelector<HTMLSelectElement>('[data-pick]')!;
      if (tag) {
        select.value = tag;
        select.dispatchEvent(new Event('change'));
        await h.render();
      }
      row(key).querySelector<HTMLButtonElement>('[data-next]')!.click();
      await h.render();
      return select;
    };
    return { ...h, row, rowText, deploy };
  }

  afterEach(() => dialog() && dialogButton('cancel').click());

  it('shows running against latest for the hub, the dashboard and each Mod, with a badge when newer', async () => {
    const { row, text, el } = await releases();
    const shown = (key: string) => ['[data-running]', '[data-latest]', '[data-newer]'].map((sel) => row(key).querySelector(sel)?.textContent?.trim());
    expect(shown('hub')).toEqual(['hub-v2.5.0', 'hub-v2.6.0', 'newer available']);
    expect(shown('web')).toEqual(['web-v0.5.0', 'web-v0.5.0', undefined]);
    expect(shown('mod:gtnh')).toEqual(['mod-v1.3.0', 'mod-v1.4.0', 'newer available']);
    expect(text('[data-row="mod:gtnh"] span')).toBe('Mod on GTNH');
    expect(text('[data-history] [data-outcome]')).toBe('ok');
    expect(el.querySelector('[data-history]')!.textContent).toContain('web-v0.4.1 → web-v0.5.0');
    expect(text('[data-log]')).toBe('installed');
  });

  it('a dev hub has no badge, and a failed check shows its error', async () => {
    const { row, text } = await releases({ ...ANSWER, hub: { ...ANSWER.hub, running: 'dev' }, error: 'GitHub: HTTP 503' });
    expect(row('hub').querySelector('[data-newer]')).toBeNull();
    expect(text('[data-error]')).toBe('Last check failed: GitHub: HTTP 503');
  });

  it('Deploy picks the latest, marks older releases, names the change and posts once confirmed', async () => {
    const { deploy, backend, render } = await releases();
    const select = await deploy('hub');
    expect([...select.options].map((o) => o.textContent)).toEqual(['hub-v2.6.0', 'hub-v2.5.0 (running)', 'hub-v2.4.0 (older)']);
    expect(dialog()!.textContent).toContain('Deploy hub v2.5.0 → v2.6.0?');
    dialogButton('ok').click();
    await render();
    const req = backend.expectOne('/api/deploys');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ part: 'hub', tag: 'hub-v2.6.0' });
  });

  it('going back says so', async () => {
    const { deploy } = await releases();
    await deploy('hub', 'hub-v2.4.0');
    expect(dialog()!.textContent).toContain('Deploy hub v2.5.0 → v2.4.0 (older release)?');
  });

  it('the dashboard posts its part, a Mod its server', async () => {
    const { deploy, backend, render } = await releases();
    await deploy('web', 'web-v0.4.1');
    dialogButton('ok').click();
    await render();
    const web = backend.expectOne((r) => r.method === 'POST' && r.url === '/api/deploys');
    expect(web.request.body).toEqual({ part: 'web', tag: 'web-v0.4.1' });
    web.flush({ id: 2 });
    backend.expectOne('/api/deploys').flush(ANSWER);
    await new Promise((r) => setTimeout(r, 350)); // the first dialog has gone
    await render();
    await deploy('mod:gtnh');
    dialogButton('ok').click();
    await render();
    expect(backend.match((r) => r.method === 'POST' && r.url === '/api/deploys').map((r) => r.request.body)).toEqual([{ part: 'mod', tag: 'mod-v1.4.0', server: 'gtnh' }]);
  });

  it('a running deploy spins on its row, and a live deployFinished brings the outcome', async () => {
    const running = { ...ANSWER.history[0]!, id: 2, part: 'hub' as const, from: 'hub-v2.5.0', to: 'hub-v2.6.0', finished: null, outcome: 'running' as const, log: '' };
    const { events, backend, render, rowText, row, el } = await releases({ ...ANSWER, history: [running, ...ANSWER.history] });
    expect(rowText('hub')).toContain('deploying hub-v2.6.0');
    expect(row('web').querySelector('[data-deploy]')!.hasAttribute('disabled')).toBe(true);
    const finished = { target: 'deploy', id: 'production', type: 'notice', severity: 'good', kind: 'deployFinished', part: 'hub', from: 'hub-v2.5.0', to: 'hub-v2.6.0', outcome: 'ok' } as const;
    events.push(1, finished);
    await new Promise((r) => setTimeout(r, 80));
    backend.expectOne('/api/deploys').flush({ ...ANSWER, hub: { ...ANSWER.hub, running: 'hub-v2.6.0' }, history: [{ ...running, outcome: 'ok', log: 'stayed up' }, ...ANSWER.history] });
    await render();
    expect(row('hub').querySelector('[data-running]')!.textContent).toBe('hub-v2.6.0');
    expect(row('hub').querySelector('[data-newer]')).toBeNull();
    expect(el.querySelector('[data-history] [data-outcome]')!.textContent!.trim()).toBe('ok');
  });

  it('Check now asks the hub to look again', async () => {
    const { el, backend, render, rowText } = await releases();
    el.querySelector<HTMLButtonElement>('[data-check]')!.click();
    const req = backend.expectOne('/api/deploys/check');
    expect(req.request.method).toBe('POST');
    req.flush({ ...ANSWER, web: { ...ANSWER.web, latest: 'web-v0.6.0', releases: [rel('web-v0.6.0', 0), ...ANSWER.web.releases] } });
    await render();
    expect(rowText('web')).toContain('newer available');
  });

  it('has no section with the GitHub integration off', async () => {
    const { el, backend, render } = await setup();
    backend.expectOne('/api/host/samples?hours=24').flush([]);
    await render();
    expect(el.querySelector('[data-releases]')).toBeNull();
    backend.verify();
  });
});

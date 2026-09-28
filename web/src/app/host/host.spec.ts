import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { HostSample } from '@hub/api';
import { TimeSeries } from '../chart';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, settle } from '../testing';
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

async function setup(sample: HostSample = SAMPLE, answer = true) {
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
  return { events, backend, el, render, text, tiles, chart, period };
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

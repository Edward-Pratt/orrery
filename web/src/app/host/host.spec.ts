import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { HostNow, HostSample } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, loggedIn, settle } from '../testing';
import Host from './host';
import { GB, ON, SAMPLE, setup } from './host-testing';

const EARLIER: HostSample = { ...SAMPLE, ts: 0, cpu: 0.5, disks: [...SAMPLE.disks, { mount: '/data', free: 1 * GB, total: 2 * GB }] };

describe('host page', () => {
  it('shows a tile for CPU, load, memory and each disk, then updates them from each live sample', async () => {
    const { events, backend, render, text, tiles } = await setup({ ...SAMPLE, disks: [...SAMPLE.disks, { mount: '/data', free: 30 * GB, total: 100 * GB }] });
    backend.expectOne('/api/hosts/oracle/samples?hours=24').flush([]);
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
    backend.expectOne('/api/hosts/oracle/samples?hours=24').flush([]);
    await render();
    expect(tiles()).toEqual(['cpu:down', 'load:ok', 'memory:ok', 'disk:/:warn', 'disk:/data:down', 'disk:/big:ok']);
  });

  it('shows skeleton tiles until the first answer', async () => {
    const { el, backend, render } = await setup(SAMPLE, false);
    expect(el.querySelector('[data-skeleton]')).not.toBeNull();
    backend.expectOne('/api/hosts').flush([{ id: 'oracle', sample: SAMPLE }]);
    await render();
    expect(el.querySelector('[data-skeleton]')).toBeNull();
    backend.expectOne('/api/hosts/oracle/samples?hours=24').flush([]);
  });

  it('graphs the last 24 hours, then the chosen period, a series per mount', async () => {
    const { backend, render, chart, period } = await setup();
    backend.expectOne('/api/hosts/oracle/samples?hours=24').flush([EARLIER, SAMPLE]);
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
    const slow = backend.expectOne('/api/hosts/oracle/samples?hours=2160');
    period('1 h');
    await render();
    expect(slow.cancelled).toBe(true);
    backend.expectOne('/api/hosts/oracle/samples?hours=1').flush([SAMPLE]);
    await render();
    expect(chart('CPU')).toEqual([['CPU', [[1, 0.25]]]]);
  });

  it('appends each live sample to the graph without fetching again', async () => {
    const { events, backend, render, chart } = await setup();
    backend.expectOne('/api/hosts/oracle/samples?hours=24').flush([EARLIER, SAMPLE]);
    await render();
    events.push(1, { target: 'host', id: 'oracle', type: 'sample', sample: SAMPLE }); // the replay's latest: already drawn
    events.push(2, { target: 'host', id: 'oracle', type: 'sample', sample: { ...SAMPLE, ts: 2, cpu: 1 } });
    await render();
    expect(chart('CPU')).toEqual([['CPU', [[0, 0.5], [1, 0.25], [2, 1]]]]);
    backend.verify();
  });

  it('shows no host picker with one host', async () => {
    const { el, backend, render } = await setup();
    backend.expectOne('/api/hosts/oracle/samples?hours=24').flush([]);
    await render();
    expect(el.querySelector('[data-hosts]')).toBeNull();
  });

  it("picks a host when there is more than one: the hub's own first, then another's tiles and graphs", async () => {
    const VM: HostNow = { id: 'vm', sample: { ...SAMPLE, cpu: 0.75, disks: [{ mount: '/srv', free: 5 * GB, total: 100 * GB }] }, node: null };
    const { el, events, backend, render, text, tiles, chart, period } = await setup(SAMPLE, true, ON, [VM]);
    backend.expectOne('/api/hosts/oracle/samples?hours=24').flush([SAMPLE]);
    await render();
    expect([...el.querySelectorAll('[data-host]')].map((b) => b.textContent?.trim())).toEqual(['oracle', 'vm']);
    expect(text('h1')).toBe('Host oracle');
    expect(text('[data-value=cpu]')).toBe('25%');

    // Another host's live sample changes nothing shown.
    events.push(1, { target: 'host', id: 'vm', type: 'sample', sample: { ...VM.sample!, ts: 2, cpu: 0.5 } });
    await render();
    expect(text('[data-value=cpu]')).toBe('25%');
    expect(chart('CPU')).toEqual([['CPU', [[1, 0.25]]]]);

    el.querySelector<HTMLButtonElement>('[data-host=vm]')!.click();
    await render();
    expect(text('h1')).toBe('Host vm');
    expect(text('[data-value=cpu]')).toBe('50%'); // its newest, from the stream
    expect(tiles()).toEqual(['cpu:ok', 'load:ok', 'memory:ok', 'disk:/srv:down']);
    expect(chart('CPU')).toEqual([['CPU', []]]); // none of oracle's while vm's load
    backend.expectOne('/api/hosts/vm/samples?hours=24').flush([VM.sample!]);
    await render();
    expect(chart('CPU')).toEqual([['CPU', [[1, 0.75]]]]);
    period('1 h');
    await render();
    backend.expectOne('/api/hosts/vm/samples?hours=1').flush([]);
    backend.verify();
  });
});

describe('host page without a sample yet', () => {
  it("says the hub's own first sample comes a minute after the hub starts, an Agent's once it is connected", async () => {
    const events = fakeEvents();
    TestBed.configureTestingModule({
      providers: [loggedIn(), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }, { provide: RETRY_MS, useValue: 0 }],
    });
    const fixture = TestBed.createComponent(Host);
    const backend = TestBed.inject(HttpTestingController);
    const render = async () => (await settle(), await fixture.whenStable());
    await render();
    backend.expectOne('/api/integrations').flush(ON);
    backend.expectOne('/api/hosts').flush([{ id: 'oracle', sample: null }, { id: 'vm', sample: null }]);
    await render();
    backend.expectOne('/api/hosts/oracle/samples?hours=24').flush([]);
    await render();
    const el = fixture.nativeElement as HTMLElement;
    const said = () => el.querySelector('[data-no-sample]')?.textContent?.trim();
    expect(said()).toBe('No sample yet: the first comes a minute after the hub starts.');
    el.querySelector<HTMLButtonElement>('[data-host=vm]')!.click();
    await render();
    expect(said()).toBe('No sample yet: its Agent sends one each minute once it is connected.');
  });
});

describe('host page Node', () => {
  it("shows an Agent's Host's Node, kept through live samples; nothing for the hub's own or an older Agent", async () => {
    const VM: HostNow = { id: 'vm', sample: SAMPLE, node: 'v24.22.2' };
    const OLD: HostNow = { id: 'old', sample: SAMPLE, node: null };
    const { el, events, backend, render, text } = await setup(SAMPLE, true, ON, [VM, OLD]);
    backend.expectOne('/api/hosts/oracle/samples?hours=24').flush([]);
    await render();
    expect(el.querySelector('[data-node]')).toBeNull(); // the hub's own
    el.querySelector<HTMLButtonElement>('[data-host=vm]')!.click();
    await render();
    expect(text('[data-node]')).toBe('Node v24.22.2');
    events.push(1, { target: 'host', id: 'vm', type: 'sample', sample: { ...SAMPLE, ts: 2 } });
    await render();
    expect(text('[data-node]')).toBe('Node v24.22.2');
    el.querySelector<HTMLButtonElement>('[data-host=old]')!.click();
    await render();
    expect(el.querySelector('[data-node]')).toBeNull();
  });
});

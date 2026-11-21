// The host page's test setup, shared by `host.spec.ts` and `releases.spec.ts`: `setup(sample, answer, on, others)` renders
// the page against a fake backend and stream, answering `/api/integrations` with `on` and, when `answer`, `/api/hosts`
// with the hub's own `oracle` (its `sample`) then `others`; `SAMPLE`, `ON` and `GB` with it.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { HostNow, HostSample, Integrations } from '@hub/api';
import { TimeSeries } from '../chart';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, loggedIn, settle } from '../testing';
import Host from './host';

export const GB = 1024 ** 3;
export const SAMPLE: HostSample = {
  ts: 1,
  cpu: 0.25,
  load: [0.5, 0.25, 0.125],
  memory: { used: 4 * GB, total: 16 * GB },
  disks: [{ mount: '/', free: 50 * GB, total: 100 * GB }],
};

export const ON: Integrations = { minecraft: true, discord: false, web: true, checks: false, host: true, systemd: false, github: false, agents: false, library: false, newServer: false };

export async function setup(sample: HostSample = SAMPLE, answer = true, on = ON, others: HostNow[] = []) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [loggedIn(),
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
  if (answer) {
    backend.expectOne('/api/hosts').flush([{ id: 'oracle', sample }, ...others]);
    await render(); // its graphs are asked for once the host is known
  }
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

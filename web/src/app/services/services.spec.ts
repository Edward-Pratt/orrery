import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ServiceStatus } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { Feedback } from '../feedback';
import { fakeEvents, settle } from '../testing';
import Services from './services';

const GTNH: ServiceStatus = { id: 'gtnh', unit: 'gtnh.service', state: 'active', sub: 'running', checks: [] };
const CADDY: ServiceStatus = { id: 'caddy', unit: 'caddy.service', state: 'active', sub: 'running', checks: ['site'] };

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
  const fixture = TestBed.createComponent(Services);
  const backend = TestBed.inject(HttpTestingController);
  backend.expectOne('/api/services').flush([GTNH, CADDY]);
  const render = async () => (await settle(), await fixture.whenStable());
  await render();
  const el = fixture.nativeElement as HTMLElement;
  const text = (id: string, field: string) => el.querySelector(`[data-service=${id}] [data-${field}]`)?.textContent?.replace(/\s+/g, ' ').trim();
  return { events, backend, el, render, text };
}

describe('services page', () => {
  it('lists services with their state and linked checks', async () => {
    const { text } = await setup();
    expect(text('gtnh', 'state')).toBe('active (running)');
    expect(text('gtnh', 'checks')).toBeUndefined();
    expect(text('caddy', 'checks')).toBe('Checks: site');
  });

  it('fetches the services again on a state event', async () => {
    const { events, backend, render, text } = await setup();
    const feedback = TestBed.inject(Feedback);
    const toasted = [vi.spyOn(feedback, 'ok'), vi.spyOn(feedback, 'failed')];
    events.push(1, { target: 'service', id: 'gtnh', type: 'state', state: 'failed', sub: 'failed' });
    await new Promise((r) => setTimeout(r, 80));
    backend.expectOne('/api/services').flush([{ ...GTNH, state: 'failed', sub: 'failed' }, CADDY]);
    await render();
    expect(text('gtnh', 'state')).toBe('failed (failed)');
    // Someone else's action (Discord, another browser) never toasts.
    toasted.forEach((t) => expect(t).not.toHaveBeenCalled());
  });

  it('shows recent logs on demand', async () => {
    const { el, backend, render, text } = await setup();
    el.querySelector<HTMLButtonElement>('[data-service=gtnh] [data-logs-button]')!.click();
    backend.expectOne('/api/services/gtnh/logs').flush({ lines: ['one', 'two'] });
    await render();
    expect(el.querySelector('[data-service=gtnh] [data-logs]')?.textContent).toBe('one\ntwo');
    el.querySelector<HTMLButtonElement>('[data-service=gtnh] [data-logs-button]')!.click();
    await render();
    expect(text('gtnh', 'logs')).toBeUndefined();
    backend.verify();
  });
});

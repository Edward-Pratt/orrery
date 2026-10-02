import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { Integrations } from '@hub/api';
import { routes } from './app.routes';
import { FETCH } from './events';
import { fakeEvents, settle } from './testing';

async function open(url: string, on: Integrations) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: FETCH, useValue: fakeEvents().fetch },
    ],
  });
  const harness = await RouterTestingHarness.create();
  const navigated = harness.navigateByUrl(url);
  await settle();
  TestBed.inject(HttpTestingController).match('/api/integrations').forEach((r) => r.flush(on)); // servers and audit don't ask
  await navigated;
  return harness;
}

describe('routing by enabled integrations', () => {
  it('opens the servers page when Minecraft is on', async () => {
    const harness = await open('/', { minecraft: true, discord: false, web: true, checks: false, host: false, systemd: false, github: false });
    expect(harness.routeNativeElement?.textContent).toContain('Servers');
  });

  it('has no checks route: the services page holds them', () => {
    expect(routes.some((r) => r.path === 'checks')).toBe(false);
  });

  it('opens the host page only when the host integration is on', async () => {
    const on = await open('/host', { minecraft: false, discord: false, web: true, checks: false, host: true, systemd: false, github: false });
    expect(on.routeNativeElement?.textContent).toContain('Host');
    TestBed.resetTestingModule();
    const off = await open('/host', { minecraft: true, discord: false, web: true, checks: false, host: false, systemd: false, github: false });
    expect(off.routeNativeElement?.textContent).toContain('Nothing here');
  });

  it('opens the services page when systemd is on, titled Services', async () => {
    const on = await open('/services', { minecraft: false, discord: false, web: true, checks: false, host: false, systemd: true, github: false });
    expect(on.routeNativeElement?.querySelector('h1')?.textContent).toBe('Services');
  });

  it('opens the services page as Checks when only checks are on', async () => {
    const on = await open('/services', { minecraft: false, discord: false, web: true, checks: true, host: false, systemd: false, github: false });
    expect(on.routeNativeElement?.querySelector('h1')?.textContent).toBe('Checks');
  });

  it('has no services page with neither systemd nor checks', async () => {
    const off = await open('/services', { minecraft: true, discord: false, web: true, checks: false, host: false, systemd: false, github: false });
    expect(off.routeNativeElement?.textContent).toContain('Nothing here');
  });

  it('opens the servers page with Minecraft off too (Staging\'s demo server has no Mod)', async () => {
    const harness = await open('/', { minecraft: false, discord: false, web: true, checks: false, host: true, systemd: false, github: false });
    expect(harness.routeNativeElement?.textContent).toContain('Servers');
  });
});

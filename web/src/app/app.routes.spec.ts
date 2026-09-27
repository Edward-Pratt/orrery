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
  TestBed.inject(HttpTestingController).expectOne('/api/integrations').flush(on);
  await navigated;
  return harness;
}

describe('routing by enabled integrations', () => {
  it('opens the servers page when Minecraft is on', async () => {
    const harness = await open('/', { minecraft: true, discord: false, web: true, checks: false, host: false, systemd: false });
    expect(harness.routeNativeElement?.textContent).toContain('Servers');
  });

  it('opens the checks page only when checks are on', async () => {
    const on = await open('/checks', { minecraft: false, discord: false, web: true, checks: true, host: false, systemd: false });
    expect(on.routeNativeElement?.textContent).toContain('Checks');
    TestBed.resetTestingModule();
    const off = await open('/checks', { minecraft: true, discord: false, web: true, checks: false, host: false, systemd: false });
    expect(off.routeNativeElement?.textContent).toContain('Nothing here');
  });

  it('opens the host page only when the host integration is on', async () => {
    const on = await open('/host', { minecraft: false, discord: false, web: true, checks: false, host: true, systemd: false });
    expect(on.routeNativeElement?.textContent).toContain('Host');
    TestBed.resetTestingModule();
    const off = await open('/host', { minecraft: true, discord: false, web: true, checks: false, host: false, systemd: false });
    expect(off.routeNativeElement?.textContent).toContain('Nothing here');
  });

  it('opens the services page only when systemd is on', async () => {
    const on = await open('/services', { minecraft: false, discord: false, web: true, checks: false, host: false, systemd: true });
    expect(on.routeNativeElement?.textContent).toContain('Services');
    TestBed.resetTestingModule();
    const off = await open('/services', { minecraft: true, discord: false, web: true, checks: false, host: false, systemd: false });
    expect(off.routeNativeElement?.textContent).toContain('Nothing here');
  });

  it('has no servers page when Minecraft is off', async () => {
    const harness = await open('/servers', { minecraft: false, discord: true, web: true, checks: false, host: false, systemd: false });
    expect(harness.routeNativeElement?.textContent).toContain('Nothing here');
  });
});

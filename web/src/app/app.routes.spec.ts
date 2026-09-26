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
    const harness = await open('/', { minecraft: true, discord: false, web: true });
    expect(harness.routeNativeElement?.textContent).toContain('Servers');
  });

  it('has no servers page when Minecraft is off', async () => {
    const harness = await open('/servers', { minecraft: false, discord: true, web: true });
    expect(harness.routeNativeElement?.textContent).toContain('Nothing here');
  });
});

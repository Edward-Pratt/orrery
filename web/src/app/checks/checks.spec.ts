import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { CheckStatus } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, settle } from '../testing';
import Checks from './checks';

const SITE: CheckStatus = { id: 'site', url: 'https://site.example', up: true, ms: 120, error: null, checkedAt: 1, service: 'caddy' };

describe('checks page', () => {
  it('lists the checks, and shows one going down from its notice', async () => {
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
    const fixture = TestBed.createComponent(Checks);
    const backend = TestBed.inject(HttpTestingController);
    backend.expectOne('/api/checks').flush([SITE]);
    await settle();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const text = (field: string) => el.querySelector(`[data-check=site] [data-${field}]`)?.textContent?.trim();
    expect(text('state')).toBe('Up');
    expect(text('ms')).toBe('120 ms');
    expect(text('service')).toBe('Service: caddy');

    events.push(1, { serverId: 'site', type: 'started' }); // a server's, not the check's
    events.push(2, { target: 'check', id: 'site', type: 'notice', severity: 'problem', kind: 'checkDown', url: SITE.url, error: 'HTTP 503' });
    await new Promise((r) => setTimeout(r, 80));
    backend.expectOne('/api/checks').flush([{ ...SITE, up: false, error: 'HTTP 503', ms: 40 }]);
    await fixture.whenStable();
    expect(text('state')).toBe('Down: HTTP 503');
    backend.verify();
  });
});

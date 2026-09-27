import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { HostSample } from '@hub/api';
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

describe('host page', () => {
  it('shows the latest sample, then each live one', async () => {
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
    TestBed.inject(HttpTestingController).expectOne('/api/host').flush({ id: 'oracle', sample: SAMPLE });
    await settle();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const text = (sel: string) => el.querySelector(sel)?.textContent?.trim();
    expect(text('h1')).toBe('Host oracle');
    expect(text('[data-cpu]')).toBe('25%');
    expect(text('[data-load]')).toBe('0.50 · 0.25 · 0.13');
    expect(text('[data-memory]')).toBe('4.0 of 16.0 GB (25%)');
    expect(text('[data-disk="/"]')).toBe('50.0 GB free of 100 GB');

    const next = { ...SAMPLE, ts: 2, cpu: 0.9, memory: { used: 15 * GB, total: 16 * GB } };
    events.push(1, { target: 'host', id: 'oracle', type: 'sample', sample: next });
    await settle();
    await fixture.whenStable();
    expect(text('[data-cpu]')).toBe('90%');
    expect(text('[data-memory]')).toBe('15.0 of 16.0 GB (94%)');
  });
});

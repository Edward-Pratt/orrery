import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { AuditLog, ServerCard } from '@hub/api';
import { settle } from './testing';

const LOG: AuditLog = [
  { ts: Date.UTC(2026, 8, 27, 12, 0, 5), actor: 'web:alex (5)', action: 'restart', target: 'gtnh', details: 'in 10 min' },
  { ts: Date.UTC(2026, 8, 27, 11, 0, 0), actor: 'discord:bob (2)', action: 'service stop', target: 'site', details: '' },
];
const cards = [{ id: 'gtnh', name: 'GTNH' }, { id: 'site', name: 'Website' }] as ServerCard[];

async function setup(url: string) {
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: 'audit', loadComponent: () => import('./audit') }]), provideHttpClient(), provideHttpClientTesting()],
  });
  const harness = await RouterTestingHarness.create();
  const backend = TestBed.inject(HttpTestingController);
  await harness.navigateByUrl(url);
  backend.expectOne('/api/servers').flush(cards);
  const el = () => harness.routeNativeElement as HTMLElement;
  const render = async () => (await settle(), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  const rows = () => [...el().querySelectorAll('[data-entry]')].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent?.trim()));
  return { backend, el, render, rows };
}

describe('audit log page', () => {
  it('lists every entry newest first: when, who, what, which and details', async () => {
    const { backend, render, rows } = await setup('/audit');
    backend.expectOne('/api/audit').flush(LOG);
    await render();
    expect(rows().map((r) => r.slice(1))).toEqual([
      ['web:alex (5)', 'restart', 'gtnh', 'in 10 min'],
      ['discord:bob (2)', 'service stop', 'site', ''],
    ]);
    expect(rows()[0]![0]).toMatch(/2026-09-27 \d\d:00:05/);
  });

  it('filters by server from the link, and the filter changes the query', async () => {
    const { backend, el, render, rows } = await setup('/audit?server=gtnh');
    backend.expectOne('/api/audit?server=gtnh').flush([LOG[0]]);
    await render();
    expect(rows().length).toBe(1);
    const select = el().querySelector<HTMLSelectElement>('[data-server-filter]')!;
    expect(select.value).toBe('gtnh');
    select.value = '';
    select.dispatchEvent(new Event('change'));
    await render();
    backend.expectOne('/api/audit').flush(LOG);
    await render();
    expect(rows().length).toBe(2);
  });
});

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { AuditLog, ServerCard } from '@hub/api';
import { settle } from './testing';

const log = (...entries: AuditLog['entries']): AuditLog => ({ entries, older: false });
const E1 = { id: 2, ts: Date.UTC(2026, 8, 27, 12, 0, 5), actor: 'web:alex (5)', action: 'restart', target: 'gtnh', details: 'in 10 min' };
const E2 = { id: 1, ts: Date.UTC(2026, 8, 27, 11, 0, 0), actor: 'discord:bob (2)', action: 'service stop', target: 'site', details: '' };
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
  it('lists every entry newest first: when, who, what, which and details, with skeletons until they arrive', async () => {
    const { backend, el, render, rows } = await setup('/audit');
    expect(el().querySelector('[data-skeleton]')).not.toBeNull();
    backend.expectOne('/api/audit').flush(log(E1, E2));
    await render();
    expect(el().querySelector('[data-skeleton]')).toBeNull();
    expect(rows().map((r) => r.slice(1))).toEqual([
      ['web:alex (5)', 'restart', 'gtnh', 'in 10 min'],
      ['discord:bob (2)', 'service stop', 'site', ''],
    ]);
    expect(rows()[0]![0]).toMatch(/2026-09-27 \d\d:00:05/);
    expect(el().querySelectorAll('[data-card]').length).toBe(2);
    expect(el().querySelector('[data-load-older]')).toBeNull();
  });

  it('says when there is nothing', async () => {
    const { backend, el, render } = await setup('/audit');
    backend.expectOne('/api/audit').flush(log());
    await render();
    expect(el().querySelector('[data-empty]')).not.toBeNull();
  });

  it('filters by server and by who, in the URL, and the filters change the query', async () => {
    const { backend, el, render, rows } = await setup('/audit?server=gtnh');
    backend.expectOne('/api/audit?server=gtnh').flush(log(E1));
    await render();
    expect(rows().length).toBe(1);
    const select = el().querySelector<HTMLSelectElement>('[data-server-filter]')!;
    expect(select.value).toBe('gtnh');
    const who = el().querySelector<HTMLInputElement>('[data-actor-filter]')!;
    who.value = 'web:alex (5)';
    who.dispatchEvent(new Event('change'));
    await render();
    backend.expectOne('/api/audit?server=gtnh&actor=web:alex%20(5)').flush(log(E1));
    await render();
    select.value = '';
    select.dispatchEvent(new Event('change'));
    await render();
    backend.expectOne('/api/audit?actor=web:alex%20(5)').flush(log(E1));
    await render();
    expect(rows().length).toBe(1);
  });

  it('"Load older" appends the older entries from the last one shown, and goes at the end', async () => {
    const { backend, el, render, rows } = await setup('/audit?server=gtnh');
    backend.expectOne('/api/audit?server=gtnh').flush({ entries: [E1], older: true });
    await render();
    const button = () => el().querySelector<HTMLButtonElement>('[data-load-older]');
    button()!.click();
    await render();
    expect(button()!.disabled).toBe(true); // while it loads
    backend.expectOne('/api/audit?server=gtnh&before=2').flush({ entries: [E2], older: false });
    await render();
    expect(rows().map((r) => r[1])).toEqual(['web:alex (5)', 'discord:bob (2)']);
    expect(button()).toBeNull();
  });
});

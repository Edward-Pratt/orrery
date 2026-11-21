import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { ServerCard } from '@hub/api';
import { FETCH } from '../events';
import { dialog, dialogButton, fakeEvents, loggedIn, settle } from '../testing';
import { CARD, DETAIL, INSTALLED, row, setup } from './pack.testing';
import routes from './routes';

describe('server pack tab', () => {
  it('lists the history with versions, changes applied, results with durations, and By hidden on a phone', async () => {
    const history = [
      row({ id: 3, from: '2.7.4', to: '2.7.4', changes: ['mods/pregen.jar added'], finished: Date.UTC(2026, 8, 20, 10, 6) }),
      row({ id: 2, from: '2.7.3', to: '2.7.4', outcome: 'rolled back', finished: Date.UTC(2026, 8, 20, 10, 14) }),
    ];
    const { el, text } = await setup({ ...INSTALLED, history });
    const rows = [...el.querySelectorAll('[data-update-row]')].map((r) => [...r.querySelectorAll('td')].slice(1).map(text));
    expect(rows).toEqual([
      ['2.7.4 changes applied: mods/pregen.jar added', 'ok 6 m', 'alex'],
      ['2.7.3 → 2.7.4', 'rolled back 14 m', 'alex'],
    ]);
    expect(el.querySelector('[data-by-column]')!.classList).toContain('hidden');
    expect(el.querySelector('[data-by-column]')!.classList).toContain('sm:table-cell');
  });

  it('replaces the summary with the step card, following step events; Cancel only while preparing and counting down', async () => {
    const { el, text, render, reload, notice, backend } = await setup();
    await notice({ severity: 'info', kind: 'packUpdateStarted', from: '2.7.4', to: '2.7.5', by: 'alex' });
    const steps = (['prepare', 'backup', 'stop', 'swap', 'gate'] as const).map((step) => ({ step, state: 'waiting' as const, detail: '' }));
    const running = { id: 4, name: 'GT New Horizons', version: '2.7.5', by: 'alex', started: Date.now(), cancellable: true, steps: [{ step: 'prepare' as const, state: 'running' as const, detail: 'Getting the pack' }, ...steps.slice(1)] };
    await reload({ ...INSTALLED, running, blocked: 'A pack update is running on GTNH.' });
    expect(el.querySelector('[data-summary]')).toBeNull();
    expect(text(el.querySelector('[data-updating] h2'))).toBe('Updating to GT New Horizons 2.7.5');
    expect(text(el.querySelector('[data-updating]'))).toContain('You can leave this page');
    const cancel = () => el.querySelector<HTMLButtonElement>('[data-cancel]');
    expect(cancel()).not.toBeNull();
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'prepare', state: 'running', detail: 'Downloading 812 MB of 1302 MB', cancellable: true });
    expect(text(el.querySelector('[data-step=prepare] [data-detail]'))).toBe('Downloading 812 MB of 1302 MB');
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'prepare', state: 'done', detail: 'Staged: 2,318 files', cancellable: false });
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'backup', state: 'running', detail: 'Backing up', cancellable: false });
    expect(el.querySelector('[data-step=prepare]')!.getAttribute('data-state')).toBe('done');
    expect(text(el.querySelector('[data-step=prepare] [data-detail]'))).toBe('Staged: 2,318 files');
    expect(cancel()).toBeNull();
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'backup', state: 'done', detail: '2026-10-02-12-00-00.zip', cancellable: false });
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'stop', state: 'running', detail: '3 players online: stopping in 4:12', cancellable: true });
    expect(cancel()).not.toBeNull();
    cancel()!.click();
    await render();
    backend.expectOne('/api/servers/gtnh/pack/update/cancel').flush(null, { status: 204, statusText: 'No Content' });
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'stop', state: 'done', detail: 'Stopped after the countdown', cancellable: false });
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'swap', state: 'running', detail: 'Moving', cancellable: false });
    expect(cancel()).toBeNull();
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'gate', state: 'running', detail: "Waiting for the Mod's hello: 3:12 of 10:00", cancellable: false });
    expect(cancel()).toBeNull();
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'gate', state: 'done', detail: 'Hello after 6:40', cancellable: false });
    await notice({ severity: 'good', kind: 'packUpdateFinished', outcome: 'ok', from: '2.7.4', to: '2.7.5', ms: 1 });
    backend.match('/api/servers/gtnh'); // the page's detail, fetched again on the notice
    await reload({ ...INSTALLED, installed: { ...INSTALLED.installed!, version: '2.7.5', how: 'updated' } });
    expect(el.querySelector('[data-updating]')).toBeNull();
    expect(text(el.querySelector('[data-done]'))).toBe('Done: 2.7.5 is running.');
    expect(text(el.querySelector('[data-installed]'))).toBe('GT New Horizons 2.7.5');
  });

  it('opens the step card for an update already running, as another browser would', async () => {
    const running = { id: 4, name: 'GT New Horizons', version: '2.7.5', by: 'sam', started: Date.now(), cancellable: false, steps: [{ step: 'gate' as const, state: 'running' as const, detail: 'Waiting' }] };
    const { el, text } = await setup({ ...INSTALLED, running });
    expect(text(el.querySelector('[data-updating]'))).toContain('Started by sam');
    expect(el.querySelector('[data-cancel]')).toBeNull();
  });

  it('after a rollback shows the amber line, whose restore offer opens Backups with the backup preselected', async () => {
    const { el, text, render } = await setup({ ...INSTALLED, rolledBack: { to: '2.7.5', backup: '2026-10-02-12-00-00.zip' } });
    expect(text(el.querySelector('[data-rolled-back]'))).toContain('Pack update to 2.7.5 rolled back');
    expect(text(el.querySelector('[data-rolled-back]'))).toContain('the world may have been changed on load');
    el.querySelector<HTMLAnchorElement>('[data-restore-offer]')!.click();
    await render();
    expect(TestBed.inject(Router).url).toBe('/gtnh/backups?restore=2026-10-02-12-00-00.zip');
  });
});

describe('restoring after a pack rollback', () => {
  const BACKUPS = { configured: true, backups: [{ name: '2026-10-02-12-00-00.zip', size: 1, mtimeMs: 0 }, { name: '2026-10-01-06-00-00.zip', size: 1, mtimeMs: 0 }], free: null, growth: null, minFree: 0 };
  async function backups(card: ServerCard, service: { state: string }) {
    const events = fakeEvents();
    TestBed.configureTestingModule({ providers: [loggedIn(), provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/gtnh/backups?restore=2026-10-02-12-00-00.zip');
    TestBed.inject(HttpTestingController)
      .expectOne('/api/servers/gtnh')
      .flush({ ...DETAIL, card, backups: BACKUPS, service: { id: 'gtnh', unit: 'gtnh.service', sub: 'dead', checks: [], ...service } });
    await settle();
    harness.fixture.detectChanges();
    await harness.fixture.whenStable();
    return harness.routeNativeElement as HTMLElement;
  }

  it('preselects the pre-update backup: Restore asks for the typed name, like any restore', async () => {
    const el = await backups({ ...CARD, online: false }, { state: 'inactive' });
    expect(el.querySelector('[data-preselected]')?.textContent).toContain('2026-10-02-12-00-00.zip');
    el.querySelector<HTMLButtonElement>('[data-restore-preselected]')!.click();
    await settle();
    expect(dialog()?.textContent).toContain('Restore 2026-10-02-12-00-00.zip?');
    expect(document.querySelector('[data-confirm-typed]')).not.toBeNull();
    dialogButton('cancel').click();
  });

  it('is disabled while a pack update runs on the server', async () => {
    const el = await backups({ ...CARD, online: false, packUpdate: { running: true, rolledBack: null } }, { state: 'inactive' });
    expect(el.querySelector<HTMLButtonElement>('[data-restore-preselected]')!.disabled).toBe(true);
    expect(el.querySelector('[data-preselected]')?.textContent).toContain('A pack update is running on GTNH');
  });
});

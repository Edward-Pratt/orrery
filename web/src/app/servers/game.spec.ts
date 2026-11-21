import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { RunningGameUpdate } from '@hub/api';
import { FETCH } from '../events';
import { dialog, dialogButton, fakeEvents, loggedIn, settle } from '../testing';
import { CARD, DETAIL, SAME, setup, STATE } from './game.testing';
import routes from './routes';

afterEach(() => dialog() && dialogButton('cancel').click());

describe('server game tab', () => {
  it("is a factorio server's tab, with features.update; a Minecraft server has none", async () => {
    const { el, text } = await setup();
    const tabs = [...el.querySelectorAll('[data-sections] a')].map(text);
    expect(tabs.at(-1)).toBe('Game');
    expect(tabs).not.toContain('Pack');
    TestBed.resetTestingModule();
    const events = fakeEvents();
    TestBed.configureTestingModule({ providers: [loggedIn(), provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/space');
    TestBed.inject(HttpTestingController)
      .expectOne('/api/servers/space')
      .flush({ ...DETAIL, card: { ...CARD, game: 'minecraft', features: { ...CARD.features, update: false } } });
    await settle();
    harness.fixture.detectChanges();
    expect([...(harness.routeNativeElement as HTMLElement).querySelectorAll('[data-sections] a')].map((a) => a.textContent?.trim())).not.toContain('Game');
  });

  it('a stopped server: the dialog says no save is made and the update starts it; cancelling it keeps the picks', async () => {
    const { q, open, go, catalog, choose, render } = await setup(STATE, { ...CARD, online: false, players: [], service: { id: 'factorio', state: 'inactive' } });
    await open();
    await choose('[data-pick=flib] [data-version]', '0.16.2');
    await catalog({ ...SAME, changes: ['Updated: flib 0.16.1 → 0.16.2'] });
    go().click();
    await render(320);
    expect(dialog()?.textContent).toContain('Update the mods of Space?');
    expect(dialog()?.textContent).toContain('The server is stopped, so no save is made first. It swaps Factorio and the mods and starts the server');
    dialogButton('cancel').click();
    await render(320);
    expect(q<HTMLSelectElement>('[data-pick=flib] [data-version]').value).toBe('0.16.2');
    expect(go().disabled).toBe(false);
  });

  it('replaces the summary with the step card from live notices: Save for the backup, Cancel while the hub allows it, then Done', async () => {
    const { el, text, render, reload, notice, backend } = await setup();
    await notice({ severity: 'info', kind: 'packUpdateStarted', from: '2.1.24 · 3 mods', to: '2.1.25 · 3 mods', by: 'alex' });
    const steps = (['prepare', 'backup', 'stop', 'swap', 'gate'] as const).map((step) => ({ step, state: 'waiting' as const, detail: '' }));
    const running: RunningGameUpdate = { id: 4, from: '2.1.24 · 3 mods', to: '2.1.25 · 3 mods', by: 'alex', started: Date.now(), cancellable: true, steps: [{ step: 'prepare', state: 'running', detail: 'Downloading' }, ...steps.slice(1)] };
    await reload({ ...STATE, running, blocked: 'A game update is running on Space.' });
    expect(el.querySelector('[data-summary]')).toBeNull();
    expect(text(el.querySelector('[data-updating] h2'))).toBe('Updating 2.1.24 · 3 mods → 2.1.25 · 3 mods');
    expect(text(el.querySelector('[data-step=backup]'))).toContain('Save');
    const cancel = () => el.querySelector<HTMLButtonElement>('[data-cancel]');
    expect(cancel()).not.toBeNull();
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'prepare', state: 'done', detail: 'Checked: Factorio 2.1.25 and 3 mods', cancellable: true });
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'backup', state: 'done', detail: 'orrery-pre-update-2.1.24-20261031T120000Z.zip', cancellable: true });
    // The stop waits through the countdown; nothing runs, and it can still be cancelled.
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'stop', state: 'waiting', detail: '2 players online: stopping in 4:12', cancellable: true });
    expect(text(el.querySelector('[data-step=stop] [data-detail]'))).toBe('2 players online: stopping in 4:12');
    expect(cancel()).not.toBeNull();
    cancel()!.click();
    await render();
    const req = backend.expectOne('/api/servers/space/game/update/cancel');
    expect(req.request.body).toEqual({});
    req.flush(null, { status: 204, statusText: 'No Content' });
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'swap', state: 'running', detail: 'Starting', cancellable: false });
    expect(cancel()).toBeNull();
    await notice({ severity: 'info', kind: 'packUpdateStep', step: 'gate', state: 'done', detail: 'Back with 2.1.25 and 3 mods', cancellable: false });
    await notice({ severity: 'good', kind: 'packUpdateFinished', outcome: 'ok', from: '2.1.24 · 3 mods', to: '2.1.25 · 3 mods', ms: 1 });
    backend.match('/api/servers/space'); // the page's detail, fetched again on the notice
    await reload({ ...STATE, installed: { ...STATE.installed!, factorio: '2.1.25' } });
    expect(el.querySelector('[data-updating]')).toBeNull();
    expect(text(el.querySelector('[data-done]'))).toBe('Done: 2.1.25 · 3 mods is running.');
    expect(text(el.querySelector('[data-installed]'))).toBe('Factorio 2.1.25');
  });

  it("is fetched again when the Agent leaves or comes back, a deploy starts or ends, or a countdown starts, so the hub's reason is current", async () => {
    const { el, text, reload, target, notice, backend } = await setup();
    await target({ target: 'host', id: 'vm', type: 'notice', severity: 'problem', kind: 'agentLost', name: 'vm' });
    await reload({ ...STATE, blocked: 'The Agent on vm is not connected.' });
    expect(text(el.querySelector('[data-update-why]'))).toBe('The Agent on vm is not connected.');
    await target({ target: 'host', id: 'vm', type: 'notice', severity: 'good', kind: 'agentBack', name: 'vm' });
    await reload(STATE);
    expect(el.querySelector('[data-update-why]')).toBeNull();
    await target({ target: 'deploy', id: 'vm', type: 'notice', severity: 'info', kind: 'deployStarted', part: 'agent', from: 'agent-v1.0.0', to: 'agent-v1.0.1', by: 'alex' });
    await reload({ ...STATE, blocked: 'An Agent deploy is running.' });
    await notice({ severity: 'info', kind: 'restartScheduled', ms: 300_000, by: 'alex' });
    backend.match('/api/servers/space');
    await reload({ ...STATE, blocked: 'A countdown is running on Space.' });
    expect(text(el.querySelector('[data-update-why]'))).toBe('A countdown is running on Space.');
  });
});

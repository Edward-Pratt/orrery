import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { CatalogMod, GameCatalog, GameState, Notice, PackUpdateRow, RunningGameUpdate, ServerCard, ServerDetail, TargetEvent } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { Feedback } from '../feedback';
import { dialog, dialogButton, fakeEvents, settle } from '../testing';
import routes from './routes';

const CARD: ServerCard = {
  id: 'space',
  name: 'Space',
  game: 'factorio',
  rate: { label: 'UPS', max: 60 },
  online: true,
  hung: false,
  paused: false,
  tps: 60,
  players: ['Alex', 'Sam'],
  uptimeDay: 1,
  restart: null,
  lagging: false,
  service: { id: 'factorio', state: 'active' },
  features: { chat: true, tps: true, quests: false, console: true, update: true },
  packUpdate: null,
};
const DETAIL = { card: CARD, service: null, top: { day: [], week: [], all: [] }, backups: { configured: false }, pack: false, logs: false } as unknown as ServerDetail;
const row = (more: Partial<PackUpdateRow>): PackUpdateRow => ({
  id: 1,
  from: '2.1.23 · 2 mods',
  to: '2.1.24 · 3 mods',
  changes: ['Added: flib 0.16.1'],
  by: 'alex',
  started: Date.UTC(2026, 9, 20, 10),
  finished: Date.UTC(2026, 9, 20, 10, 6),
  outcome: 'ok',
  step: 'gate',
  backup: 'orrery-pre-update-2.1.23-20261020T100000Z.zip',
  log: '',
  ...more,
});
const STATE: GameState = {
  installed: {
    factorio: '2.1.24',
    mods: [
      { name: 'base', version: '2.1.24' },
      { name: 'elevated-rails', version: '2.1.24' },
      { name: 'quality', version: '2.1.24' },
      { name: 'space-age', version: '2.1.24' },
      { name: 'orrery', version: '1.0.0' },
      { name: 'flib', version: '0.16.1' },
      { name: 'RateCalculator', version: '3.3.2' },
    ],
  },
  history: [row({})],
  running: null,
  blocked: null,
};
const mod = (name: string, releases: string[], more: Partial<CatalogMod> = {}): CatalogMod => ({ name, title: name.toUpperCase(), version: releases[0]!, releases, requiredBy: null, ...more });
/** The catalog for what the server runs now: nothing changes. */
const SAME: GameCatalog = {
  versions: [
    { version: '2.1.25', channel: 'stable' },
    { version: '2.2.0', channel: 'experimental' },
  ],
  mods: [mod('orrery', ['1.0.1', '1.0.0']), mod('flib', ['0.16.2', '0.16.1']), mod('RateCalculator', ['3.3.3', '3.3.2'])],
  unresolved: [],
  changes: [],
};
const PICKS = [
  { name: 'orrery', version: '1.0.0' },
  { name: 'flib', version: '0.16.1' },
  { name: 'RateCalculator', version: '3.3.2' },
];

/** Opens the server's Game tab and answers its detail and game state. */
async function setup(state: GameState = STATE, card: ServerCard = CARD) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }, { provide: RETRY_MS, useValue: 0 }],
  });
  const harness = await RouterTestingHarness.create();
  const backend = TestBed.inject(HttpTestingController);
  await harness.navigateByUrl('/space/game');
  backend.expectOne('/api/servers/space').flush({ ...DETAIL, card });
  await settle();
  harness.fixture.detectChanges();
  await settle();
  backend.expectOne('/api/servers/space/game').flush(state);
  const el = harness.routeNativeElement as HTMLElement;
  const render = async (ms = 10) => (await new Promise((r) => setTimeout(r, ms)), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  await render();
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => (el.querySelector<T>(sel) ?? document.querySelector<T>(sel))!;
  const all = (sel: string) => [...document.querySelectorAll(sel)];
  const choose = async (sel: string, value: string) => {
    const select = q<HTMLSelectElement>(sel);
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await render();
  };
  /** Answers the catalog request the sheet just made, checking what it asked. */
  const catalog = async (answer: GameCatalog, mods?: { name: string; version: string | null }[], factorio = '2.1.24') => {
    const req = backend.expectOne('/api/servers/space/game/catalog');
    expect(req.request.method).toBe('POST');
    if (mods) expect(req.request.body).toEqual({ factorio, mods });
    req.flush(answer);
    await render();
  };
  /** Opens Update game and answers its first catalog request. */
  const open = async (answer: GameCatalog = SAME) => {
    q('[data-update]').click();
    await render();
    await catalog(answer, PICKS);
  };
  const go = () => q<HTMLButtonElement>('[data-update-go]');
  const type = async (sel: string, value: string) => {
    const input = q<HTMLInputElement>(sel);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  /** Answers the reload a change or an event asks for (debounced). */
  const reload = async (next: GameState) => {
    await render(70);
    backend.expectOne('/api/servers/space/game').flush(next);
    await render();
  };
  let n = 1;
  const notice = async (e: Notice) => {
    events.push(n++, { ...e, type: 'notice', serverId: 'space' });
    await render();
  };
  const target = async (e: TargetEvent) => {
    events.push(n++, e);
    await render();
  };
  return { harness, backend, events, el, render, text, q, all, choose, type, catalog, open, go, reload, notice, target };
}

afterEach(() => dialog() && dialogButton('cancel').click());

describe('server game tab', () => {
  it("is a factorio server's tab, with features.update; a Minecraft server has none", async () => {
    const { el, text } = await setup();
    const tabs = [...el.querySelectorAll('[data-sections] a')].map(text);
    expect(tabs.at(-1)).toBe('Game');
    expect(tabs).not.toContain('Pack');
    TestBed.resetTestingModule();
    const events = fakeEvents();
    TestBed.configureTestingModule({ providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/space');
    TestBed.inject(HttpTestingController)
      .expectOne('/api/servers/space')
      .flush({ ...DETAIL, card: { ...CARD, game: 'minecraft', features: { ...CARD.features, update: false } } });
    await settle();
    harness.fixture.detectChanges();
    expect([...(harness.routeNativeElement as HTMLElement).querySelectorAll('[data-sections] a')].map((a) => a.textContent?.trim())).not.toContain('Game');
  });

  it("shows the Factorio version and every mod, the game's own muted, and the history with its mod changes", async () => {
    const history = [row({ id: 2, from: '2.1.24 · 3 mods', to: '2.1.24 · 3 mods', changes: null, outcome: 'rolled back', finished: Date.UTC(2026, 9, 20, 10, 14) }), row({})];
    const { el, text } = await setup({ ...STATE, history });
    expect(text(el.querySelector('[data-installed]'))).toBe('Factorio 2.1.24');
    expect(text(el.querySelector('[data-mod=flib]'))).toBe('flib 0.16.1');
    expect(el.querySelector('[data-mod=space-age]')!.className).toContain('text-muted-foreground');
    expect(el.querySelector('[data-mod=space-age]')!.getAttribute('title')).toBe('Comes with Factorio');
    expect(el.querySelector('[data-mod=flib]')!.getAttribute('title')).toBeNull();
    const rows = [...el.querySelectorAll('[data-update-row]')].map((r) => [...r.querySelectorAll('td')].slice(1).map(text));
    expect(rows).toEqual([
      ['2.1.24 · 3 mods', 'rolled back 14 m', 'alex'],
      ['2.1.23 · 2 mods → 2.1.24 · 3 mods Added: flib 0.16.1', 'ok 6 m', 'alex'],
    ]);
  });

  it('says so when there are no updates yet, or when its Agent has not said what it runs', async () => {
    const { el, q, text } = await setup({ ...STATE, installed: null, history: [] });
    expect(text(el.querySelector('[data-no-history]'))).toBe('No game updates yet.');
    expect(text(el.querySelector('[data-not-reported]'))).toContain("Its Agent hasn't said yet what the server runs");
    expect(q<HTMLButtonElement>('[data-update]').disabled).toBe(true);
  });

  it("disables Update game with the hub's reason, but not for a stopped server", async () => {
    const busy = await setup({ ...STATE, blocked: 'The Agent on vm is not connected.' });
    expect(busy.q<HTMLButtonElement>('[data-update]').disabled).toBe(true);
    expect(busy.text(busy.el.querySelector('[data-update-why]'))).toBe('The Agent on vm is not connected.');
    TestBed.resetTestingModule();
    const stopped = await setup(STATE, { ...CARD, online: false, players: [], service: { id: 'factorio', state: 'inactive' } });
    expect(stopped.q<HTMLButtonElement>('[data-update]').disabled).toBe(false);
    expect(stopped.el.querySelector('[data-update-why]')).toBeNull();
  });

  it('opens the picker on what runs now: the Factorio releases on offer, each portal mod at its version, the game’s own apart', async () => {
    const { q, text, all, open, go } = await setup();
    await open();
    expect(all('[data-factorio] option').map(text)).toEqual(['2.1.24 (running)', '2.1.25 · stable', '2.2.0 · experimental']);
    expect(q<HTMLSelectElement>('[data-factorio]').value).toBe('2.1.24');
    expect(all('[data-pick]').map((p) => p.getAttribute('data-pick'))).toEqual(['orrery', 'flib', 'RateCalculator']);
    expect(all('[data-pick=flib] [data-version] option').map(text)).toEqual(['Newest that fits (0.16.2)', '0.16.2', '0.16.1']);
    expect(q<HTMLSelectElement>('[data-pick=flib] [data-version]').value).toBe('0.16.1');
    expect(text(q('[data-game-mods]'))).toBe('Comes with Factorio: base, elevated-rails, quality, space-age');
    expect(document.querySelector('[data-pick=orrery] [data-remove]')).toBeNull(); // the Agent needs it
    expect(document.querySelector('[data-pick=orrery] [data-locked]')).not.toBeNull();
    expect(text(q('[data-changes]'))).toContain('Nothing yet.');
    expect(go().disabled).toBe(true);
    expect(text(q('[data-update-go-why]'))).toBe('Nothing to change yet.');
  });

  it('asks the catalog on every change, shows the dependencies it added, and an unmet one stops the update until fixed', async () => {
    const { q, text, all, open, go, catalog, choose, type, render, backend } = await setup();
    await open();
    // Removing flib: the catalog adds it back for RateCalculator, at the newest that fits.
    q('[data-pick=flib] [data-remove]').click();
    await render();
    const noFlib = PICKS.filter((p) => p.name !== 'flib');
    await catalog(
      { ...SAME, mods: [mod('orrery', ['1.0.1', '1.0.0']), mod('RateCalculator', ['3.3.3', '3.3.2']), mod('flib', ['0.16.2', '0.16.1'], { requiredBy: 'RateCalculator' })], changes: ['Updated: flib 0.16.1 → 0.16.2'] },
      noFlib,
    );
    expect(text(q('[data-dependency=flib]'))).toMatch(/^FLIB\s*flib 0\.16\.2\s*required by RateCalculator$/);
    expect(go().disabled).toBe(false);
    // A new mod at the newest that fits, whose dependency can't be met on this Factorio.
    await type('[data-add-name]', ' bigger-belts ');
    q('[data-add]').click();
    await render();
    const unmet: GameCatalog = {
      ...SAME,
      mods: [...SAME.mods, mod('bigger-belts', ['0.4.0'])],
      unresolved: [{ mod: 'bigger-belts', dependency: 'base >= 2.2', reason: 'Factorio 2.1.24 is older' }],
      changes: ['Added: bigger-belts 0.4.0'],
    };
    await catalog(unmet, [...noFlib, { name: 'bigger-belts', version: null }]);
    expect(text(q('[data-unresolved]'))).toContain("A dependency can't be met. The update can't start until they are fixed");
    expect(all('[data-unmet]').map(text)).toEqual(['bigger-belts needs base >= 2.2: Factorio 2.1.24 is older']);
    expect(go().disabled).toBe(true);
    expect(text(q('[data-update-go-why]'))).toBe('Fix the unmet dependencies first.');
    // A newer Factorio meets it.
    await choose('[data-factorio]', '2.2.0');
    await catalog({ ...unmet, unresolved: [], changes: ['Factorio 2.1.24 → 2.2.0', 'Added: bigger-belts 0.4.0'] }, [...noFlib, { name: 'bigger-belts', version: null }], '2.2.0');
    expect(document.querySelector('[data-unresolved]')).toBeNull();
    expect(go().disabled).toBe(false);
    go().click();
    await render(320);
    expect(dialog()?.textContent).toContain('Update Space to Factorio 2.2.0?');
    expect(dialog()?.textContent).toContain('Factorio 2.1.24 → 2.2.0; Added: bigger-belts 0.4.0.');
    expect(dialog()?.textContent).toContain('Saves, then stops the server (a 5-minute countdown: 2 players online), swaps Factorio and the mods, and starts it.');
    expect(dialog()?.textContent).toContain('rolls back to the old ones and the pre-update save');
    dialogButton('ok').click();
    await render();
    const req = backend.expectOne('/api/servers/space/game/update');
    expect(req.request.body).toEqual({ factorio: '2.2.0', mods: [...noFlib, { name: 'bigger-belts', version: null }] });
    req.flush({ id: 3 }, { status: 202, statusText: 'Accepted' });
  });

  it('picks the newest that fits for a mod, and Update waits for the answer to the picks as they are now', async () => {
    const { q, open, go, choose, backend, render, text } = await setup();
    await open();
    await choose('[data-pick=RateCalculator] [data-version]', '');
    expect(go().disabled).toBe(true); // the answer on screen is for the earlier picks
    expect(text(q('[data-update-go-why]'))).toBe('Waiting for the mod portal.');
    await choose('[data-pick=orrery] [data-version]', '1.0.1');
    const [first, second] = backend.match('/api/servers/space/game/catalog');
    expect(first!.cancelled).toBe(true); // an answer for an earlier pick is never shown
    expect(second!.request.body.mods).toEqual([
      { name: 'orrery', version: '1.0.1' },
      { name: 'flib', version: '0.16.1' },
      { name: 'RateCalculator', version: null },
    ]);
    second!.flush({ ...SAME, changes: ['Updated: orrery 1.0.0 → 1.0.1', 'Updated: RateCalculator 3.3.2 → 3.3.3'] });
    await render();
    expect(go().disabled).toBe(false);
  });

  it("shows the catalog's refusal in the sheet, not as a toast, and the game's own mods can't be added", async () => {
    const { q, text, open, go, render, backend, type } = await setup();
    const failed = vi.spyOn(TestBed.inject(Feedback), 'failed');
    await open();
    await type('[data-add-name]', 'space-age');
    q('[data-add]').click();
    await render();
    expect(text(q('[data-add-error]'))).toBe('space-age comes with Factorio.');
    await type('[data-add-name]', 'flib');
    q('[data-add]').click();
    await render();
    expect(text(q('[data-add-error]'))).toBe('flib is in the list already.');
    backend.expectNone('/api/servers/space/game/catalog');
    await type('[data-add-name]', 'no-such-mod');
    q('[data-add]').click();
    await render();
    backend.expectOne('/api/servers/space/game/catalog').flush('The mod portal has no mod no-such-mod.', { status: 404, statusText: 'Not Found' });
    await render();
    expect(text(q('[data-catalog-error]'))).toBe('The catalog: The mod portal has no mod no-such-mod.');
    expect(go().disabled).toBe(true);
    expect(text(q('[data-update-go-why]'))).toBe('Fix the problem above first.');
    expect(failed).not.toHaveBeenCalled();
    q('[data-pick=no-such-mod] [data-remove]').click();
    await render();
    backend.expectOne('/api/servers/space/game/catalog').flush(SAME);
    await render();
    expect(document.querySelector('[data-catalog-error]')).toBeNull();
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

  it('shows a failure while preparing as a red box naming its cause', async () => {
    const failed = row({
      id: 3,
      to: '2.2.0 · 3 mods',
      outcome: 'failed in staging',
      step: 'prepare',
      backup: null,
      log: 'Factorio 2.2.0 needs glibc 2.39; the friend must re-run setup with a newer image\nprepare: failed: needs glibc 2.39',
    });
    const { el, text } = await setup({ ...STATE, history: [failed, row({})] });
    const box = text(el.querySelector('[data-failed-prep]'));
    expect(box).toContain("Update to 2.2.0 · 3 mods failed while preparing. The server wasn't touched.");
    expect(box).toContain('needs glibc 2.39; the friend must re-run setup with a newer image');
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


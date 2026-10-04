import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { CompareReport, Extra, LibraryPack, LibraryState, Notice, PackState, PackUpdateRow, ServerCard, ServerDetail } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { Feedback } from '../feedback';
import { dialog, dialogButton, fakeEvents, settle } from '../testing';
import routes from './routes';

const CARD: ServerCard = {
  id: 'gtnh',
  name: 'GTNH',
  online: true,
  hung: false,
  tps: 20,
  players: ['Steve', 'Alex', 'Kestrel'],
  uptimeDay: 1,
  restart: null,
  lagging: false,
  service: { id: 'gtnh', state: 'active' },
  features: { chat: true, tps: true, quests: true },
  packUpdate: { running: false, rolledBack: null },
};
const DETAIL = { card: CARD, service: null, top: { day: [], week: [], all: [] }, backups: { configured: false }, pack: true } as unknown as ServerDetail;
const KEPT = { server: ['config/JourneyMapServer', 'journeymap/'], builtIn: ['World/', 'server.properties', 'logs/'] };
const EMPTY: PackState = {
  installed: null,
  kept: KEPT,
  extras: [],
  edits: [],
  pending: [],
  history: [],
  running: null,
  mod: 'mods/gtnhdiscord-1.4.0.jar',
  blocked: null,
  rolledBack: null,
  packFiles: [],
  runtime: { name: null, pending: false, unitLines: null },
};
const extra = (target: string, more: Partial<Extra> = {}): Extra => ({
  id: target.length,
  target,
  sha256: 'a',
  label: '',
  note: '',
  by: 'alex',
  at: Date.UTC(2026, 8, 1),
  removed: false,
  replaces: false,
  change: null,
  ...more,
});
const row = (more: Partial<PackUpdateRow>): PackUpdateRow => ({
  id: 1,
  from: '2.7.3',
  to: '2.7.4',
  changes: null,
  by: 'alex',
  started: Date.UTC(2026, 8, 20, 10),
  finished: Date.UTC(2026, 8, 20, 10, 9),
  outcome: 'ok',
  step: 'gate',
  backup: '2026-09-20-10-00-00.zip',
  log: '',
  ...more,
});
const INSTALLED: PackState = {
  ...EMPTY,
  installed: {
    name: 'GT New Horizons',
    version: '2.7.4',
    source: 'https://github.com/GTNewHorizons/pack/releases/download/2.7.4/GT_New_Horizons_2.7.4_Server_Java_17-21.zip',
    sha256: '9f2c1e0123456789abcdef',
    by: 'alex',
    at: Date.UTC(2026, 8, 20),
    how: 'adopted',
  },
  extras: [
    extra('mods/journeymap-fairplay.jar', { label: '5.2.6', note: 'fairplay build' }),
    extra('config/forge.cfg', { replaces: true }),
  ],
  edits: [{ id: 7, path: 'startserver.sh', find: '-Xmx6G', replace: '-Xmx12G', note: 'heap', by: 'alex', at: 0, failedOn: null }],
  history: [row({})],
  packFiles: ['config/forge.cfg', 'mods/gregtech.jar'],
};

const entry = (id: number, version: string, mc = '1.7.10'): LibraryPack => ({
  id,
  name: 'GT New Horizons',
  version,
  mc,
  loader: 'forge',
  sha256: 'a',
  size: 1,
  source: 'x',
  by: 'alex',
  at: 0,
  usedBy: [],
});
const RUNTIME = { name: 'temurin-21.0.8+9', label: 'Temurin 21.0.8+9', feature: 21, size: 1, sha256: 'a', by: 'alex', at: 0, usedBy: [] };
const LIBRARY: LibraryState = { packs: [entry(2, '2.7.5'), entry(1, '2.7.4')], runtimes: [RUNTIME], running: null };

/** Opens the server's Pack tab and answers its detail and pack state. */
async function setup(state: PackState = INSTALLED, card: ServerCard = CARD) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }, { provide: RETRY_MS, useValue: 0 }],
  });
  const harness = await RouterTestingHarness.create();
  const backend = TestBed.inject(HttpTestingController);
  await harness.navigateByUrl('/gtnh/pack');
  backend.expectOne('/api/servers/gtnh').flush({ ...DETAIL, card });
  await settle();
  harness.fixture.detectChanges();
  await settle();
  backend.expectOne('/api/servers/gtnh/pack').flush(state);
  const el = harness.routeNativeElement as HTMLElement;
  const render = async (ms = 10) => (await new Promise((r) => setTimeout(r, ms)), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  await render();
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => (el.querySelector<T>(sel) ?? document.querySelector<T>(sel))!;
  const type = async (sel: string, value: string) => {
    const input = q<HTMLInputElement>(sel);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  /** Picks a library version in the Adopt or Update picker. */
  const pick = async (id: number) => {
    const select = q<HTMLSelectElement>('[data-pick]');
    select.value = String(id);
    select.dispatchEvent(new Event('change'));
    await render();
  };
  /** Answers the dashboard's read of the library. */
  const library = async (state = LIBRARY) => {
    const reqs = backend.match('/api/library');
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) r.flush(state);
    await render();
  };
  /** Answers the reload a change or an event asks for (debounced). */
  const reload = async (next: PackState) => {
    await render(70);
    backend.expectOne('/api/servers/gtnh/pack').flush(next);
    await render();
  };
  let n = 1;
  const notice = async (e: Notice) => {
    events.push(n++, { ...e, type: 'notice', serverId: 'gtnh' });
    await render();
  };
  return { harness, backend, events, el, render, text, q, type, pick, library, reload, notice };
}

describe('server pack tab', () => {
  it('appears last, only for a server that can have a pack, in a tab row that scrolls on a phone', async () => {
    const { el, text } = await setup();
    const tabs = [...el.querySelectorAll('[data-sections] a')].map(text);
    expect(tabs.at(-1)).toBe('Pack');
    expect(el.querySelector('[data-sections]')!.className).toContain('overflow-x-auto');
    TestBed.resetTestingModule();
    const events = fakeEvents();
    TestBed.configureTestingModule({ providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/gtnh');
    TestBed.inject(HttpTestingController).expectOne('/api/servers/gtnh').flush({ ...DETAIL, pack: false });
    await settle();
    harness.fixture.detectChanges();
    expect([...(harness.routeNativeElement as HTMLElement).querySelectorAll('[data-sections] a')].map((a) => a.textContent?.trim())).not.toContain('Pack');
  });

  it('starts with Adopt, the Kept path chips (this server first) and an empty history', async () => {
    const { el, text } = await setup(EMPTY);
    expect(text(el.querySelector('[data-adopt]'))).toContain("orrery doesn't know this server's pack yet");
    expect([...el.querySelectorAll('[data-kept-server]')].map(text)).toEqual(['config/JourneyMapServer', 'journeymap/']);
    expect([...el.querySelectorAll('[data-kept-builtin]')].map(text)).toEqual(['World/', 'server.properties', 'logs/']);
    expect(text(el.querySelector('[data-kept]'))).toContain('config.json');
    expect(el.querySelector('[data-no-history]')).not.toBeNull();
    expect(el.querySelector('[data-summary]')).toBeNull();
  });

  it('adopts: a version picked from the library, Compare, the report with keep boxes, then the summary card', async () => {
    const { el, q, text, render, backend, pick, library } = await setup(EMPTY);
    await library();
    expect([...el.querySelectorAll('[data-pick] option')].map(text)).toEqual(['Choose a version…', 'GT New Horizons 2.7.5 · Minecraft 1.7.10', 'GT New Horizons 2.7.4 · Minecraft 1.7.10']);
    expect(q<HTMLButtonElement>('[data-compare]').disabled).toBe(true);
    await pick(1);
    q('[data-compare]').click();
    await render();
    const compare = backend.expectOne('/api/servers/gtnh/pack/compare');
    expect(compare.request.body).toEqual({ library: 1 });
    const report: CompareReport = {
      name: 'GT New Horizons',
      version: '2.7.4',
      matching: 2241,
      mod: ['mods/gtnhdiscord-1.4.0.jar'],
      notInPack: [
        { path: 'config/custom.cfg', size: 14 },
        { path: 'mods/journeymap-fairplay.jar', size: 2_000_000 },
      ],
      different: [{ path: 'config/forge.cfg', size: 2048 }],
    };
    compare.flush(report);
    await render();
    expect(text(el.querySelector('[data-matching]'))).toContain('2,241 files match the pack');
    expect(text(el.querySelector('[data-report-mod]'))).toContain('mods/gtnhdiscord-1.4.0.jar');
    expect(el.querySelector('[data-report-mod] input')).toBeNull(); // locked
    expect(text(el.querySelector('[data-report]'))).toContain('a Config edit is better');
    expect(text(q('[data-adopt-keep]'))).toBe('Adopt, keep 2 files');
    el.querySelector<HTMLInputElement>('[data-group=different] input')!.click();
    await render();
    el.querySelector<HTMLInputElement>('[data-group=notInPack] input')!.click();
    await render();
    expect(text(q('[data-adopt-keep]'))).toBe('Adopt, keep 2 files');
    q('[data-adopt-keep]').click();
    await render();
    expect(dialog()).toBeNull(); // no confirm: nothing on disk changes
    const adopt = backend.expectOne('/api/servers/gtnh/pack/adopt');
    expect(new Set(adopt.request.body.keep)).toEqual(new Set(['mods/journeymap-fairplay.jar', 'config/forge.cfg']));
    adopt.flush(INSTALLED);
    await render();
    expect(text(el.querySelector('[data-installed]'))).toBe('GT New Horizons 2.7.4');
    expect(text(el.querySelector('[data-installed-by]'))).toContain('adopted by alex');
    expect(el.querySelector<HTMLAnchorElement>('[data-installed-by] a')!.href).toBe(INSTALLED.installed!.source);
    expect(text(el.querySelector('[data-installed-by]'))).toContain('sha256 9f2c1e012345…');
  });

  it('links to the Library page, and says so when the library is empty', async () => {
    const { el, library } = await setup(EMPTY);
    await library({ packs: [], runtimes: [], running: null });
    expect(el.querySelector('[data-pick]')).toBeNull();
    expect(el.querySelector('[data-library-empty]')).not.toBeNull();
    expect(el.querySelector<HTMLAnchorElement>('[data-library-link]')!.getAttribute('href')).toBe('/library');
    expect(el.querySelector('[data-url]')).toBeNull(); // no URL or upload: the library is the only way in
  });

  it("shows the server's Java runtime and changes it, pending until the next restart", async () => {
    const { el, q, text, render, backend, library } = await setup();
    await library();
    expect(q<HTMLSelectElement>('[data-runtime-select]').value).toBe('');
    expect([...el.querySelectorAll('[data-runtime-select] option')].map(text)).toEqual(['System java', 'Temurin 21.0.8+9']);
    const select = q<HTMLSelectElement>('[data-runtime-select]');
    select.value = 'temurin-21.0.8+9';
    select.dispatchEvent(new Event('change'));
    await render();
    const req = backend.expectOne('/api/servers/gtnh/pack/runtime');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ runtime: 'temurin-21.0.8+9' });
    req.flush({ ...INSTALLED, runtime: { name: 'temurin-21.0.8+9', pending: true, unitLines: null } });
    await render();
    expect(text(el.querySelector('[data-runtime-pending]'))).toBe('pending restart');
    expect(q<HTMLSelectElement>('[data-runtime-select]').value).toBe('temurin-21.0.8+9');
  });

  it("shows the two unit lines instead of the selector when the server's unit doesn't name the link", async () => {
    const lines = ['Environment=PATH=/srv/o/java/gtnh/bin:/usr/local/bin:/usr/bin:/bin', 'Environment=JAVA_HOME=/srv/o/java/gtnh'];
    const { el, text, library } = await setup({ ...INSTALLED, runtime: { name: null, pending: false, unitLines: lines } });
    await library();
    expect(el.querySelector('[data-runtime-select]')).toBeNull();
    expect(text(el.querySelector('[data-runtime-now]'))).toBe('System java');
    expect(el.querySelector('[data-unit-lines]')!.textContent).toBe(lines.join('\n'));
  });

  it('shows Extras with their pills, removed ones struck through, and the Mod as a locked last row', async () => {
    const state: PackState = {
      ...INSTALLED,
      extras: [
        extra('config/forge.cfg', { replaces: true, change: 'replaced' }),
        extra('mods/dynmap.jar', { removed: true, change: 'removed' }),
        extra('mods/journeymap-fairplay.jar', { label: '5.2.6', note: 'fairplay build' }),
      ],
    };
    const { el, text } = await setup(state);
    const rows = [...el.querySelectorAll('[data-extra]')];
    expect(rows.map((r) => r.getAttribute('data-extra'))).toEqual(['config/forge.cfg', 'mods/dynmap.jar', 'mods/journeymap-fairplay.jar']);
    expect(text(rows[0]!.querySelector('[data-change]'))).toBe('replaced');
    expect(text(rows[0]!.querySelector('[data-where]'))).toBe("replaces the pack's file");
    expect(text(rows[2]!.querySelector('[data-where]'))).toBe('new path');
    expect(rows[1]!.querySelector('.line-through')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-more]')).toBeNull();
    expect(text(rows[2])).toContain('new path 5.2.6 · alex');
    expect(text(rows[2])).toContain('fairplay build');
    const mod = el.querySelector('[data-mod-row]')!;
    expect(text(mod)).toContain('mods/gtnhdiscord-1.4.0.jar');
    expect(text(mod)).toContain('put back on every update. Deployed from Host.');
    expect(mod.querySelector('[data-more]')).toBeNull();
    expect(el.querySelector('[data-extras] li:last-child')).toBe(mod);
  });

  it('removes an Extra from its ⋯ menu without asking, and says the change is pending', async () => {
    const { el, render, backend } = await setup();
    const ok = vi.spyOn(TestBed.inject(Feedback), 'ok');
    el.querySelector<HTMLButtonElement>('[data-extra="config/forge.cfg"] [data-more]')!.click();
    await render();
    expect([...document.querySelectorAll('[data-slot=dropdown-menu-item]')].map((i) => i.textContent?.trim())).toEqual(['Replace file…', 'Edit label and note…', 'Remove']);
    document.querySelector<HTMLButtonElement>('[data-slot=dropdown-menu-item][data-remove]')!.click();
    await render();
    expect(dialog()).toBeNull();
    const req = backend.expectOne((r) => r.method === 'DELETE' && r.url === `/api/servers/gtnh/pack/extras/${'config/forge.cfg'.length}`);
    expect(req.request.headers.get('content-type')).toBe('application/json');
    req.flush({ ...INSTALLED, pending: [{ path: 'config/forge.cfg', kind: 'extra', change: 'removed' }] });
    await render();
    expect(ok).toHaveBeenCalledWith('Saved: changes pending, not on the server until you apply them.');
  });

  it('adds an Extra from a sheet: Put at from the file name, and a note when the pack has that path', async () => {
    const { q, type, render, backend } = await setup();
    q('[data-add-extra]').click();
    await render();
    const file = new File(['jar'], 'Chunk-Pregenerator-4.4.4.jar');
    const input = q<HTMLInputElement>('[data-extra-file]');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await render();
    expect(q<HTMLInputElement>('[data-target]').value).toBe('mods/Chunk-Pregenerator-4.4.4.jar');
    expect(document.querySelector('[data-replaces]')).toBeNull();
    await type('[data-target]', 'config/forge.cfg');
    expect(document.querySelector('[data-replaces]')?.textContent).toContain('this Extra replaces it');
    await type('[data-target]', 'mods/pregen.jar');
    await type('[data-label]', '4.4.4');
    await type('[data-note]', 'pregen');
    q('[data-save]').click();
    await render();
    backend.expectOne('/api/uploads').flush({ upload: 'u1' });
    await render();
    backend.expectOne('/api/uploads/u1?offset=0').flush({ received: 3 });
    await render();
    const add = backend.expectOne('/api/servers/gtnh/pack/extras');
    expect(add.request.body).toEqual({ upload: 'u1', target: 'mods/pregen.jar', label: '4.4.4', note: 'pregen' });
    add.flush(INSTALLED);
    await render(320);
    expect(document.querySelector('[data-sheet]')).toBeNull();
  });

  it('shows edits, one that matched nothing in red, and previews a new one before saving', async () => {
    const state = { ...INSTALLED, edits: [{ ...INSTALLED.edits[0]!, path: 'config/GregTech/Pollution.cfg', find: 'pollution=true', replace: 'pollution=false', failedOn: '2.7.5' }] };
    const { el, q, type, text, render, backend } = await setup(state);
    expect(text(el.querySelector('[data-unmatched]'))).toBe('Matched nothing in 2.7.5 (the last update tried).');
    q('[data-add-edit]').click();
    await render();
    await type('[data-edit-path]', 'startserver.sh');
    await type('[data-find]', '-Xmx(\\d+)G');
    await type('[data-replace-with]', '-Xmx12G');
    await render(350);
    const preview = backend.expectOne('/api/servers/gtnh/pack/edits/preview');
    expect(preview.request.body).toEqual({ path: 'startserver.sh', find: '-Xmx(\\d+)G' });
    preview.flush({ matches: 1 });
    await render();
    expect(document.querySelector('[data-preview]')?.textContent?.trim()).toBe('Against the installed 2.7.4: 1 match');
    q('[data-save]').click();
    await render();
    const save = backend.expectOne('/api/servers/gtnh/pack/edits');
    expect(save.request.body).toEqual({ path: 'startserver.sh', find: '-Xmx(\\d+)G', replace: '-Xmx12G', note: '' });
    save.flush(INSTALLED);
  });

  it('lists the changes pending in an amber box, with Apply N changes beside Update pack', async () => {
    const pending: PackState = {
      ...INSTALLED,
      pending: [
        { path: 'config/forge.cfg', kind: 'extra', change: 'removed' },
        { path: 'startserver.sh', kind: 'edit', change: 'replaced' },
      ],
    };
    const { el, text } = await setup(pending);
    expect(text(el.querySelector('[data-pending]'))).toContain('2 changes pending');
    expect(text(el.querySelector('[data-pending]'))).toContain('config/forge.cfg removed');
    expect(text(el.querySelector('[data-pending]'))).toContain('startserver.sh edits replaced');
    expect(text(el.querySelector('[data-apply]'))).toBe('Apply 2 changes');
    expect(el.querySelector('[data-update]')).not.toBeNull();
  });

  it('applies the changes pending after a dialog, posting { pending: true }', async () => {
    const { q, render, backend } = await setup({ ...INSTALLED, pending: [{ path: 'config/forge.cfg', kind: 'extra', change: 'removed' }] });
    q('[data-apply]').click();
    await render();
    expect(dialog()?.textContent).toContain('Apply 1 change to GTNH?');
    expect(dialog()?.textContent).toContain('3 players online');
    dialogButton('ok').click();
    await render();
    const req = backend.expectOne('/api/servers/gtnh/pack/update');
    expect(req.request.body).toEqual({ pending: true });
    req.flush({ id: 2 }, { status: 202, statusText: 'Accepted' });
  });

  it('updates to a library version picked in the sheet, after the dialog naming the server and the version', async () => {
    const { q, render, backend, pick, library } = await setup();
    q('[data-update]').click();
    await render();
    await library();
    expect(document.querySelector('[data-sheet]')?.textContent).toContain('rolls back');
    expect(document.querySelector('[data-sheet] [data-library-link]')).not.toBeNull();
    expect(q('[data-update-go]').textContent?.trim()).toBe('Update to ……');
    await pick(2);
    expect(q('[data-update-go]').textContent?.trim()).toBe('Update to 2.7.5…');
    q('[data-update-go]').click();
    await render(320);
    expect(dialog()?.textContent).toContain('Update GTNH to GT New Horizons 2.7.5?');
    expect(dialogButton('ok').textContent?.trim()).toBe('Update to 2.7.5');
    dialogButton('ok').click();
    await render();
    const req = backend.expectOne('/api/servers/gtnh/pack/update');
    expect(req.request.body).toEqual({ library: 2 });
    req.flush({ id: 2 }, { status: 202, statusText: 'Accepted' });
  });

  it("disables Update and Apply with the hub's reason, or when the server is offline", async () => {
    const busy = await setup({ ...INSTALLED, blocked: 'A restore is running on GTNH.', pending: [{ path: 'a', kind: 'extra', change: 'added' }] });
    expect(busy.q<HTMLButtonElement>('[data-update]').disabled).toBe(true);
    expect(busy.q<HTMLButtonElement>('[data-apply]').disabled).toBe(true);
    expect(busy.text(busy.el.querySelector('[data-update-why]'))).toBe('A restore is running on GTNH.');
    TestBed.resetTestingModule();
    const offline = await setup(INSTALLED, { ...CARD, online: false });
    expect(offline.q<HTMLButtonElement>('[data-update]').disabled).toBe(true);
    expect(offline.text(offline.el.querySelector('[data-update-why]'))).toBe('GTNH is offline: an update needs it running, for the backup.');
  });

  it('shows a failure while preparing as a red box naming its cause', async () => {
    const failed = row({
      id: 3,
      from: '2.7.4',
      to: '2.7.5',
      outcome: 'failed in staging',
      step: 'prepare',
      backup: null,
      log: 'The Config edit on config/GregTech/Pollution.cfg (pollution=true) matched nothing in 2.7.5.\nprepare: failed: The Config edit on config/GregTech/Pollution.cfg (pollution=true) matched nothing in 2.7.5.',
    });
    const { el, text } = await setup({ ...INSTALLED, history: [failed, row({})] });
    const box = text(el.querySelector('[data-failed-prep]'));
    expect(box).toContain("Update to 2.7.5 failed while preparing. The server wasn't touched.");
    expect(box).toContain('config/GregTech/Pollution.cfg (pollution=true) matched nothing in 2.7.5.');
  });

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
    TestBed.configureTestingModule({ providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }] });
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

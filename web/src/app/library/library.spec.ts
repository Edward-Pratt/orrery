import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { LibraryAdd, LibraryPack, LibraryState } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { dialog, dialogButton, fakeEvents } from '../testing';
import routes from './routes';

const PACK: LibraryPack = {
  id: 2,
  name: 'GT New Horizons',
  version: '2.7.4',
  mc: '1.7.10',
  loader: 'forge',
  sha256: '9f2c1e0123456789abcdef',
  size: 1024 ** 3,
  source: 'https://github.com/GTNewHorizons/pack/releases/download/2.7.4/GT_New_Horizons_2.7.4_Server_Java_17-21.zip',
  by: 'alex',
  at: Date.UTC(2026, 8, 20),
  usedBy: [],
};
const ADD = { type: 'libraryAdd', add: 3, name: 'GT New Horizons', version: '2.7.5', by: 'alex' } as const;
const EMPTY: LibraryState = { packs: [], running: null };
const RUNNING: LibraryState = { packs: [PACK], running: { add: 3, name: 'GT New Horizons', version: '2.7.5', by: 'alex', started: 0, detail: 'Downloading' } };

async function setup(state: LibraryState) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }, { provide: RETRY_MS, useValue: 0 }],
  });
  const harness = await RouterTestingHarness.create();
  const backend = TestBed.inject(HttpTestingController);
  await harness.navigateByUrl('/');
  const el = harness.routeNativeElement as HTMLElement;
  const render = async (ms = 10) => (await new Promise((r) => setTimeout(r, ms)), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  await render();
  backend.expectOne('/api/library').flush(state);
  await render();
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => (el.querySelector<T>(sel) ?? document.querySelector<T>(sel))!;
  const type = async (sel: string, value: string) => {
    const input = q<HTMLInputElement>(sel);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  const reload = async (next: LibraryState) => {
    await render(70);
    backend.expectOne('/api/library').flush(next);
    await render();
  };
  let n = 1;
  const push = async (e: LibraryAdd) => {
    events.push(n++, { ...e, target: 'library', id: 'packs' });
    await render();
  };
  return { el, backend, render, text, q, type, reload, push };
}

describe('library page', () => {
  it('starts empty, with Add pack', async () => {
    const { el, text, q } = await setup(EMPTY);
    expect(text(el.querySelector('[data-empty]'))).toContain('No packs yet');
    expect(q<HTMLButtonElement>('[data-add]').disabled).toBe(false);
    expect(el.querySelector('[data-running]')).toBeNull();
  });

  it('lists each pack with its Minecraft version, loader, size, source, sha256, who added it and its servers', async () => {
    const { el, text } = await setup({ packs: [PACK, { ...PACK, id: 1, version: '2.7.3', usedBy: ['gtnh'] }], running: null });
    expect([...el.querySelectorAll('[data-pack] [data-name]')].map(text)).toEqual(['GT New Horizons 2.7.4', 'GT New Horizons 2.7.3']);
    const row = el.querySelector('[data-pack="2"]')!;
    expect(text(row.querySelector('[data-meta]'))).toContain('Minecraft 1.7.10 · forge · 1.0 GB · added by alex');
    expect(text(row.querySelector('[data-source]'))).toBe(PACK.source);
    expect(text(row.querySelector('[data-sha]'))).toBe('sha256 9f2c1e0123456789abcdef');
    expect(text(row.querySelector('[data-used]'))).toBe('used by no server');
    expect(text(el.querySelector('[data-pack="1"] [data-used]'))).toBe('used by gtnh');
  });

  it('adds from a link: name and version from the file name, the rest left to the zip', async () => {
    const { q, type, render, backend, reload } = await setup(EMPTY);
    q('[data-add]').click();
    await render();
    expect(q<HTMLButtonElement>('[data-go]').disabled).toBe(true);
    await type('[data-url]', PACK.source);
    expect(q<HTMLInputElement>('[data-name]').value).toBe('GT New Horizons');
    expect(q<HTMLInputElement>('[data-version]').value).toBe('2.7.4');
    q('[data-go]').click();
    await render();
    const req = backend.expectOne('/api/library/packs');
    expect(req.request.body).toEqual({ url: PACK.source, name: 'GT New Horizons', version: '2.7.4', mc: '', loader: '' });
    req.flush({ add: 1 }, { status: 202, statusText: 'Accepted' });
    await reload(RUNNING);
    expect(document.querySelector('[data-sheet]')).toBeNull();
  });

  it('shows the running add, follows its progress and cancels it; no Add meanwhile', async () => {
    const { el, text, q, render, backend, push, reload } = await setup(RUNNING);
    expect(text(el.querySelector('[data-running]'))).toContain('Adding GT New Horizons 2.7.5 (by alex)');
    expect(q<HTMLButtonElement>('[data-add]').disabled).toBe(true);
    await push({ ...ADD, phase: 'progress', detail: 'Downloading 412.0 MB of 1.0 GB' });
    expect(text(el.querySelector('[data-detail]'))).toBe('Downloading 412.0 MB of 1.0 GB');
    q('[data-cancel]').click();
    await render();
    const cancel = backend.expectOne('/api/library/cancel');
    expect(cancel.request.headers.get('content-type')).toBe('application/json');
    cancel.flush(null, { status: 204, statusText: 'No Content' });
    await push({ ...ADD, phase: 'finished', outcome: 'cancelled', reason: '' });
    await reload({ packs: [PACK], running: null });
    expect(el.querySelector('[data-running]')).toBeNull();
    expect(el.querySelector('[data-ended]')).toBeNull(); // nothing to say about a cancel
  });

  it('says why a failed add failed', async () => {
    const { el, text, push, reload } = await setup(RUNNING);
    await push({ ...ADD, phase: 'finished', outcome: 'failed', reason: 'The zip has no mods/ or config/ folder: is it a server pack?' });
    await reload({ packs: [PACK], running: null });
    expect(el.querySelector('[data-running]')).toBeNull();
    expect(text(el.querySelector('[data-ended=failed]'))).toBe('Adding GT New Horizons 2.7.5 failed: The zip has no mods/ or config/ folder: is it a server pack?');
  });

  it('deletes a pack once its name and version are typed', async () => {
    const { q, render, backend, reload } = await setup({ packs: [PACK], running: null });
    q('[data-pack="2"] [data-delete]').click();
    await render();
    expect(dialog()?.textContent).toContain('Delete GT New Horizons 2.7.4?');
    expect(dialogButton('ok').disabled).toBe(true);
    const typed = document.querySelector<HTMLInputElement>('[data-confirm-typed]')!;
    typed.value = 'GT New Horizons 2.7.4';
    typed.dispatchEvent(new Event('input'));
    await render();
    dialogButton('ok').click();
    await render();
    const del = backend.expectOne((r) => r.method === 'DELETE' && r.url === '/api/library/packs/2');
    expect(del.request.headers.get('content-type')).toBe('application/json');
    del.flush(null, { status: 204, statusText: 'No Content' });
    await reload(EMPTY);
  });
});

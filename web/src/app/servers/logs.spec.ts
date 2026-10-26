import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { ServerCard, ServerDetail, ServerLogFiles, ServiceStatus } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, settle } from '../testing';
import routes from './routes';

const CARD: ServerCard = {
  id: 'gtnh',
  name: 'GTNH',
  online: false,
  hung: false,
  tps: null,
  players: [],
  uptimeDay: null,
  restart: null,
  lagging: false,
  service: null,
  features: { chat: true, tps: true, quests: true },
  packUpdate: null,
};
const GTNH: ServiceStatus = { id: 'gtnh', unit: 'gtnh.service', state: 'failed', sub: 'failed', checks: [] };
const detail = (more: Partial<ServerDetail> = {}) =>
  ({ card: CARD, service: null, top: { day: [], week: [], all: [] }, backups: { configured: false }, pack: false, logs: true, ...more }) as ServerDetail;
// The crash report is the newest, but latest.log is shown first.
const FILES: ServerLogFiles = [
  { name: 'crash-2026-10-26_10.00.00-server.txt', size: 2048, modified: Date.UTC(2026, 9, 26, 10) },
  { name: 'latest.log', size: 1536, modified: Date.UTC(2026, 9, 26, 9) },
  { name: '2026-10-25-1.log.gz', size: 512, modified: Date.UTC(2026, 9, 25) },
];

/** Opens the server's Logs tab and answers its detail; the listing and files are left to each test. */
async function setup(more: Partial<ServerDetail> = {}) {
  TestBed.configureTestingModule({
    providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: fakeEvents().fetch }, { provide: RETRY_MS, useValue: 0 }],
  });
  const harness = await RouterTestingHarness.create();
  const backend = TestBed.inject(HttpTestingController);
  await harness.navigateByUrl('/gtnh/logs');
  backend.expectOne('/api/servers/gtnh').flush(detail(more));
  const el = harness.routeNativeElement as HTMLElement;
  const render = async () => (await settle(), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  await render();
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  const shown = () => [...el.querySelectorAll('[data-line]')].map((l) => l.textContent);
  const tabs = () => [...el.querySelectorAll('[data-sections] a')].map(text);
  return { backend, el, render, text, shown, tabs };
}

describe('server logs section', () => {
  it('is a tab only when the server has a folder', async () => {
    expect((await setup()).tabs()).toContain('Logs');
    TestBed.resetTestingModule();
    const folderless = await setup({ logs: false });
    expect(folderless.tabs()).not.toContain('Logs');
    expect(folderless.text(folderless.el)).toContain('no server folder');
    folderless.backend.verify(); // nothing asked of the hub
  });

  it('lists the files newest first with size and time, and shows latest.log first', async () => {
    const { backend, el, render, text, shown } = await setup();
    expect(el.querySelector('[data-skeleton]')).not.toBeNull();
    backend.expectOne('/api/servers/gtnh/logs').flush(FILES);
    await render();
    const files = [...el.querySelectorAll<HTMLElement>('[data-file]')];
    expect(files.map((f) => f.getAttribute('data-file'))).toEqual(FILES.map((f) => f.name));
    expect(text(files[1])).toContain('1.5 KB');
    backend.expectOne('/api/servers/gtnh/logs/latest.log').flush({ lines: ['[Server thread/INFO]: Starting', '[Server thread/INFO]: Done'] });
    await render();
    expect(text(el.querySelector('[data-chosen]'))).toBe('latest.log');
    expect(files[1]!.getAttribute('aria-current')).toBe('true');
    expect(shown()).toEqual(['[Server thread/INFO]: Starting', '[Server thread/INFO]: Done']);
    expect(el.querySelector('[data-journal]')).toBeNull(); // no linked service
  });

  it('shows the newest file without a latest.log, and says when there are none', async () => {
    const first = await setup();
    first.backend.expectOne('/api/servers/gtnh/logs').flush(FILES.filter((f) => f.name !== 'latest.log'));
    await first.render();
    first.backend.expectOne(`/api/servers/gtnh/logs/${encodeURIComponent(FILES[0]!.name)}`).flush({ lines: ['---- Minecraft Crash Report ----'] });
    await first.render();
    expect(first.shown()).toEqual(['---- Minecraft Crash Report ----']);
    TestBed.resetTestingModule();
    const empty = await setup();
    empty.backend.expectOne('/api/servers/gtnh/logs').flush([]);
    await empty.render();
    expect(empty.el.querySelector('[data-empty]')).not.toBeNull();
    empty.backend.verify();
  });

  it('switches files, and a slower answer for the old one is dropped', async () => {
    const { backend, el, render, text, shown } = await setup();
    backend.expectOne('/api/servers/gtnh/logs').flush(FILES);
    await render();
    const latest = backend.expectOne('/api/servers/gtnh/logs/latest.log');
    el.querySelector<HTMLButtonElement>('[data-file="2026-10-25-1.log.gz"]')!.click();
    await render();
    expect(latest.cancelled).toBe(true);
    backend.expectOne('/api/servers/gtnh/logs/2026-10-25-1.log.gz').flush({ lines: ['yesterday'] });
    await render();
    expect(text(el.querySelector('[data-chosen]'))).toBe('2026-10-25-1.log.gz');
    expect(shown()).toEqual(['yesterday']);
  });

  it('Refresh fetches the listing and the shown file again; a failed read says why', async () => {
    const { backend, el, render, shown } = await setup();
    backend.expectOne('/api/servers/gtnh/logs').flush(FILES);
    await render();
    backend.expectOne('/api/servers/gtnh/logs/latest.log').flush({ lines: ['one'] });
    await render();
    el.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    backend.expectOne('/api/servers/gtnh/logs').flush(FILES);
    await render();
    expect(shown()).toEqual(['one']); // kept until the new lines arrive
    backend.expectOne('/api/servers/gtnh/logs/latest.log').flush({ lines: ['one', 'two'] });
    await render();
    expect(shown()).toEqual(['one', 'two']);
    el.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    backend.expectOne('/api/servers/gtnh/logs').flush(FILES);
    await render();
    backend.expectOne('/api/servers/gtnh/logs/latest.log').flush('Reading latest.log failed: EACCES', { status: 502, statusText: 'Bad Gateway' });
    await render();
    expect(el.querySelector('[data-log-error]')?.textContent).toContain('latest.log couldn\'t be read (HTTP 502: Reading latest.log failed: EACCES)');
    el.querySelector<HTMLButtonElement>('[data-refresh]')!.click();
    backend.expectOne('/api/servers/gtnh/logs').flush('Bad Gateway', { status: 502, statusText: 'Bad Gateway' });
    await render();
    expect(el.querySelectorAll('[data-file]').length).toBe(3);
    expect(el.querySelector('[data-log-error]')?.textContent).toContain("The logs couldn't be listed (HTTP 502: Bad Gateway)");
    expect(el.querySelector<HTMLButtonElement>('[data-refresh]')!.disabled).toBe(false);
  });

  it("with a linked service, shows its journal from the services logs, with its own Refresh", async () => {
    const { backend, el, render } = await setup({ card: { ...CARD, service: { id: 'gtnh', state: 'failed' } }, service: GTNH });
    backend.expectOne('/api/servers/gtnh/logs').flush(FILES);
    backend.expectOne('/api/services/gtnh/logs').flush({ lines: ['gtnh.service: Failed', 'exit code 1'] });
    await render();
    backend.expectOne('/api/servers/gtnh/logs/latest.log').flush({ lines: [] });
    await render();
    expect(el.querySelector('[data-journal] h2')?.textContent).toContain('gtnh.service journal');
    expect(el.querySelector('[data-journal-lines]')?.textContent).toBe('gtnh.service: Failed\nexit code 1');
    el.querySelector<HTMLButtonElement>('[data-journal-refresh]')!.click();
    backend.expectOne('/api/services/gtnh/logs').flush({ lines: ['started'] });
    await render();
    expect(el.querySelector('[data-journal-lines]')?.textContent).toBe('started');
  });
});

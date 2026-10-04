import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, RouterOutlet } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { Integrations, LibraryState, NewServerRequest, PendingServer, PendingServers } from '@hub/api';
import { HlmToaster } from '@spartan-ng/helm/sonner';
import { FETCH, RETRY_MS } from '../events';
import { dialog, dialogButton, fakeEvents, toasts } from '../testing';
import routes from './routes';

const ON: Integrations = { minecraft: true, discord: false, web: true, checks: false, host: false, systemd: true, github: true, library: true, newServer: true };
const LIBRARY: LibraryState = {
  packs: [{ id: 2, name: 'GT New Horizons', version: '2.7.4', mc: '1.7.10', loader: 'forge', sha256: 'ab', size: 1, source: 'x', by: 'alex', at: 0, usedBy: [] }],
  runtimes: [
    { name: 'temurin-21.0.8+9', label: 'Temurin 21.0.8+9', feature: 21, size: 1, sha256: 'cd', by: 'alex', at: 2, usedBy: [] },
    { name: 'temurin-17.0.1+1', label: 'Temurin 17.0.1+1', feature: 17, size: 1, sha256: 'ef', by: 'alex', at: 1, usedBy: [] },
  ],
  running: null,
};
const NEW_1: PendingServer = {
  id: 'new-1',
  name: 'New One',
  dir: '/srv/orrery/servers/new-1',
  gamePort: 25570,
  runtime: null,
  by: 'alex',
  at: Date.UTC(2026, 9, 4),
  command: 'sudo /usr/local/lib/orrery/add-server.sh new-1 /srv/orrery --hub-unit orrery-hub.service',
  installScript: 'sudo install -D -m 755 -o root -g root -t /usr/local/lib/orrery /srv/orrery/current/deploy/add-server.sh',
};

@Component({ imports: [HlmToaster, RouterOutlet], template: `<hlm-toaster /><router-outlet />` })
class Shell {}

async function setup(url: string) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '', component: Shell, children: [{ path: 'servers', children: routes }] }]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: FETCH, useValue: events.fetch },
      { provide: RETRY_MS, useValue: 0 },
    ],
  });
  const harness = await RouterTestingHarness.create();
  const backend = TestBed.inject(HttpTestingController);
  await harness.navigateByUrl(url);
  const render = async (ms = 10) => (await new Promise((r) => setTimeout(r, ms)), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  await render();
  const el = harness.fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => (el.querySelector<T>(sel) ?? document.querySelector<T>(sel))!;
  const text = (sel: string) => q(sel)?.textContent?.replace(/\s+/g, ' ').trim();
  const set = async (sel: string, value: string, event = 'input') => {
    const input = q<HTMLInputElement | HTMLSelectElement>(sel);
    input.value = value;
    input.dispatchEvent(new Event(event));
    await render();
  };
  const click = async (sel: string) => (q(sel).click(), await render());
  return { events, backend, render, el, q, text, set, click };
}

/** The Servers page with New server on, its sheet open and the library read. */
async function openSheet() {
  const s = await setup('/servers');
  s.backend.expectOne('/api/servers').flush([]);
  s.backend.expectOne('/api/integrations').flush(ON);
  await s.render(70);
  s.backend.expectOne('/api/servers/pending').flush({ pending: [], installing: null } satisfies PendingServers);
  await s.render();
  await s.click('[data-new-server]');
  await s.render(50);
  s.backend.expectOne('/api/library').flush(LIBRARY);
  await s.render();
  return s;
}

describe('New server', () => {
  it('is offered only when the hub has New server on', async () => {
    const s = await setup('/servers');
    s.backend.expectOne('/api/servers').flush([]);
    s.backend.expectOne('/api/integrations').flush({ ...ON, newServer: false });
    await s.render(70);
    expect(s.q('[data-new-server]')).toBeNull();
    s.backend.expectNone('/api/servers/pending');
  });

  it('waits for a valid id, name, port, memory, pack, script and the EULA tick, pre-ticking the loop edit', async () => {
    const { q, set, click, render, backend, text } = await openSheet();
    const go = () => q<HTMLButtonElement>('[data-go]').disabled;
    expect(q<HTMLSelectElement>('[data-runtime]').value).toBe('temurin-21.0.8+9'); // the newest
    expect(go()).toBe(true);
    await set('[data-id]', 'Creative');
    expect(text('[data-id-error]')).toContain('lowercase letter');
    await set('[data-id]', 'creative');
    expect(q('[data-id-error]')).toBeNull();
    await set('[data-name]', 'Creative');
    await set('[data-memory]', '8 GB');
    expect(q('[data-memory-error]')).not.toBeNull();
    await set('[data-memory]', '8G');
    await set('[data-port]', '25570');
    await set('[data-pick]', '2', 'change');
    backend.expectOne('/api/library/packs/2/scripts').flush({ scripts: [{ name: 'startserver-java9.sh', loops: true }, { name: 'startserver.sh', loops: false }] });
    await render();
    expect(q<HTMLSelectElement>('[data-script]').value).toBe('startserver-java9.sh');
    expect(q<HTMLInputElement>('[data-loop]').checked).toBe(true);
    expect(go()).toBe(true); // no EULA yet
    await click('[data-eula]');
    expect(go()).toBe(false);
    await set('[data-script]', 'startserver.sh', 'change');
    expect(q('[data-loop]')).toBeNull(); // no loop to remove
    await set('[data-script]', 'startserver-java9.sh', 'change');
    await click('[data-loop]'); // unticked
    await set('[data-runtime]', '', 'change');
    await click('[data-go]');
    const post = backend.expectOne((r) => r.method === 'POST' && r.url === '/api/servers');
    expect(post.request.body).toEqual({
      id: 'creative',
      name: 'Creative',
      gamePort: 25570,
      memory: '8G',
      library: 2,
      startScript: 'startserver-java9.sh',
      runtime: null,
      eula: true,
      removeLoop: false,
    } satisfies NewServerRequest);
    post.flush({ id: 'creative' }, { status: 202, statusText: 'Accepted' });
    await render(70);
    backend.expectOne('/api/servers/pending').flush({ pending: [], installing: { id: 'creative', name: 'Creative', by: 'alex', started: 0, step: 'unpack', detail: 'Unpacking' } });
    await render();
    expect(q('[data-sheet]')).toBeNull();
    expect(text('[data-installing]')).toContain('Installing Creative');
  });

  it("shows the hub's refusal and keeps the sheet open", async () => {
    const { set, click, render, backend, q } = await openSheet();
    await set('[data-id]', 'gtnh');
    await set('[data-name]', 'Again');
    await set('[data-pick]', '2', 'change');
    backend.expectOne('/api/library/packs/2/scripts').flush({ scripts: [{ name: 'startserver.sh', loops: false }] });
    await render();
    await click('[data-eula]');
    await click('[data-go]');
    backend.expectOne('/api/servers').flush('The id gtnh is a server in config already.', { status: 409, statusText: 'Conflict' });
    await render();
    expect(toasts().join()).toContain('The id gtnh is a server in config already.');
    expect(q('[data-sheet]')).not.toBeNull();
  });

  it('lists a Pending server as Waiting for setup, and a failed install says why', async () => {
    const s = await setup('/servers');
    s.backend.expectOne('/api/servers').flush([]);
    s.backend.expectOne('/api/integrations').flush(ON);
    await s.render(70);
    s.backend.expectOne('/api/servers/pending').flush({ pending: [NEW_1], installing: null } satisfies PendingServers);
    await s.render();
    expect(s.text('[data-pending=new-1]')).toBe('New OneWaiting for setupport 25570: run the setup command →');
    expect(s.q('[data-pending=new-1]').getAttribute('href')).toBe('/servers/waiting/new-1');
    s.events.push(1, { target: 'install', id: 'new-2', type: 'install', step: 'failed', detail: 'GitHub: HTTP 502', name: 'Two', by: 'alex' });
    await s.render(70);
    s.backend.expectOne('/api/servers/pending').flush({ pending: [NEW_1], installing: null } satisfies PendingServers);
    await s.render();
    expect(s.text('[data-install-failed]')).toBe('Installing Two failed: GitHub: HTTP 502');
  });
});

describe('a waiting server', () => {
  it('shows the setup command after the install line when the root copy is missing, and copies it', async () => {
    const s = await setup('/servers/waiting/new-1');
    s.backend.expectOne('/api/servers/pending').flush({ pending: [NEW_1], installing: null } satisfies PendingServers);
    await s.render();
    expect(s.text('[data-badge]')).toBe('Waiting for setup');
    expect([...s.el.querySelectorAll('[data-step]')].map((e) => e.getAttribute('data-step'))).toEqual(['install', 'run']);
    expect(s.text('[data-step=install] [data-command]')).toBe(NEW_1.installScript);
    expect(s.text('[data-step=run] [data-command]')).toBe(NEW_1.command);
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
    await s.click('[data-step=run] [data-copy]');
    expect(copied).toEqual([NEW_1.command]);
  });

  it('shows only the command once the script is installed', async () => {
    const s = await setup('/servers/waiting/new-1');
    s.backend.expectOne('/api/servers/pending').flush({ pending: [{ ...NEW_1, installScript: null }], installing: null } satisfies PendingServers);
    await s.render();
    expect([...s.el.querySelectorAll('[data-step]')].map((e) => e.getAttribute('data-step'))).toEqual(['run']);
  });

  it('Discard asks for the typed id, then deletes it', async () => {
    const s = await setup('/servers/waiting/new-1');
    s.backend.expectOne('/api/servers/pending').flush({ pending: [NEW_1], installing: null } satisfies PendingServers);
    await s.render();
    await s.click('[data-discard]');
    expect(dialog()?.textContent).toContain('Discard New One?');
    expect(dialogButton('ok').disabled).toBe(true);
    const typed = dialog()!.querySelector('input')!;
    typed.value = 'new-1';
    typed.dispatchEvent(new Event('input'));
    await s.render();
    dialogButton('ok').click();
    await s.render();
    const del = s.backend.expectOne((r) => r.method === 'DELETE' && r.url === '/api/servers/pending/new-1');
    expect(del.request.headers.get('content-type')).toBe('application/json');
    del.flush(null, { status: 204, statusText: 'No Content' });
    await s.render();
    expect(toasts().join()).toContain('Discarded New One.');
  });

  it('says so when there is no such Pending server', async () => {
    const s = await setup('/servers/waiting/gone');
    s.backend.expectOne('/api/servers/pending').flush({ pending: [], installing: null } satisfies PendingServers);
    await s.render();
    expect(s.text('[data-missing]')).toContain('No Pending server gone');
  });
});

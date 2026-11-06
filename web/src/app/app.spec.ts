import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { EnvironmentInfo, Integrations, Me } from '@hub/api';
import { App } from './app';
import { FETCH } from './events';
import { Session } from './session';
import { fakeEvents, OWNER, settle, VIEWER } from './testing';
import { Theme } from './theme';

const ALEX: Me = OWNER;
const ALL: Integrations = { minecraft: true, discord: true, web: true, checks: true, host: true, systemd: true, github: false, agents: false, library: false, newServer: false };

/** `env`: what /api/environment answers, or `error` when it fails. */
async function open(me: Me | null, on: Integrations = ALL, url = '/', env: EnvironmentInfo['environment'] | 'error' = 'production') {
  history.replaceState(null, '', url);
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: fakeEvents().fetch }],
  });
  const fixture = TestBed.createComponent(App);
  const backend = TestBed.inject(HttpTestingController);
  await settle();
  const environment = backend.expectOne('/api/environment');
  if (env === 'error') environment.flush('Bad gateway', { status: 502, statusText: 'Bad Gateway' });
  else environment.flush({ environment: env });
  const req = backend.expectOne('/api/me');
  if (me) req.flush(me);
  else req.flush('Not logged in', { status: 401, statusText: 'Unauthorized' });
  await settle();
  backend.match('/api/integrations').forEach((r) => r.flush(on));
  await settle();
  fixture.detectChanges();
  return { fixture, backend, el: fixture.nativeElement as HTMLElement };
}

const labels = (el: HTMLElement) => [...el.querySelectorAll('aside nav a')].map((a) => a.textContent!.trim());

describe('the shell', () => {
  afterEach(() => (document.documentElement.classList.remove('dark'), localStorage.clear(), (document.title = '')));

  const badges = (el: HTMLElement) => [...el.querySelectorAll('[data-staging]')].map((b) => b.closest('aside, header, .rounded-xl')!.tagName);

  it('marks Staging with a badge in the sidebar, the phone header and the login card, and in the tab title', async () => {
    const staging = await open(ALEX, ALL, '/', 'staging');
    expect(badges(staging.el)).toEqual(['ASIDE', 'HEADER']);
    expect(staging.el.querySelector('[data-staging]')!.textContent!.trim()).toBe('Staging');
    expect(document.title).toBe('orrery (staging)');
    TestBed.resetTestingModule();
    const login = await open(null, ALL, '/', 'staging');
    expect(badges(login.el)).toEqual(['DIV']);
    expect(document.title).toBe('orrery (staging)');
  });

  it('shows no badge on Production, or when the hub cannot say', async () => {
    for (const env of ['production', 'error'] as const) {
      for (const me of [ALEX, null]) {
        const r = await open(me, ALL, '/', env);
        expect(r.el.querySelector('[data-staging]')).toBeNull();
        expect(document.title).toBe('orrery');
        TestBed.resetTestingModule();
      }
    }
  });

  it('lists the pages of the integrations that are on, in order', async () => {
    const all = await open(ALEX, { ...ALL, library: true });
    expect(labels(all.el)).toEqual(['Servers', 'Services', 'Host', 'Library', 'Audit log', 'Users']);
    TestBed.resetTestingModule();
    const some = await open(ALEX, { ...ALL, minecraft: false, checks: false, host: false });
    expect(labels(some.el)).toEqual(['Servers', 'Services', 'Audit log', 'Users']);
    TestBed.resetTestingModule();
    const checksOnly = await open(ALEX, { ...ALL, minecraft: false, systemd: false, github: false, host: false });
    expect(labels(checksOnly.el)).toEqual(['Servers', 'Checks', 'Audit log', 'Users']); // the services page, without systemd
  });

  it('lists the pages after a login on the page, with no reload: integrations are asked only once logged in', async () => {
    const r = await open(null);
    expect(r.backend.match('/api/integrations')).toEqual([]); // asked logged out, it would be a 401 for good
    TestBed.inject(Session).user.set(ALEX);
    await settle();
    r.backend.expectOne('/api/integrations').flush(ALL);
    await settle();
    r.fixture.detectChanges();
    expect(labels(r.el)).toEqual(['Servers', 'Services', 'Host', 'Audit log', 'Users']);
  });

  it('shows Library, Audit log and Users only to a user with that permission', async () => {
    const viewer = await open(VIEWER, { ...ALL, library: true });
    expect(labels(viewer.el)).toEqual(['Servers', 'Services', 'Host']);
    TestBed.resetTestingModule();
    const auditor = await open({ ...VIEWER, permissions: [{ permission: 'audit', servers: null }] }, { ...ALL, library: true });
    expect(labels(auditor.el)).toEqual(['Servers', 'Services', 'Host', 'Audit log']);
  });

  const openMenu = async (r: Awaited<ReturnType<typeof open>>) => {
    (r.el.querySelector('aside button[aria-label="Account menu"]') as HTMLElement).click();
    r.fixture.detectChanges();
    await settle();
    return [...document.body.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')];
  };

  it('offers Account, Theme and Log out in the user menu, and Log out logs out', async () => {
    const r = await open(ALEX);
    const items = await openMenu(r);
    expect(document.body.textContent).toContain('Theme');
    expect(items.map((i) => i.textContent!.replace(/\s+/g, ' ').trim().replace(/on$/, ''))).toEqual(['Account', 'light', 'system', 'dark', 'Log out']);
    items.find((i) => i.textContent!.includes('Log out'))!.click();
    r.backend.expectOne('/api/logout').flush(null, { status: 204, statusText: 'No Content' });
    r.fixture.detectChanges();
    expect(r.el.querySelector('aside')).toBeNull();
  });

  it('picks a theme from the menu', async () => {
    const r = await open(ALEX);
    (await openMenu(r)).find((i) => i.textContent!.includes('dark'))!.click();
    r.fixture.detectChanges();
    TestBed.tick();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('has a phone tab bar with the same pages', async () => {
    const { el } = await open(ALEX);
    const tabs = [...el.querySelectorAll('nav.fixed a')].map((a) => a.textContent!.trim());
    expect(tabs).toEqual(['Servers', 'Services', 'Host', 'Audit log', 'Users']);
  });

  it("shows the user's initials", async () => {
    const { el } = await open(ALEX);
    expect(el.querySelector('aside img')).toBeNull();
    expect(el.querySelector('aside [data-slot="avatar"]')!.textContent).toContain('AL');
  });

  it('takes an invite opened while logged in out of the address, and says to log out first', async () => {
    const { el } = await open(ALEX, ALL, '/?invite=tok');
    expect(location.search).toBe('');
    await settle();
    expect(document.body.textContent).toContain('log out, then open the invite link again');
    expect(el.querySelector('[data-login-form]')).toBeNull();
  });

  it('shows the login card and no sidebar when logged out', async () => {
    const { el } = await open(null);
    expect(el.querySelector('aside')).toBeNull();
    expect(el.querySelector('[data-login-form]')).not.toBeNull();
  });
});

describe('Theme', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => (vi.restoreAllMocks(), document.documentElement.classList.remove('dark')));

  it('follows the system by default, stores a choice and restores it', () => {
    expect(TestBed.inject(Theme).mode()).toBe('system');
    TestBed.inject(Theme).set('dark');
    TestBed.tick();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');
    TestBed.resetTestingModule();
    expect(TestBed.inject(Theme).mode()).toBe('dark');
  });

  it('still works when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const theme = TestBed.inject(Theme);
    expect(theme.mode()).toBe('system');
    theme.set('light');
    expect(theme.mode()).toBe('light');
  });

  it('still works when the storage accessor itself throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    const theme = TestBed.inject(Theme);
    expect(theme.mode()).toBe('system');
    expect(() => theme.set('dark')).not.toThrow();
  });
});

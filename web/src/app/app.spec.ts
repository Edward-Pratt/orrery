import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { EnvironmentInfo, Integrations, Me } from '@hub/api';
import { By } from '@angular/platform-browser';
import { App, UserMenu } from './app';
import { FETCH } from './events';
import { fakeEvents, settle } from './testing';
import { Theme } from './theme';

const ALEX: Me = { id: '5', username: 'alex', avatar: null };
const ALL: Integrations = { minecraft: true, discord: true, web: true, checks: true, host: true, systemd: true, github: false, library: false };

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
    const all = await open(ALEX);
    expect(labels(all.el)).toEqual(['Servers', 'Services', 'Host', 'Audit log']);
    TestBed.resetTestingModule();
    const some = await open(ALEX, { ...ALL, minecraft: false, checks: false, host: false });
    expect(labels(some.el)).toEqual(['Servers', 'Services', 'Audit log']);
    TestBed.resetTestingModule();
    const checksOnly = await open(ALEX, { ...ALL, minecraft: false, systemd: false, github: false, host: false });
    expect(labels(checksOnly.el)).toEqual(['Servers', 'Checks', 'Audit log']); // the services page, without systemd
  });

  const openMenu = async (r: Awaited<ReturnType<typeof open>>) => {
    (r.el.querySelector('aside button[aria-label="Account menu"]') as HTMLElement).click();
    r.fixture.detectChanges();
    await settle();
    return [...document.body.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')];
  };

  it('offers Theme and Log out in the avatar menu, and Log out logs out', async () => {
    const r = await open(ALEX);
    const items = await openMenu(r);
    expect(document.body.textContent).toContain('Theme');
    expect(items.map((i) => i.textContent!.replace(/\s+/g, ' ').trim().replace(/on$/, ''))).toEqual(['light', 'system', 'dark', 'Log out']);
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
    expect(tabs).toEqual(['Servers', 'Services', 'Host', 'Audit log']);
  });

  it('shows the Discord image with an avatar hash, initials without', async () => {
    const withImg = await open({ ...ALEX, avatar: 'abc' });
    // the <img> is only rendered once the browser has loaded it, which jsdom never does
    const menu = withImg.fixture.debugElement.query(By.directive(UserMenu)).componentInstance as { avatarUrl(): string };
    expect(menu.avatarUrl()).toBe('https://cdn.discordapp.com/avatars/5/abc.png?size=64');
    TestBed.resetTestingModule();
    const plain = await open(ALEX);
    expect(plain.el.querySelector('aside img')).toBeNull();
    expect(plain.el.querySelector('aside [data-slot="avatar"]')!.textContent).toContain('AL');
  });

  it('shows the login card, no sidebar, and the reason for a failed login', async () => {
    const { el } = await open(null, ALL, '/?login=admin');
    expect(el.querySelector('aside')).toBeNull();
    expect(el.textContent).toContain('Log in with Discord');
    expect(el.textContent).toContain('not an admin');
    TestBed.resetTestingModule();
    const plain = await open(null);
    expect(plain.el.textContent).not.toContain('not an admin');
    TestBed.resetTestingModule();
    expect((await open(null, ALL, '/?login=state')).el.textContent).toContain('expired');
    TestBed.resetTestingModule();
    expect((await open(null, ALL, '/?login=discord')).el.textContent).toContain('Discord did not answer');
    TestBed.resetTestingModule();
    expect((await open(null, ALL, '/?login=constructor')).el.textContent).not.toContain('function');
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

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Integrations, Me } from '@hub/api';
import { By } from '@angular/platform-browser';
import { App, UserMenu } from './app';
import { FETCH } from './events';
import { fakeEvents, settle } from './testing';
import { Theme } from './theme';

const ALEX: Me = { id: '5', username: 'alex', avatar: null };
const ALL: Integrations = { minecraft: true, discord: true, web: true, checks: true, host: true, systemd: true };

async function open(me: Me | null, on: Integrations = ALL, url = '/') {
  history.replaceState(null, '', url);
  TestBed.configureTestingModule({
    providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: fakeEvents().fetch }],
  });
  const fixture = TestBed.createComponent(App);
  const backend = TestBed.inject(HttpTestingController);
  await settle();
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
  afterEach(() => (document.documentElement.classList.remove('dark'), localStorage.clear()));

  it('lists the pages of the integrations that are on, in order', async () => {
    const all = await open(ALEX);
    expect(labels(all.el)).toEqual(['Servers', 'Services', 'Checks', 'Host', 'Audit log']);
    TestBed.resetTestingModule();
    const some = await open(ALEX, { ...ALL, minecraft: false, checks: false, host: false });
    expect(labels(some.el)).toEqual(['Services', 'Audit log']);
  });

  it('offers Theme and Log out in the avatar menu, and Log out logs out', async () => {
    const { fixture, backend, el } = await open(ALEX);
    (el.querySelector('aside button[aria-label="Account menu"]') as HTMLElement).click();
    fixture.detectChanges();
    await settle();
    const items = [...document.body.querySelectorAll('[hlmDropdownMenuItem], [data-slot="dropdown-menu-item"]')].map((i) => i.textContent!.trim());
    expect(document.body.textContent).toContain('Theme');
    expect(items).toContain('Log out');
    ([...document.body.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Log out') as HTMLElement).click();
    backend.expectOne('/api/logout').flush(null, { status: 204, statusText: 'No Content' });
    fixture.detectChanges();
    expect(el.querySelector('aside')).toBeNull();
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
});

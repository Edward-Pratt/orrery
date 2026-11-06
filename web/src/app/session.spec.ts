import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Me } from '@hub/api';
import type { Observable } from 'rxjs';
import { allowed, loggedOutOn401, refreshOn403, Session } from './session';

/** An operator on factorio alone, and an auditor everywhere. */
const ALEX: Me = {
  id: 'u5',
  username: 'alex',
  owner: false,
  permissions: [
    { permission: 'servers.chat', servers: ['factorio'] },
    { permission: 'servers.control', servers: ['factorio'] },
    { permission: 'audit', servers: null },
  ],
};

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(withInterceptors([loggedOutOn401, refreshOn403])), provideHttpClientTesting()],
  });
  return { session: TestBed.inject(Session), backend: TestBed.inject(HttpTestingController) };
}

describe('Session', () => {
  it('is logged out when the hub answers 401', () => {
    const { session, backend } = setup();
    session.load();
    expect(session.user()).toBeUndefined(); // still asking
    backend.expectOne('/api/me').flush('Not logged in', { status: 401, statusText: 'Unauthorized' });
    expect(session.user()).toBeNull();
  });

  it('is logged in as the user the hub names', () => {
    const { session, backend } = setup();
    session.load();
    backend.expectOne('/api/me').flush(ALEX);
    expect(session.user()).toEqual(ALEX);
  });

  it('logs out with a JSON POST, then is logged out', () => {
    const { session, backend } = setup();
    session.load();
    backend.expectOne('/api/me').flush(ALEX);
    session.logout();
    const req = backend.expectOne('/api/logout');
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('content-type')).toBe('application/json');
    req.flush(null, { status: 204, statusText: 'No Content' });
    expect(session.user()).toBeNull();
  });

  it('is logged out by a 401 from any later request', () => {
    const { session, backend } = setup();
    session.load();
    backend.expectOne('/api/me').flush(ALEX);
    TestBed.inject(HttpClient).get('/api/servers').subscribe({ error: () => {} });
    backend.expectOne('/api/servers').flush('Not logged in', { status: 401, statusText: 'Unauthorized' });
    expect(session.user()).toBeNull();
    expect(session.ended()).toBe(true); // the login card says the session ended
  });

  it('was not ended when it never started, or by logging out', () => {
    const { session, backend } = setup();
    session.load();
    backend.expectOne('/api/me').flush('Not logged in', { status: 401, statusText: 'Unauthorized' });
    expect(session.ended()).toBe(false);
    session.user.set(ALEX);
    session.logout();
    backend.expectOne('/api/logout').flush(null, { status: 204, statusText: 'No Content' });
    expect(session.ended()).toBe(false);
  });

  it('can: a permission for every server, or on the servers it names; nothing logged out', () => {
    const { session } = setup();
    expect(session.can('audit')).toBe(false); // nobody yet
    session.user.set(ALEX);
    expect(session.can('audit')).toBe(true);
    expect(session.can('audit', 'gtnh')).toBe(true);
    expect(session.can('servers.control', 'factorio')).toBe(true);
    expect(session.can('servers.control', 'gtnh')).toBe(false);
    expect(session.can('servers.control')).toBe(false); // scoped: not for every server
    expect(session.canAnywhere('servers.control')).toBe(true);
    expect(session.can('servers.console', 'factorio')).toBe(false);
    expect(session.owner()).toBe(false);
  });

  it('asks /api/me again on a 403, keeping the user if the hub does not answer', () => {
    const { session, backend } = setup();
    session.user.set(ALEX);
    TestBed.inject(HttpClient).post('/api/servers/factorio/restart', {}).subscribe({ error: () => {} });
    backend.expectOne('/api/servers/factorio/restart').flush('Needs servers.control on factorio', { status: 403, statusText: 'Forbidden' });
    const fewer = { ...ALEX, permissions: [ALEX.permissions[2]!] };
    backend.expectOne('/api/me').flush(fewer);
    expect(session.can('servers.control', 'factorio')).toBe(false);
    TestBed.inject(HttpClient).get('/api/audit').subscribe({ error: () => {} });
    backend.expectOne('/api/audit').flush('Needs audit', { status: 403, statusText: 'Forbidden' });
    backend.expectOne('/api/me').flush('Bad gateway', { status: 502, statusText: 'Bad Gateway' });
    expect(session.user()).toEqual(fewer);
  });

  it('allowed waits for a login, then matches only with the permission', async () => {
    const { session } = setup();
    const answers: boolean[] = [];
    const guard = (p: Parameters<typeof allowed>[0]) =>
      TestBed.runInInjectionContext(() => (allowed(p)({}, [], {} as never) as Observable<boolean>).subscribe((ok) => answers.push(ok)));
    guard('audit');
    guard('users');
    TestBed.tick();
    expect(answers).toEqual([]); // logged out: the guard waits
    session.user.set(ALEX);
    TestBed.tick();
    expect(answers).toEqual([true, false]);
  });
});

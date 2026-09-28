import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Me } from '@hub/api';
import { loggedOutOn401, Session } from './session';

const ALEX: Me = { id: '5', username: 'alex', avatar: null };

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(withInterceptors([loggedOutOn401])), provideHttpClientTesting()],
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
  });
});

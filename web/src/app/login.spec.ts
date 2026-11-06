import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Login } from './login';
import { loggedOutOn401, Session } from './session';
import { OWNER, settle } from './testing';

async function open(url = '/', ended = false) {
  history.replaceState(null, '', url);
  TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([loggedOutOn401])), provideHttpClientTesting()] });
  const session = TestBed.inject(Session);
  session.ended.set(ended);
  const fixture = TestBed.createComponent(Login);
  fixture.detectChanges();
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const backend = TestBed.inject(HttpTestingController);
  const type = (selector: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const submit = (selector: string) => {
    el.querySelector<HTMLFormElement>(selector)!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
  };
  const render = async () => (await settle(), fixture.detectChanges());
  return { el, backend, session, type, submit, render };
}

describe('the login card', () => {
  afterEach(() => history.replaceState(null, '', '/'));

  it('logs in with a username and password as JSON, then loads the session', async () => {
    const { backend, session, type, submit } = await open();
    type('[data-username]', '  alex ');
    type('[data-password]', 'correct horse battery staple');
    submit('[data-login-form]');
    const req = backend.expectOne('/api/login');
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('content-type')).toBe('application/json');
    expect(req.request.body).toEqual({ username: 'alex', password: 'correct horse battery staple' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    backend.expectOne('/api/me').flush(OWNER);
    expect(session.user()).toEqual(OWNER);
  });

  it("shows the hub's words for a refused login or a lock", async () => {
    const { el, backend, type, submit, render } = await open();
    type('[data-username]', 'alex');
    for (const [status, text] of [[401, 'Wrong username or password'], [429, 'Too many tries: wait 15 min and try again']] as const) {
      submit('[data-login-form]');
      backend.expectOne('/api/login').flush(text, { status, statusText: 'No' });
      await render();
      expect(el.querySelector('[data-message]')!.textContent!.trim()).toBe(text);
    }
  });

  it('says the session ended when the hub ended it under the open page', async () => {
    const { el } = await open('/', true);
    expect(el.querySelector('[data-message]')!.textContent).toContain('Your session ended');
  });

  it('takes an invite out of the address, names its user, and sets the password typed twice', async () => {
    const { el, backend, session, type, submit, render } = await open('/?invite=tok-123&from=mail');
    expect(location.search).toBe('?from=mail'); // out of history and bookmarks at once
    backend.expectOne('/api/invites/tok-123').flush({ username: 'sam' });
    await render();
    expect(el.querySelector('[data-invitee]')!.textContent).toBe('sam');
    const go = el.querySelector<HTMLButtonElement>('[data-invite-form] [data-go]')!;
    type('[data-password]', 'too short');
    expect(go.disabled).toBe(true);
    type('[data-password]', 'a long enough password');
    type('[data-again]', 'a long enough passwerd');
    submit('[data-invite-form]');
    await render();
    expect(el.querySelector('[data-message]')!.textContent).toContain('differ');
    backend.expectNone('/api/invites/tok-123');
    type('[data-again]', 'a long enough password');
    submit('[data-invite-form]');
    const req = backend.expectOne((r) => r.method === 'POST' && r.url === '/api/invites/tok-123');
    expect(req.request.body).toEqual({ password: 'a long enough password' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    backend.expectOne('/api/me').flush({ ...OWNER, username: 'sam' });
    expect(session.user()?.username).toBe('sam');
  });

  it('says so for an invite that is unknown, used or expired', async () => {
    const { el, backend, render } = await open('/?invite=old');
    backend.expectOne('/api/invites/old').flush('That invite is no longer valid', { status: 404, statusText: 'Not Found' });
    await render();
    expect(el.querySelector('[data-invite-gone]')).not.toBeNull();
    expect(el.querySelector('[data-invite-form]')).toBeNull();
  });
});

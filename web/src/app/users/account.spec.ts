import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Session } from '../session';
import { dialogButton, loggedIn, settle, until } from '../testing';
import Account from './account';

async function open() {
  TestBed.configureTestingModule({ providers: [loggedIn(), provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(Account);
  const render = async () => (await settle(), fixture.detectChanges());
  await render();
  const el = fixture.nativeElement as HTMLElement;
  const fill = (values: Record<string, string>) => {
    for (const [k, v] of Object.entries(values)) el.querySelector<HTMLInputElement>(`[data-${k}]`)!.value = v;
    el.querySelector<HTMLFormElement>('[data-password-form]')!.dispatchEvent(new Event('submit'));
  };
  return { el, render, fill, backend: TestBed.inject(HttpTestingController), session: TestBed.inject(Session) };
}

describe('the Account page', () => {
  it('changes the password with the current one, after checking the new one here', async () => {
    const { el, render, fill, backend } = await open();
    expect(el.querySelector('[data-who]')!.textContent).toContain('alex');
    fill({ current: 'old one', next: 'short', again: 'short' });
    await render();
    expect(el.querySelector('[data-error]')!.textContent).toContain('at least 12');
    fill({ current: 'old one', next: 'a new password!', again: 'a new passw0rd!' });
    await render();
    expect(el.querySelector('[data-error]')!.textContent).toContain('differ');
    backend.expectNone('/api/me/password');
    fill({ current: 'old one', next: 'a new password!', again: 'a new password!' });
    const req = backend.expectOne('/api/me/password');
    expect([req.request.method, req.request.headers.get('content-type')]).toEqual(['PUT', 'application/json']);
    expect(req.request.body).toEqual({ current: 'old one', password: 'a new password!' });
    req.flush('Wrong password', { status: 403, statusText: 'Forbidden' });
    await render();
    expect(el.querySelector('[data-error]')!.textContent).toBe('Wrong password');
  });

  it('logs out everywhere after asking, back to the login card', async () => {
    const { el, backend, session } = await open();
    (el.querySelector('[data-logout-all]') as HTMLElement).click();
    await until(() => !!document.querySelector('[data-confirm-ok]'));
    dialogButton('ok').click();
    await until(() => backend.match('/api/me/logout-all').map((r) => r.flush(null, { status: 204, statusText: 'No Content' })).length > 0);
    await until(() => session.user() === null);
  });
});

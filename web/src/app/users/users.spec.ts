import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { InviteAnswer, Me, RoleView, UserView } from '@hub/api';
import { dialogButton, loggedIn, OWNER, settle, until } from '../testing';
import Users from './users';

const ROLES: RoleView[] = [
  { id: 'owner', name: 'Owner', permissions: [], note: 'Everything.' },
  { id: 'op', name: 'Operator', permissions: ['servers.chat', 'servers.control'], note: 'Day to day.' },
  { id: 'view', name: 'Viewer', permissions: [], note: 'Reads only.' },
];
const ALEX: UserView = { id: OWNER.id, username: 'alex', disabled: false, discordId: null, lastLogin: 1, hasPassword: true, grants: [{ roleId: 'owner', role: 'Owner', servers: null }] };
const SAM: UserView = { id: 'u-sam', username: 'sam', disabled: true, discordId: null, lastLogin: null, hasPassword: false, grants: [{ roleId: 'op', role: 'Operator', servers: ['space'] }] };

async function open(me: Me = OWNER, users = [ALEX, SAM]) {
  TestBed.configureTestingModule({ providers: [loggedIn(me), provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(Users);
  const backend = TestBed.inject(HttpTestingController);
  backend.expectOne('/api/users').flush(users);
  backend.expectOne('/api/roles').flush(ROLES);
  backend.expectOne('/api/servers').flush([{ id: 'space', name: 'Space Age' }, { id: 'gtnh', name: 'GTNH' }]);
  const render = async () => (await settle(), fixture.detectChanges());
  await render();
  const el = fixture.nativeElement as HTMLElement;
  const row = (name: string) => el.querySelector<HTMLElement>(`[data-user="${name}"]`)!;
  const sheet = () => document.querySelector<HTMLElement>('[data-sheet]');
  const click = async (target: HTMLElement) => (target.click(), await render());
  const menuItem = async (name: string, item: string) => {
    await click(row(name).querySelector('[data-more]')!);
    return document.querySelector<HTMLElement>(`[${item}]`)!;
  };
  return { el, backend, render, row, sheet, click, menuItem };
}

describe('the Users tab', () => {
  afterEach(() => document.querySelectorAll('[data-sheet]').forEach((s) => s.remove()));

  it('lists each user with their roles and where, invited and disabled ones marked', async () => {
    const { row } = await open();
    expect(row('alex').textContent).toContain('(you)');
    expect(row('alex').querySelector('[data-grants]')!.textContent).toBe('Owner');
    expect(row('sam').querySelector('[data-grants]')!.textContent).toBe('Operator on Space Age');
    expect(row('sam').querySelector('[data-invited]')).not.toBeNull();
    expect(row('sam').querySelector('[data-disabled]')).not.toBeNull();
    expect(row('sam').querySelector('[data-last-login]')!.textContent).toContain('never logged in');
  });

  it('invites a user with a role on the servers picked, then shows the link once', async () => {
    const { el, backend, render, sheet, click } = await open();
    await click(el.querySelector('[data-invite]')!);
    const name = sheet()!.querySelector<HTMLInputElement>('[data-username]')!;
    name.value = 'kim';
    name.dispatchEvent(new Event('input'));
    await click(sheet()!.querySelector('[data-role="Operator"] [data-grant]')!);
    await click(sheet()!.querySelector('[data-role="Operator"] [data-some]')!);
    expect(sheet()!.querySelector<HTMLButtonElement>('[data-save]')!.disabled).toBe(true); // no server picked yet
    await click(sheet()!.querySelector('[data-role="Operator"] [data-server="gtnh"]')!);
    await click(sheet()!.querySelector('[data-save]')!);
    const req = backend.expectOne((r) => r.method === 'POST' && r.url === '/api/users');
    expect(req.request.body).toEqual({ username: 'kim', grants: [{ roleId: 'op', servers: ['gtnh'] }] });
    req.flush({ id: 'u-kim', username: 'kim', invite: 'https://dash.orrery.run/?invite=abc' } satisfies InviteAnswer);
    await render();
    backend.expectOne('/api/users').flush([ALEX, SAM]);
    await render();
    expect(el.querySelector('[data-link-url]')!.textContent).toBe('https://dash.orrery.run/?invite=abc');
    await click(el.querySelector('[data-done]')!);
    expect(el.querySelector('[data-link]')).toBeNull();
  });

  it('edits only what changed; Delete asks for the typed username', async () => {
    const { backend, render, sheet, click, menuItem } = await open();
    await click(await menuItem('sam', 'data-edit'));
    await click(sheet()!.querySelector('[data-role="Operator"] [data-every]')!);
    await click(sheet()!.querySelector('[data-save]')!);
    const put = backend.expectOne((r) => r.method === 'PUT' && r.url === '/api/users/u-sam');
    expect(put.request.body).toEqual({ grants: [{ roleId: 'op', servers: null }] });
    put.flush(null, { status: 204, statusText: 'No Content' });
    await render();
    backend.expectOne('/api/users').flush([ALEX, SAM]);
    await render();
    void (await menuItem('sam', 'data-delete')).click();
    await until(() => !!document.querySelector('[data-confirm-typed]'));
    expect(dialogButton('ok').disabled).toBe(true);
    const typed = document.querySelector<HTMLInputElement>('[data-confirm-typed]')!;
    typed.value = 'sam';
    typed.dispatchEvent(new Event('input'));
    await render();
    dialogButton('ok').click();
    let deleted: TestRequest[] = [];
    await until(() => (deleted = backend.match((r) => r.method === 'DELETE' && r.url === '/api/users/u-sam')).length > 0);
    expect(deleted[0]!.request.headers.get('content-type')).toBe('application/json');
    deleted[0]!.flush(null, { status: 204, statusText: 'No Content' });
  });

  it("a user with users but not owner gets no menu on an owner, no Owner role and no Discord id", async () => {
    const mia: Me = { id: 'u-mia', username: 'mia', owner: false, permissions: [{ permission: 'users', servers: null }] };
    const { el, row, sheet, click } = await open(mia);
    expect(row('alex').querySelector('[data-more]')).toBeNull();
    expect(row('sam').querySelector('[data-more]')).not.toBeNull();
    await click(el.querySelector('[data-invite]')!);
    expect([...sheet()!.querySelectorAll('[data-role]')].map((r) => r.getAttribute('data-role'))).toEqual(['Operator', 'Viewer']);
    expect(sheet()!.querySelector('[data-discord]')).toBeNull();
  });
});

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Me, PermissionInfo, RoleView } from '@hub/api';
import { loggedIn, OWNER, settle, VIEWER } from '../testing';
import Roles from './roles';

const ROLES: RoleView[] = [
  { id: 'owner', name: 'Owner', permissions: [], note: '' },
  { id: 'op', name: 'Operator', permissions: ['servers.chat', 'servers.control'], note: 'Day to day.' },
  { id: 'view', name: 'Viewer', permissions: [], note: '' },
];
const PERMISSIONS: PermissionInfo[] = [
  { name: 'servers.chat', scoped: true, label: 'Chat', description: 'send chat into a server' },
  { name: 'servers.control', scoped: true, label: 'Control', description: 'restart and cancel' },
  { name: 'audit', scoped: false, label: 'Audit log', description: 'read the audit log' },
] as PermissionInfo[];

async function open(me: Me = OWNER) {
  TestBed.configureTestingModule({ providers: [loggedIn(me), provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(Roles);
  const backend = TestBed.inject(HttpTestingController);
  backend.expectOne('/api/roles').flush(ROLES);
  backend.expectOne('/api/permissions').flush(PERMISSIONS);
  const render = async () => (await settle(), fixture.detectChanges());
  await render();
  const el = fixture.nativeElement as HTMLElement;
  return { el, backend, render, row: (name: string) => el.querySelector<HTMLElement>(`[data-role="${name}"]`)! };
}

describe('the Roles tab', () => {
  afterEach(() => document.querySelectorAll('[data-sheet]').forEach((s) => s.remove()));

  it("names each role's permissions; Owner is everything and fixed", async () => {
    const { row } = await open();
    expect(row('Owner').querySelector('[data-permissions]')!.textContent).toBe('Everything, everywhere');
    expect(row('Owner').querySelector('[data-edit]')).toBeNull();
    expect(row('Operator').querySelector('[data-permissions]')!.textContent).toBe('Chat, Control');
    expect(row('Viewer').querySelector('[data-permissions]')!.textContent).toBe('Reads only');
    expect(row('Viewer').querySelector('[data-edit]')).not.toBeNull();
  });

  it('an owner creates a role from the permissions ticked', async () => {
    const { el, backend, render } = await open();
    (el.querySelector('[data-new-role]') as HTMLElement).click();
    await render();
    const sheet = document.querySelector<HTMLElement>('[data-sheet]')!;
    const name = sheet.querySelector<HTMLInputElement>('[data-name]')!;
    name.value = ' Auditor ';
    name.dispatchEvent(new Event('input'));
    (sheet.querySelector('[data-permission="audit"] input') as HTMLElement).click();
    await render();
    (sheet.querySelector('[data-save]') as HTMLElement).click();
    const req = backend.expectOne((r) => r.method === 'POST' && r.url === '/api/roles');
    expect(req.request.body).toEqual({ name: 'Auditor', note: '', permissions: ['audit'] });
  });

  it('is read only for anyone but an owner', async () => {
    const { el, row } = await open({ ...VIEWER, permissions: [{ permission: 'users', servers: null }] });
    expect(el.querySelector('[data-new-role]')).toBeNull();
    expect(row('Viewer').querySelector('[data-edit]')).toBeNull();
    expect(el.textContent).toContain('Only an owner changes roles.');
  });
});

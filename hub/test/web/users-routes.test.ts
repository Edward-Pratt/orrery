// The Users page's API (`src/web/web-users.ts`) on a whole hub: inviting (the link answered once, never listed),
// editing all or none, resets, logging a user out, deleting, the last-owner and self rules, what a user with `users`
// but not `owner` may and may not do, roles (owners only) and the permission list, and the audit they leave.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AuditLog, InviteAnswer, PermissionInfo, RoleView, UserView } from '../../src/api.ts';
import { dashboard, loginAs, webHub } from './web-hub.ts';

async function usersHub(t: TestContext) {
  const web = await webHub(t);
  const owner = await loginAs(web);
  const call = async (cookie: string, method: string, path: string, body: object = {}) => {
    const res = await web.app.request(`/api${path}`, { method, headers: dashboard(cookie), body: method === 'GET' ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) };
  };
  const roles = (await call(owner.cookie, 'GET', '/roles')).json() as RoleView[];
  const role = (name: string) => roles.find((r) => r.name === name)!.id;
  const users = async () => (await call(owner.cookie, 'GET', '/users')).json() as UserView[];
  return { web, owner, call, role, users };
}

test('an owner invites a user: the link is answered once and works once, the list never holds it', async (t) => {
  const { owner, call, role, users } = await usersHub(t);
  const operator = role('Operator');
  const made = await call(owner.cookie, 'POST', '/users', { username: 'sam', grants: [{ roleId: operator, servers: ['gtnh'] }], discordId: '6'.repeat(18) });
  assert.equal(made.status, 200);
  const answer = made.json() as InviteAnswer;
  assert.equal(answer.username, 'sam');
  const token = answer.invite.match(/^https:\/\/dash\.orrery\.run\/\?invite=([\w-]{43})$/)![1]!;
  const listed = await users();
  assert.deepEqual(listed.map((u) => u.username), ['alex', 'sam']);
  assert.deepEqual(listed[1], {
    id: answer.id, username: 'sam', disabled: false, discordId: '6'.repeat(18), lastLogin: null, hasPassword: false,
    grants: [{ roleId: operator, role: 'Operator', servers: ['gtnh'] }],
  } satisfies UserView);
  assert.ok(!JSON.stringify(listed).includes(token));
  assert.deepEqual((await call('', 'GET', `/invites/${token}`)).json(), { username: 'sam' });
  for (const [body, status, text] of [
    [{ username: 'x', grants: [] }, 400, 'A username is 2 to 32 letters, digits, dots, dashes or underscores'],
    [{ username: 'ALEX', grants: [] }, 409, 'A user named alex exists'],
    [{ username: 'kim', grants: [{ roleId: 'nope' }] }, 400, 'Unknown role'],
    [{ username: 'kim', grants: [{ roleId: operator, servers: ['nope'] }] }, 400, 'Unknown server: nope'],
  ] as const) {
    const res = await call(owner.cookie, 'POST', '/users', body);
    assert.deepEqual([res.status, res.text], [status, text], JSON.stringify(body));
  }
});

test('an edit is all or none; reset, log out and delete; no one disables, deletes or demotes the last owner or themself', async (t) => {
  const { web, owner, call, role, users } = await usersHub(t);
  const sam = await loginAs(web, { username: 'sam', grants: [{ roleId: role('Viewer') }] });
  const edit = (body: object, id = sam.id) => call(owner.cookie, 'PUT', `/users/${id}`, body);
  assert.deepEqual([(await edit({ grants: [{ roleId: role('Admin') }], discordId: 'nope' })).status, (await users())[1]!.grants[0]!.role], [400, 'Viewer']);
  assert.equal((await edit({ disabled: 'yes' })).status, 400);
  assert.equal((await edit({ grants: [{ roleId: role('Admin') }], discordId: '6'.repeat(18) })).status, 204);
  assert.deepEqual([(await users())[1]!.grants[0]!.role, (await users())[1]!.discordId], ['Admin', '6'.repeat(18)]);

  const reset = (await call(owner.cookie, 'POST', `/users/${sam.id}/reset`)).json() as InviteAnswer;
  assert.match(reset.invite, /\?invite=/);
  assert.equal((await loginAs(web, { username: 'sam' })).id, sam.id); // the old password works until the link is used
  assert.equal((await call(owner.cookie, 'POST', `/users/${sam.id}/logout`)).status, 204);
  assert.equal((await call(sam.cookie, 'GET', '/me')).status, 401);

  assert.deepEqual([(await edit({ disabled: true }, owner.id)).status, (await edit({ disabled: true }, owner.id)).text], [409, "You can't disable yourself"]);
  assert.deepEqual((await edit({ grants: [{ roleId: role('Admin') }] }, owner.id)).text, "The last owner can't be demoted");
  assert.deepEqual((await call(owner.cookie, 'DELETE', `/users/${owner.id}`)).text, "You can't delete yourself");
  assert.equal((await call(owner.cookie, 'DELETE', `/users/${sam.id}`)).status, 204);
  assert.deepEqual((await users()).map((u) => u.username), ['alex']);
  assert.equal((await call(owner.cookie, 'DELETE', `/users/${sam.id}`)).status, 404);

  const audit = (await call(owner.cookie, 'GET', '/audit')).json() as AuditLog;
  const actions = audit.entries.filter((e) => e.actor === owner.actor).map((e) => e.action).reverse();
  assert.deepEqual(actions, ['invite accepted', 'user changed', 'user changed', 'password reset', 'sessions ended', 'user deleted']);
});

test('a user with users but not owner manages users below them only, sets no Discord id and edits no roles', async (t) => {
  const { web, owner, call, role } = await usersHub(t);
  const made = await call(owner.cookie, 'POST', '/roles', { name: 'Manager', permissions: ['users', 'servers.chat'], note: 'People.' });
  const manager = (made.json() as RoleView).id;
  const mia = await loginAs(web, { username: 'mia', grants: [{ roleId: manager }] });
  const invite = (body: object) => call(mia.cookie, 'POST', '/users', { username: 'kim', ...body });
  assert.deepEqual((await invite({ grants: [{ roleId: 'owner' }] })).text, 'Only an owner may grant Owner');
  assert.match((await invite({ grants: [{ roleId: role('Admin') }] })).text, /^You can't grant Admin: it has servers\.\w+, which you don't hold$/);
  assert.deepEqual((await invite({ grants: [], discordId: '6'.repeat(18) })).text, 'Only an owner may set a Discord id');
  const kim = (await invite({ grants: [{ roleId: role('Viewer') }] })).json() as InviteAnswer;
  assert.equal((await call(mia.cookie, 'POST', `/users/${kim.id}/reset`)).status, 200);
  assert.deepEqual((await call(mia.cookie, 'POST', `/users/${owner.id}/reset`)).text, 'Only an owner may change an owner');
  assert.equal((await call(mia.cookie, 'GET', '/roles')).status, 200);
  assert.equal((await call(mia.cookie, 'GET', '/permissions')).status, 200);
  for (const [method, path] of [['POST', '/roles'], ['PUT', `/roles/${manager}`], ['DELETE', `/roles/${manager}`]]) {
    assert.deepEqual((await call(mia.cookie, method!, path!, { name: 'X', permissions: [] })).text, 'Needs an owner');
  }
});

test('owners create, change and delete roles; Owner is fixed, a granted role stays, the vocabulary is listed', async (t) => {
  const { owner, call, role } = await usersHub(t);
  const created = await call(owner.cookie, 'POST', '/roles', { name: 'Chatter', permissions: ['servers.chat', 'audit', 'servers.chat'] });
  const chatter = created.json() as RoleView;
  assert.deepEqual(chatter, { id: chatter.id, name: 'Chatter', permissions: ['servers.chat', 'audit'], note: '' });
  assert.deepEqual((await call(owner.cookie, 'POST', '/roles', { name: 'x', permissions: ['root'] })).text, 'Unknown permission: root');
  assert.deepEqual((await call(owner.cookie, 'POST', '/roles', { name: 'chatter', permissions: [] })).status, 409);
  const changed = await call(owner.cookie, 'PUT', `/roles/${chatter.id}`, { name: 'Talker', permissions: ['servers.chat'], note: 'Chat only.' });
  assert.deepEqual(changed.json(), { id: chatter.id, name: 'Talker', permissions: ['servers.chat'], note: 'Chat only.' });
  assert.deepEqual((await call(owner.cookie, 'PUT', '/roles/owner', { name: 'Boss', permissions: [] })).text, "Owner is built in and can't be changed");
  assert.equal((await call(owner.cookie, 'DELETE', `/roles/${role('Operator')}`)).status, 204); // held by no one
  await call(owner.cookie, 'POST', '/users', { username: 'kim', grants: [{ roleId: chatter.id }] });
  const held = await call(owner.cookie, 'DELETE', `/roles/${chatter.id}`);
  assert.deepEqual([held.status, held.text], [409, 'A user holds Talker: take it away first']);
  const vocabulary = (await call(owner.cookie, 'GET', '/permissions')).json() as PermissionInfo[];
  assert.equal(vocabulary.length, 14);
  assert.deepEqual(vocabulary[0], { name: 'servers.chat', scoped: true, label: 'Chat', description: 'send chat into a server' });
});

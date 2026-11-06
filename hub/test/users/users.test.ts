import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db } from '../../src/stats/db.ts';
import { OWNER_GRANTS } from '../../src/users/permissions.ts';
import { Roles } from '../../src/users/roles.ts';
import { hashToken } from '../../src/users/store.ts';
import { INVITE_MS, Users, UsersRefused, type Actor } from '../../src/users/users.ts';
import type { AuditEntry } from '../../src/types.ts';

const LOW = { N: 2 ** 10, r: 8, p: 1 };
const CLI: Actor = { label: 'cli:edward', userId: null, grants: OWNER_GRANTS };
const PASSWORD = 'correct horse battery';

function setup() {
  const db = new Db(':memory:');
  const audit: AuditEntry[] = [];
  const clock = { now: 1_000_000 };
  const roles = new Roles(db.users, (e) => audit.push(e));
  const users = new Users(db.users, roles, (e) => audit.push(e), { knownServer: (id) => ['gtnh', 'factorio'].includes(id), cost: LOW, now: () => clock.now });
  const role = (name: string) => roles.list().find((r) => r.name === name)!.id;
  /** An owner who has accepted their invite. */
  const owner = async (username = 'alex') => {
    const { id, token } = users.invite({ username, grants: [{ roleId: 'owner' }] }, CLI);
    await users.acceptInvite(token, PASSWORD);
    return { id, actor: { label: `web:${username} (${id})`, userId: id, grants: users.resolve(id)!.grants } satisfies Actor };
  };
  return { db, users, roles, audit, clock, role, owner };
}

const refused = (fn: () => unknown, status: number, message: RegExp) => assert.throws(fn, (err: unknown) => err instanceof UsersRefused && err.status === status && message.test(err.message));
const refusedAsync = (fn: () => Promise<unknown>, status: number, message: RegExp) => assert.rejects(fn, (err: unknown) => err instanceof UsersRefused && err.status === status && message.test(err.message));

test('an invite becomes a password once, within a day, and the user can then log in', async (t) => {
  const { users, audit, clock } = setup();
  const { id, token } = users.invite({ username: ' Alex ', grants: [{ roleId: 'owner' }], discordId: '123456789012345678' }, CLI);
  assert.deepEqual(users.list(), [{ id, username: 'Alex', disabled: false, discordId: '123456789012345678', lastLogin: null, hasPassword: false, grants: [{ roleId: 'owner', role: 'Owner', servers: null }] }]);
  assert.deepEqual(audit.at(-1), { actor: 'cli:edward', action: 'user invited', target: 'user:Alex', details: 'Owner' });
  assert.equal(await users.login('alex', PASSWORD), undefined); // no password yet
  await refusedAsync(() => users.acceptInvite(token, 'short'), 400, /at least 12/); // a typo doesn't burn the link
  const [user, second] = await Promise.allSettled([users.acceptInvite(token, PASSWORD), users.acceptInvite(token, PASSWORD)]).then((r) => r.map((x) => (x.status === 'fulfilled' ? x.value : x.reason)));
  assert.equal(user.username, 'Alex'); // one of the two got in
  assert.ok(second instanceof UsersRefused && second.status === 404);
  assert.equal(user.lastLogin, clock.now);
  await refusedAsync(() => users.acceptInvite(token, PASSWORD), 404, /no longer valid/);
  await refusedAsync(() => users.acceptInvite('made-up', PASSWORD), 404, /no longer valid/);
  await t.test('login: the right password, case-insensitive name; wrong, unknown and malformed refused alike', async () => {
    clock.now += 1;
    assert.equal((await users.login('ALEX', PASSWORD))?.id, id);
    assert.equal(users.list()[0]!.lastLogin, clock.now);
    assert.equal(await users.login('alex', 'correct horse batteries'), undefined);
    assert.equal(await users.login('nobody', PASSWORD), undefined);
    assert.equal(await users.login(undefined, PASSWORD), undefined);
  });
  await t.test('an expired invite is no invite', async () => {
    const { token } = users.invite({ username: 'sam', grants: [] }, CLI);
    clock.now += INVITE_MS + 1;
    await refusedAsync(() => users.acceptInvite(token, PASSWORD), 404, /no longer valid/);
  });
});

test('invite input is checked: the name, a taken name, the Discord id, the grants', async () => {
  const { users, role, owner } = setup();
  const { id: alex, actor } = await owner();
  users.setDiscordId(alex, '123456789012345678', actor);
  refused(() => users.invite({ username: 'a', grants: [] }, actor), 400, /2 to 32/);
  refused(() => users.invite({ username: 'has space', grants: [] }, actor), 400, /2 to 32/);
  refused(() => users.invite({ username: 'ALEX', grants: [] }, actor), 409, /named alex exists/);
  refused(() => users.invite({ username: 'sam', grants: [], discordId: '12' }, actor), 400, /17 to 20 digits/);
  refused(() => users.invite({ username: 'sam', grants: [], discordId: '123456789012345678' }, actor), 409, /alex has that Discord id/);
  refused(() => users.invite({ username: 'sam', grants: 'owner' }, actor), 400, /as a list/);
  refused(() => users.invite({ username: 'sam', grants: [{ roleId: 'nope' }] }, actor), 400, /Unknown role/);
  refused(() => users.invite({ username: 'sam', grants: [{ roleId: role('Viewer') }, { roleId: role('Viewer') }] }, actor), 400, /granted twice/);
  refused(() => users.invite({ username: 'sam', grants: [{ roleId: role('Operator'), servers: [] }] }, actor), 400, /at least one server/);
  refused(() => users.invite({ username: 'sam', grants: [{ roleId: role('Operator'), servers: ['mars'] }] }, actor), 400, /Unknown server: mars/);
  refused(() => users.invite({ username: 'sam', grants: [{ roleId: 'owner', servers: ['gtnh'] }] }, actor), 400, /Owner is for every server/);
  const { id } = users.invite({ username: 'sam', grants: [{ roleId: role('Operator'), servers: ['factorio', 'factorio'] }], discordId: '' }, actor);
  assert.deepEqual(users.list().find((u) => u.id === id)!.grants, [{ roleId: role('Operator'), role: 'Operator', servers: ['factorio'] }]);
  assert.deepEqual(users.resolve(id)!.grants, [{ owner: false, permissions: ['servers.chat', 'servers.control', 'servers.moderation', 'services.control', 'services.logs'], servers: ['factorio'] }]);
});

test('a users manager who is not an owner hands out only what they hold, and never touches an owner', async () => {
  const { users, roles, role, owner } = setup();
  const { id: ownerId, actor: ownerActor } = await owner();
  const managerRole = roles.create({ name: 'Manager', permissions: ['users', 'servers.chat', 'servers.control'] }, 'x');
  const { id: managerId, token } = users.invite({ username: 'sam', grants: [{ roleId: managerRole.id }] }, ownerActor);
  await users.acceptInvite(token, PASSWORD);
  const manager: Actor = { label: `web:sam (${managerId})`, userId: managerId, grants: users.resolve(managerId)!.grants };
  refused(() => users.invite({ username: 'kim', grants: [{ roleId: 'owner' }] }, manager), 403, /Only an owner may grant Owner/);
  refused(() => users.invite({ username: 'kim', grants: [{ roleId: role('Admin') }] }, manager), 403, /can't grant Admin: it has servers.console/);
  refused(() => users.invite({ username: 'kim', grants: [{ roleId: role('Operator') }] }, manager), 403, /it has servers.moderation/);
  refused(() => users.invite({ username: 'kim', grants: [], discordId: '123456789012345678' }, manager), 403, /Only an owner may set a Discord id/);
  const { id: kim, token: kimToken } = users.invite({ username: 'kim', grants: [{ roleId: role('Viewer') }] }, manager);
  users.setGrants(kim, [{ roleId: managerRole.id, servers: null }], manager); // their own permissions, unscoped: allowed
  await refusedAsync(() => users.acceptInvite(kimToken, PASSWORD), 404, /no longer valid/); // a grant change ends open links
  refused(() => users.setDiscordId(kim, '123456789012345678', manager), 403, /Only an owner/);
  for (const fn of [
    () => users.setGrants(ownerId, [], manager),
    () => users.disable(ownerId, manager),
    () => users.remove(ownerId, manager),
    () => users.reset(ownerId, manager),
    () => users.endSessions(ownerId, manager),
    () => users.setDiscordId(ownerId, null, manager),
  ]) refused(fn, 403, /Only an owner may change an owner/);
  refused(() => users.setGrants(managerId, [{ roleId: 'owner' }], manager), 403, /Only an owner may grant Owner/);
  // nor anyone above them: a reset of an Admin would be their account
  const { id: admin } = users.invite({ username: 'pat', grants: [{ roleId: role('Admin') }] }, ownerActor);
  refused(() => users.reset(admin, manager), 403, /can't change pat: they hold servers.console/);
  refused(() => users.setGrants(admin, [], manager), 403, /can't change pat/);
  refused(() => users.disable(admin, manager), 403, /can't change pat/);
  users.reset(kim, manager); // at their level: allowed
});

test('a user with a Discord id is changed by owners only: a reset would hand over that name in game', async () => {
  const { users, roles, owner } = setup();
  const { actor: ownerActor } = await owner();
  const managerRole = roles.create({ name: 'Manager', permissions: ['users', 'servers.chat'] }, 'x');
  const { id: managerId, token } = users.invite({ username: 'sam', grants: [{ roleId: managerRole.id }] }, ownerActor);
  await users.acceptInvite(token, PASSWORD);
  const manager: Actor = { label: `web:sam (${managerId})`, userId: managerId, grants: users.resolve(managerId)!.grants };
  const { id: kim } = users.invite({ username: 'kim', grants: [], discordId: '123456789012345678' }, ownerActor);
  for (const fn of [() => users.reset(kim, manager), () => users.setGrants(kim, [], manager), () => users.disable(kim, manager), () => users.remove(kim, manager), () => users.endSessions(kim, manager)]) {
    refused(fn, 403, /Only an owner may change kim: they have a Discord id/);
  }
  users.reset(kim, ownerActor); // an owner may
});

test('the last owner is never demoted, disabled or deleted; nobody disables or deletes themself', async () => {
  const { users, role, owner } = setup();
  const { id: alex, actor } = await owner();
  refused(() => users.setGrants(alex, [{ roleId: role('Admin') }], actor), 409, /last owner can't be demoted/);
  refused(() => users.disable(alex, actor), 409, /can't disable yourself/);
  refused(() => users.remove(alex, actor), 409, /can't delete yourself/);
  const { id: kim, token } = users.invite({ username: 'kim', grants: [{ roleId: 'owner' }] }, actor);
  refused(() => users.disable(alex, { ...actor, userId: null }), 409, /last owner can't be disabled/); // kim hasn't accepted: not yet an owner
  await users.acceptInvite(token, PASSWORD);
  const kimActor: Actor = { label: `web:kim (${kim})`, userId: kim, grants: users.resolve(kim)!.grants };
  users.setGrants(alex, [{ roleId: role('Admin') }], kimActor); // two owners: alex may step down
  refused(() => users.setGrants(kim, [], kimActor), 409, /last owner can't be demoted/);
  refused(() => users.remove(kim, { ...kimActor, userId: null }), 409, /last owner can't be deleted/);
  users.setGrants(alex, [{ roleId: 'owner' }], kimActor);
  users.remove(kim, actor);
  assert.deepEqual(users.list().map((u) => u.username), ['alex']);
});

test('disabling ends sessions at once; a disabled user cannot log in or accept an invite; enabling undoes it', async () => {
  const { db, users, owner, audit } = setup();
  const { actor } = await owner();
  const { id: sam, token } = users.invite({ username: 'sam', grants: [] }, actor);
  await users.acceptInvite(token, PASSWORD);
  db.users.addSession(hashToken('cookie'), sam, Number.MAX_SAFE_INTEGER);
  const { token: before } = users.reset(sam, actor);
  users.disable(sam, actor);
  assert.equal(db.users.session(hashToken('cookie')), undefined);
  assert.equal(await users.login('sam', PASSWORD), undefined);
  const { token: again } = users.reset(sam, actor);
  await refusedAsync(() => users.acceptInvite(again, PASSWORD), 404, /no longer valid/);
  users.enable(sam, actor);
  assert.equal((await users.login('sam', PASSWORD))?.id, sam);
  await refusedAsync(() => users.acceptInvite(before, PASSWORD), 404, /no longer valid/); // the disable took the links before it
  assert.deepEqual(audit.slice(-3).map((e) => e.action), ['user disabled', 'password reset', 'user enabled']);
});

test('a reset link works once and the old password until then; a password change keeps one session', async () => {
  const { db, users, owner } = setup();
  const { id: alex, actor } = await owner();
  const { token } = users.reset(alex, actor);
  assert.equal((await users.login('alex', PASSWORD))?.id, alex);
  await users.acceptInvite(token, 'a brand new password');
  assert.equal(await users.login('alex', PASSWORD), undefined);
  assert.equal((await users.login('alex', 'a brand new password'))?.id, alex);
  db.users.addSession(hashToken('phone'), alex, Number.MAX_SAFE_INTEGER);
  db.users.addSession(hashToken('laptop'), alex, Number.MAX_SAFE_INTEGER);
  await refusedAsync(() => users.changePassword(alex, 'wrong wrong wrong', 'another new password'), 403, /Wrong password/);
  await refusedAsync(() => users.changePassword(alex, 'a brand new password', 'short'), 400, /at least 12/);
  const { token: stale } = users.reset(alex, actor);
  await users.changePassword(alex, 'a brand new password', 'another new password', hashToken('laptop'));
  await refusedAsync(() => users.acceptInvite(stale, PASSWORD), 404, /no longer valid/); // a change takes open links too
  assert.equal(db.users.session(hashToken('phone')), undefined);
  assert.equal(db.users.session(hashToken('laptop')), alex);
  assert.equal((await users.login('alex', 'another new password'))?.id, alex);
});

test('deleting a user takes their grants, invites and sessions with them', async () => {
  const { db, users, roles, role, owner } = setup();
  const { actor } = await owner();
  const { id: sam } = users.invite({ username: 'sam', grants: [{ roleId: role('Viewer') }] }, actor);
  db.users.addSession(hashToken('cookie'), sam, Number.MAX_SAFE_INTEGER);
  users.remove(sam, actor);
  assert.equal(db.users.user(sam), undefined);
  assert.equal(db.users.grantedCount(role('Viewer')), 0);
  assert.equal(db.users.session(hashToken('cookie')), undefined);
  roles.remove(role('Viewer'), 'x'); // no grant holds it any more
  refused(() => users.remove(sam, actor), 404, /No such user/);
});

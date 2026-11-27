import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminRefusal } from '../../src/discord/admin.ts';
import { Db } from '../../src/stats/db.ts';
import { OWNER_GRANTS } from '../../src/users/permissions.ts';
import { Roles } from '../../src/users/roles.ts';
import { Users, type Actor } from '../../src/users/users.ts';

const CLI: Actor = { label: 'cli:edward', userId: null, grants: OWNER_GRANTS };
const FRIEND = '111111111111111111';
const STRANGER = '222222222222222222';

/** Real `Users` on an in-memory database: the friend, linked to Discord, is an Admin on factorio alone. */
function setup() {
  const db = new Db(':memory:');
  const roles = new Roles(db.users, () => {});
  const users = new Users(db.users, roles, () => {}, { knownServer: (id) => ['gtnh', 'factorio'].includes(id) });
  const role = (name: string) => roles.list().find((r) => r.name === name)!.id;
  const { id } = users.invite({ username: 'friend', grants: [{ roleId: role('Admin'), servers: ['factorio'] }], discordId: FRIEND }, CLI);
  return { users, role, friendId: id };
}

test("a linked User is decided by their grants on the channel's server, the admin role or not", () => {
  const { users } = setup();
  for (const hasAdminRole of [false, true]) {
    const friend = { discordId: FRIEND, hasAdminRole };
    for (const command of ['cmd', 'restart', 'backup']) assert.equal(adminRefusal(users, friend, command, 'factorio'), undefined);
    assert.equal(adminRefusal(users, friend, 'cmd', 'gtnh'), 'Your dashboard user needs servers.console on gtnh for this.');
    assert.equal(adminRefusal(users, friend, 'restart', 'gtnh'), 'Your dashboard user needs servers.control on gtnh for this.');
  }
});

test('each command needs its own permission: an Operator may restart and back up but not run /cmd', () => {
  const { users, role, friendId } = setup();
  users.setGrants(friendId, [{ roleId: role('Operator'), servers: ['factorio'] }], CLI);
  const friend = { discordId: FRIEND, hasAdminRole: true };
  assert.equal(adminRefusal(users, friend, 'restart', 'factorio'), undefined);
  assert.equal(adminRefusal(users, friend, 'backup', 'factorio'), undefined);
  assert.match(adminRefusal(users, friend, 'cmd', 'factorio')!, /needs servers\.console on factorio/);
});

test('a disabled linked User is refused, the admin role or not', () => {
  const { users, friendId } = setup();
  users.disable(friendId, CLI);
  assert.equal(adminRefusal(users, { discordId: FRIEND, hasAdminRole: true }, 'restart', 'factorio'), 'Your dashboard user is disabled.');
});

test('a member linked to no User, or anyone while web is off, falls back to the admin role', () => {
  const { users } = setup();
  for (const u of [users, undefined]) {
    assert.equal(adminRefusal(u, { discordId: STRANGER, hasAdminRole: true }, 'cmd', 'gtnh'), undefined);
    assert.equal(adminRefusal(u, { discordId: STRANGER, hasAdminRole: false }, 'cmd', 'gtnh'), 'You need the admin role for this.');
  }
  // Web off: the friend's grants aren't read, so only the role counts for them too.
  assert.equal(adminRefusal(undefined, { discordId: FRIEND, hasAdminRole: true }, 'cmd', 'gtnh'), undefined);
});

test('a grant change counts at the next command', () => {
  const { users, role, friendId } = setup();
  const friend = { discordId: FRIEND, hasAdminRole: false };
  assert.notEqual(adminRefusal(users, friend, 'cmd', 'gtnh'), undefined);
  users.setGrants(friendId, [{ roleId: role('Admin') }], CLI);
  assert.equal(adminRefusal(users, friend, 'cmd', 'gtnh'), undefined);
});

test('a name outside the admin commands is refused', () => {
  assert.equal(adminRefusal(undefined, { discordId: STRANGER, hasAdminRole: true }, 'status', 'gtnh'), 'Not an admin command.');
});

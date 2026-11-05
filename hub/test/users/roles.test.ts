import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db } from '../../src/stats/db.ts';
import { PERMISSIONS } from '../../src/users/permissions.ts';
import { RoleRefused, Roles } from '../../src/users/roles.ts';
import type { AuditEntry } from '../../src/types.ts';

function setup() {
  const db = new Db(':memory:');
  const audit: AuditEntry[] = [];
  const roles = new Roles(db.users, (e) => audit.push(e));
  return { db, roles, audit };
}

const refused = (fn: () => unknown, status: number, message: RegExp) => assert.throws(fn, (err: unknown) => err instanceof RoleRefused && err.status === status && message.test(err.message));

test('the seed runs once: Owner, Admin, Operator and Viewer', () => {
  const { db, roles } = setup();
  assert.deepEqual(roles.list().map((r) => r.name), ['Admin', 'Operator', 'Owner', 'Viewer']);
  assert.deepEqual(roles.get('owner')?.permissions, []);
  assert.equal(roles.list().find((r) => r.name === 'Admin')!.permissions.length, PERMISSIONS.length - 1);
  roles.remove(roles.list().find((r) => r.name === 'Viewer')!.id, 'test');
  new Roles(db.users, () => {}); // the table isn't empty: no seed
  assert.equal(roles.list().length, 3);
});

test('create and update check the input, and audit', () => {
  const { roles, audit } = setup();
  const role = roles.create({ name: '  Helper ', permissions: ['servers.chat', 'servers.chat', 'audit'], note: 'helps' }, 'web:alex (1)');
  assert.deepEqual(role, { id: role.id, name: 'Helper', permissions: ['servers.chat', 'audit'], note: 'helps' });
  assert.deepEqual(audit.at(-1), { actor: 'web:alex (1)', action: 'role created', target: 'role:Helper', details: 'servers.chat, audit' });
  refused(() => roles.create({ name: 'helper', permissions: [] }, 'x'), 409, /named Helper exists/);
  refused(() => roles.create({ name: '', permissions: [] }, 'x'), 400, /1 to 32/);
  refused(() => roles.create({ name: 'A', permissions: ['servers.everything'] }, 'x'), 400, /Unknown permission: servers.everything/);
  refused(() => roles.create({ name: 'A', permissions: 'audit' }, 'x'), 400, /as a list/);
  refused(() => roles.create({ name: 'A', permissions: [], note: 'n'.repeat(201) }, 'x'), 400, /at most 200/);
  const changed = roles.update(role.id, { name: 'Helper', permissions: ['audit'] }, 'web:alex (1)');
  assert.deepEqual(changed.permissions, ['audit']);
  assert.equal(changed.note, '');
  assert.deepEqual(audit.at(-1), { actor: 'web:alex (1)', action: 'role changed', target: 'role:Helper', details: 'permissions: audit; note' });
  roles.update(role.id, { name: 'Helper', permissions: ['audit'] }, 'x'); // nothing changed: no entry
  assert.equal(audit.length, 2);
  refused(() => roles.update('nope', { name: 'A', permissions: [] }, 'x'), 404, /No such role/);
});

test('Owner is never changed or deleted, and a granted role is not deleted', () => {
  const { db, roles } = setup();
  refused(() => roles.update('owner', { name: 'Owner', permissions: [] }, 'x'), 409, /built in/);
  refused(() => roles.remove('owner', 'x'), 409, /built in/);
  const viewer = roles.list().find((r) => r.name === 'Viewer')!;
  db.users.addUser({ id: 'u1', username: 'sam', discordId: null, created: 1 });
  db.users.setGrants('u1', [{ roleId: viewer.id, servers: null }]);
  refused(() => roles.remove(viewer.id, 'x'), 409, /A user holds Viewer/);
  db.users.setGrants('u1', []);
  roles.remove(viewer.id, 'x');
  assert.equal(roles.get(viewer.id), undefined);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can, canAnywhere, isOwner, isPermission, OWNER_GRANTS, permissionsOf, PERMISSIONS, type Grant } from '../../src/users/permissions.ts';

const operator: Grant = { owner: false, permissions: ['servers.control', 'services.control', 'deploys'], servers: null };
const scoped: Grant = { ...operator, servers: ['factorio'] };

test('an unscoped grant holds its permissions everywhere, and nothing else', () => {
  assert.equal(can([operator], 'servers.control', 'gtnh'), true);
  assert.equal(can([operator], 'servers.control'), true);
  assert.equal(can([operator], 'deploys'), true);
  assert.equal(can([operator], 'servers.console', 'gtnh'), false);
  assert.equal(can([], 'servers.control', 'gtnh'), false);
});

test('a scoped grant gives its server permissions on those servers only, and none of the others', () => {
  assert.equal(can([scoped], 'servers.control', 'factorio'), true);
  assert.equal(can([scoped], 'services.control', 'factorio'), true); // a linked service, as its server
  assert.equal(can([scoped], 'servers.control', 'gtnh'), false);
  assert.equal(can([scoped], 'servers.control'), false); // no server: an unlinked service needs an unscoped grant
  assert.equal(can([scoped], 'deploys'), false);
  assert.equal(canAnywhere([scoped], 'servers.control'), true); // an upload names no server
  assert.equal(canAnywhere([scoped], 'deploys'), false);
  assert.equal(canAnywhere([operator], 'deploys'), true);
});

test('owner holds everything; a scoped owner grant is not an owner', () => {
  for (const { name } of PERMISSIONS) assert.equal(can(OWNER_GRANTS, name, 'gtnh'), true);
  assert.equal(isOwner(OWNER_GRANTS), true);
  const scopedOwner: Grant = { owner: true, permissions: [], servers: ['gtnh'] };
  assert.equal(isOwner([scopedOwner]), false);
  assert.equal(can([scopedOwner], 'servers.console', 'gtnh'), true);
  assert.equal(can([scopedOwner], 'deploys'), false);
});

test('permissionsOf is the dashboard view: null for everywhere, else the union of scopes, in vocabulary order', () => {
  const both: Grant = { owner: false, permissions: ['servers.control'], servers: ['gtnh'] };
  assert.deepEqual(permissionsOf([scoped, both]), [
    { permission: 'servers.control', servers: ['factorio', 'gtnh'] },
    { permission: 'services.control', servers: ['factorio'] },
  ]);
  assert.deepEqual(permissionsOf([scoped, operator]).map((p) => p.servers), [null, null, null]);
  assert.equal(permissionsOf(OWNER_GRANTS).length, PERMISSIONS.length);
  assert.deepEqual(permissionsOf([]), []);
});

test('isPermission knows the vocabulary only', () => {
  assert.equal(isPermission('servers.chat'), true);
  assert.equal(isPermission('servers.everything'), false);
  assert.equal(isPermission(7), false);
});

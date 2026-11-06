import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPassword, dummyHash, hashPassword, PASSWORD_MAX, verifyPassword } from '../../src/users/password.ts';

const LOW = { N: 2 ** 10, r: 8, p: 1 };
const HIGHER = { N: 2 ** 11, r: 8, p: 1 };

test('a hash verifies its password and no other, and is salted', async () => {
  const a = await hashPassword('correct horse battery', LOW);
  const b = await hashPassword('correct horse battery', LOW);
  assert.notEqual(a, b);
  assert.match(a, /^scrypt:1024:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.deepEqual(await verifyPassword('correct horse battery', a, LOW), { ok: true });
  assert.deepEqual(await verifyPassword('correct horse batteries', a, LOW), { ok: false });
});

test('a password hashed at a lower cost verifies and comes back re-hashed at the current one', async () => {
  const old = await hashPassword('correct horse battery', LOW);
  const { ok, rehash } = await verifyPassword('correct horse battery', old, HIGHER);
  assert.equal(ok, true);
  assert.match(rehash!, /^scrypt:2048:/);
  assert.deepEqual(await verifyPassword('correct horse battery', rehash!, HIGHER), { ok: true });
  assert.equal((await verifyPassword('wrong wrong wrong', old, HIGHER)).rehash, undefined);
});

test('a malformed stored hash verifies nothing', async () => {
  for (const stored of ['', 'scrypt:1024:8:1:salt', 'bcrypt:x', 'scrypt:0:8:1:aa:bb', 'scrypt:x:8:1:aa:bb']) {
    assert.deepEqual(await verifyPassword('anything at all', stored, LOW), { ok: false });
  }
});

test('the rule is length alone', () => {
  assert.equal(checkPassword('short'), 'A password is at least 12 characters');
  assert.equal(checkPassword('x'.repeat(PASSWORD_MAX + 1)), 'A password is at most 256 characters');
  assert.equal(checkPassword(12), 'Give a password');
  assert.equal(checkPassword('twelve chars'), undefined);
});

test('the dummy hash is a real hash of nothing anyone knows', async () => {
  const dummy = await dummyHash(LOW);
  assert.match(dummy, /^scrypt:1024:/);
  assert.deepEqual(await verifyPassword('', dummy, LOW), { ok: false });
});

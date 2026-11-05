import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADDRESS_MAX, LOCK_MS, LoginLimit, PAIR_MAX, WINDOW_MS } from '../../src/users/login-limit.ts';

test('five failures lock the name from that address for 15 minutes, and not from another', () => {
  const limit = new LoginLimit();
  const t0 = 1_000_000;
  for (let i = 0; i < PAIR_MAX - 1; i++) limit.fail('Edward', '10.0.0.1', t0 + i);
  assert.equal(limit.locked('edward', '10.0.0.1', t0 + 10), 0);
  limit.fail('edward', '10.0.0.1', t0 + 10);
  assert.equal(limit.locked('Edward', '10.0.0.1', t0 + 11), Math.ceil((LOCK_MS - 1) / 1000));
  assert.equal(limit.locked('edward', '10.0.0.2', t0 + 11), 0);
  assert.equal(limit.locked('sam', '10.0.0.1', t0 + 11), 0);
  assert.equal(limit.locked('edward', '10.0.0.1', t0 + 10 + LOCK_MS), 0);
});

test('failures older than the window are forgotten, and a success clears the pair', () => {
  const limit = new LoginLimit();
  const t0 = 1_000_000;
  for (let i = 0; i < PAIR_MAX - 1; i++) limit.fail('edward', '10.0.0.1', t0);
  limit.fail('edward', '10.0.0.1', t0 + WINDOW_MS + 1); // the four before are gone: this is the first
  assert.equal(limit.locked('edward', '10.0.0.1', t0 + WINDOW_MS + 2), 0);
  for (let i = 0; i < PAIR_MAX - 2; i++) limit.fail('edward', '10.0.0.1', t0 + WINDOW_MS + 2);
  limit.clear('edward', '10.0.0.1');
  for (let i = 0; i < PAIR_MAX - 1; i++) limit.fail('edward', '10.0.0.1', t0 + WINDOW_MS + 3);
  assert.equal(limit.locked('edward', '10.0.0.1', t0 + WINDOW_MS + 4), 0);
});

test('twenty failures from one address lock every name from it', () => {
  const limit = new LoginLimit();
  const t0 = 1_000_000;
  for (let i = 0; i < ADDRESS_MAX; i++) limit.fail(`name${i}`, '10.0.0.1', t0 + i);
  assert.equal(limit.locked('someone-else', '10.0.0.1', t0 + 30) > 0, true);
  assert.equal(limit.locked('someone-else', '10.0.0.2', t0 + 30), 0);
  limit.clear('name0', '10.0.0.1'); // a success forgives the pair, never the address
  assert.equal(limit.locked('name0', '10.0.0.1', t0 + 30) > 0, true);
});

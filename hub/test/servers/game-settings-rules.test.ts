import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditDetails, settingsRequest } from '../../src/servers/game-settings-rules.ts';
import { PASSWORD, REPORT, REQUEST } from './game-settings-hub.ts';

test('a save is checked field by field, each refusal naming the field and never the value', () => {
  assert.deepEqual(settingsRequest({ ...REQUEST, extra: 1, game_password: 'x!y' }), { ...REQUEST, game_password: 'x!y' }, 'unknown fields dropped');
  assert.equal(settingsRequest({ ...REQUEST, game_password: null }).game_password, null);
  assert.ok(!('game_password' in settingsRequest(REQUEST)), 'left out: kept');
  const bad: [string, unknown, RegExp][] = [
    ['name', '', /^name:/],
    ['name', 'x'.repeat(101), /^name:/],
    ['name', ' padded', /^name:/],
    ['name', 'two\nlines', /^name:/],
    ['description', 'x'.repeat(257), /^description:/],
    ['description', 'a\u2028b', /^description:/],
    ['max_players', 1001, /^max_players: a whole number from 0 to 1000/],
    ['max_players', -1, /^max_players:/],
    ['max_players', 1.5, /^max_players:/],
    ['autosave_interval', 1441, /^autosave_interval:/],
    ['autosave_slots', 0, /^autosave_slots:/],
    ['afk_autokick_interval', '5', /^afk_autokick_interval:/],
    ['auto_pause', 'yes', /^auto_pause:/],
    ['require_user_verification', undefined, /^require_user_verification:/],
    ['allow_commands', true, /^allow_commands:/],
    ['game_password', 'pass word', /^game_password:/],
    ['game_password', 'x'.repeat(65), /^game_password:/],
    ['game_password', 'pässword', /^game_password:/],
    ['admins', ['a b'], /^admins: each name/],
    ['admins', ['x'.repeat(61)], /^admins: each name/],
    ['admins', Array.from({ length: 101 }, (_, i) => `p${i}`), /^admins: a list of at most 100/],
    ['admins', ['Bob', 'bob'], /^admins: each name once/],
    ['admins', 'alice', /^admins:/],
  ];
  for (const [key, value, why] of bad) {
    assert.throws(
      () => settingsRequest({ ...REQUEST, [key]: value }),
      (err: Error & { status?: number }) => err.status === 400 && why.test(err.message) && (typeof value !== 'string' || value === '' || !err.message.includes(value)),
      `${key}: ${JSON.stringify(value)}`,
    );
  }
  assert.doesNotThrow(() => settingsRequest({ ...REQUEST, max_players: 1000, autosave_interval: 1440, name: 'x'.repeat(100), admins: Array.from({ length: 100 }, (_, i) => `p${i}`) }));
});

test('the audit names what changed, the password only as changed or removed, the admins as a diff', () => {
  const req = { ...REQUEST, name: 'Our base', max_players: 8, game_password: PASSWORD, admins: ['Alice', 'bob'] };
  assert.equal(auditDetails(req, REPORT), 'name: "orrery Factorio" → "Our base"; max_players: 0 → 8; game password changed; admins: +bob');
  assert.equal(auditDetails({ ...REQUEST, game_password: null, admins: [] }, REPORT), 'game password removed; admins: -alice');
  assert.equal(auditDetails(REQUEST, REPORT), 'no change');
  assert.equal(auditDetails({ ...REQUEST, admins: [] }, { ...REPORT, settings: null, admins: [] }).split('; ')[0], 'name: "orrery Factorio"', "an unreadable file: the new values only");
});

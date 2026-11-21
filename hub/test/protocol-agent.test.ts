// The Agent port's lines (`parseAgentLine`): every message parses, and only there; each checks its field types and
// values; game settings take each rule's edges (`GAME_SETTINGS`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAME_SETTINGS, parseAgentLine, parseModLine } from '../src/protocol.ts';
import { AGENT_MSGS } from './protocol-messages.ts';

test('every Agent port message parses, and only on the Agent port', () => {
  for (const [type, msg] of Object.entries(AGENT_MSGS)) {
    assert.deepEqual(parseAgentLine(JSON.stringify(msg)), msg, type);
    if (type !== 'hello') assert.equal(parseModLine(JSON.stringify(msg)), null, type);
  }
  assert.deepEqual(parseAgentLine('{"type":"reply","id":"4","ok":false,"error":"no such save"}'), { type: 'reply', id: '4', ok: false, error: 'no such save' });
  assert.deepEqual(parseAgentLine('{"type":"updateDone","id":"7","outcome":"ok","from":"a","to":"b"}'), { type: 'updateDone', id: '7', outcome: 'ok', from: 'a', to: 'b' });
  assert.deepEqual(parseAgentLine('{"type":"events","on":true}'), { type: 'events', on: true });
  const unreadable = { type: 'settings', settings: null, admins: [], problem: 'Unexpected end of file', pending: [], extra: [], rolledBack: 'x' };
  assert.deepEqual(parseAgentLine(JSON.stringify(unreadable)), unreadable, "a file that can't be read");
  // Game connection messages go through parseModLine once a game hello is accepted.
  assert.equal(parseAgentLine('{"type":"chat","player":"Ann","message":"hi"}'), null);
  for (const line of ['', 'not json', 'null', '[]', '{"type":"constructor"}', '{"type":"__proto__"}']) assert.equal(parseAgentLine(line), null, line);
});

test('Agent port messages check their field types and values', () => {
  const bad: [keyof typeof AGENT_MSGS, object][] = [
    ['agentHello', { protocol: '1' }],
    ['agentHello', { token: 32 }],
    ['hostSample', { sample: { ts: 1, cpu: 0, load: [], memory: { used: 1 }, disks: [] } }],
    ['hostSample', { sample: 'x' }],
    ['serviceState', { since: '1700000000000' }],
    ['saves', { saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'manual', current: false }] }],
    ['saves', { saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'auto', current: 'yes' }] }],
    ['saves', { free: null }],
    ['installed', { mods: [{ name: 'base' }] }],
    ['updateStep', { step: 'deploy' }],
    ['updateStep', { state: 'paused' }],
    ['updateDone', { outcome: 'running' }],
    ['updateDone', { backup: 1 }],
    ['deployResult', { outcome: 'running' }],
    ['events', { on: 'false' }],
    ['events', { reason: 1 }],
    ['reply', { ok: 'true' }],
    ['reply', { error: 1 }],
    ...([
      ['name', ''],
      ['name', ' padded'],
      ['name', 'two\nlines'],
      ['name', 'tab\there'],
      ['name', 'c1\u0085'],
      ['name', 'sep\u2028'],
      ['description', 'two\nlines'],
      ['description', 1],
      ['max_players', -1],
      ['max_players', 1001],
      ['max_players', 1.5],
      ['max_players', '8'],
      ['autosave_interval', 1441],
      ['autosave_slots', 0],
      ['autosave_slots', 101],
      ['afk_autokick_interval', 1441],
      ['auto_pause', 'yes'],
      ['game_password_set', 1],
      ['require_user_verification', null],
      ['allow_commands', 'maybe'],
      ['allow_commands', true],
    ] as const).map(([key, value]) => ['settings', { settings: { ...AGENT_MSGS.settings.settings, [key]: value } }] as [keyof typeof AGENT_MSGS, object]),
    ['settings', { settings: (({ auto_pause: _, ...rest }) => rest)(AGENT_MSGS.settings.settings) }],
    ['settings', { settings: 'x' }],
    ['settings', { admins: ['a b'] }],
    ['settings', { admins: ['x'.repeat(61)] }],
    ['settings', { admins: [''] }],
    ['settings', { problem: 1 }],
    ['settings', { pending: ['Auto_Pause'] }],
    ['settings', { extra: ['max-players'] }],
    ['settings', { extra: [''] }],
    ['settings', { rolledBack: false }],
    ['settings', { admins: undefined }],
  ];
  for (const [type, change] of bad) {
    assert.equal(parseAgentLine(JSON.stringify({ ...AGENT_MSGS[type], ...change })), null, `${type} ${JSON.stringify(change)}`);
  }
});

test("game settings take each rule's edges: the integer ranges, the name's length, any printable text, the admins' names", () => {
  const at = (change: object) => parseAgentLine(JSON.stringify({ ...AGENT_MSGS.settings, settings: { ...AGENT_MSGS.settings.settings, ...change } }));
  for (const [key, [min, max]] of Object.entries(GAME_SETTINGS.ranges)) {
    assert.ok(at({ [key]: min }), `${key} ${min}`);
    assert.ok(at({ [key]: max }), `${key} ${max}`);
    assert.equal(at({ [key]: min - 1 }), null, `${key} ${min - 1}`);
    assert.equal(at({ [key]: max + 1 }), null, `${key} ${max + 1}`);
  }
  assert.deepEqual(GAME_SETTINGS.ranges, { max_players: [0, 1000], autosave_interval: [0, 1440], autosave_slots: [1, 100], afk_autokick_interval: [0, 1440] });
  assert.ok(at({ name: 'Ünïcode "quoted" 😀 base', description: '' }), 'UTF-8, quotes and spaces; an empty description');
  for (const allow of ['true', 'false', 'admins-only']) assert.ok(at({ allow_commands: allow }), allow);
  const admins = (list: string[]) => parseAgentLine(JSON.stringify({ ...AGENT_MSGS.settings, admins: list }));
  assert.ok(admins(['A', 'x'.repeat(60), 'a_b.c-d', '0']));
  for (const name of ['a b', 'é', 'a/b', 'a\u0000', 'x'.repeat(61)]) assert.equal(admins([name]), null, name);
  // The password rule, for the hub's checks and the Agent's: printable ASCII, no space, 1 to 64.
  for (const ok of ['a', '!~', 'x'.repeat(64)]) assert.ok(GAME_SETTINGS.password.test(ok), ok);
  for (const bad of ['', 'pass word', 'é', 'tab\t', 'x'.repeat(65), 'del\u007f']) assert.ok(!GAME_SETTINGS.password.test(bad), JSON.stringify(bad));
  // Fields the schema doesn't hold are dropped: a username, a token, a password sent back by mistake.
  const sent = parseAgentLine(JSON.stringify({ ...AGENT_MSGS.settings, settings: { ...AGENT_MSGS.settings.settings, game_password: 'secret', token: 't' }, username: 'u' }));
  assert.deepEqual(sent, AGENT_MSGS.settings);
});

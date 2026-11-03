// Every constant against the hub's, the line cap, `url` and `GAME_SETTINGS` included; an update's URLs taken up to
// 2048 characters, refused at 2049; a `settingsSet`'s every field at and past its rule, its password left out, null or
// set; `printable`, also in command output and log lines.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as hub from '../../hub/src/protocol.ts';
import { GAME_SETTINGS, LIMITS, LineReader, LineTooLong, PROTOCOL_VERSION, encode, outputLines, printable, readAgentLine, readGameLine, replyLines } from '../src/wire.ts';

test('the constants are the hub contract: the protocol version and every field limit; the line cap is 1 MiB', () => {
  assert.equal(PROTOCOL_VERSION, hub.PROTOCOL_VERSION);
  assert.deepEqual(LIMITS, hub.LIMITS, 'every limit, the line cap included');
  assert.deepEqual(GAME_SETTINGS, hub.GAME_SETTINGS, "the game settings' rules: ranges and patterns");
  // An update's URLs have their own limit: a signed dl-mod.factorio.com link is longer than `text`.
  assert.equal(LIMITS.url, 2048);
  assert.equal(LIMITS.lineBytes, 1024 * 1024, "the owner's decision (2026-10-31): 1 MiB per line on the Agent port");
});

test('the line reader splits lines across chunks and bytes, UTF-8 included, and skips blank lines', () => {
  const r = new LineReader(64);
  const bytes = Buffer.from('{"a":"é"}\n\n{"b":1}\n{"c"');
  const lines: string[] = [];
  for (const byte of bytes) lines.push(...r.push(Buffer.from([byte])));
  lines.push(...r.push(Buffer.from(':2}\n')));
  assert.deepEqual(lines, ['{"a":"é"}', '{"b":1}', '{"c":2}']);
});

test('the line reader refuses a line over its cap, its newline counted, as soon as the cap is passed', () => {
  assert.deepEqual(new LineReader(8).push(Buffer.from('1234567\n')), ['1234567']);
  assert.throws(() => new LineReader(8).push(Buffer.from('12345678\n')), LineTooLong);
  const r = new LineReader(8);
  r.push(Buffer.from('1234'));
  r.push(Buffer.from('567'));
  assert.throws(() => r.push(Buffer.from('8')), LineTooLong, 'no newline needed to refuse');
});

test('encode keeps every line within 1 MiB: the oldest output or log lines go first, the JSON is never cut', () => {
  assert.equal(encode({ type: 'ping' }), '{"type":"ping"}\n');
  const kib = 'é'.repeat(1000); // 2000 bytes each, under 1 KiB of characters
  const output = Array.from({ length: 500 }, (_, i) => `${i} ${kib}`);
  const line = encode({ type: 'cmdResult', id: 'c1', output: [...output, ...output] })!;
  assert.ok(Buffer.byteLength(line) <= LIMITS.lineBytes);
  const sent = JSON.parse(line);
  assert.equal(sent.id, 'c1');
  assert.equal(sent.output.at(-1), output.at(-1), 'the newest line kept');
  assert.ok(sent.output.length < 1000 && sent.output.length > 400);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...sent, output: [output[0], ...sent.output] }) + '\n') > LIMITS.lineBytes, 'only as many dropped as needed');

  const reply = encode({ type: 'reply', id: 'r1', ok: true, data: { lines: [...output, ...output] } })!;
  assert.ok(Buffer.byteLength(reply) <= LIMITS.lineBytes);
  assert.equal(JSON.parse(reply).data.lines.at(-1), output.at(-1));
  assert.equal(encode({ type: 'chat', player: 'p', message: 'x'.repeat(LIMITS.lineBytes) }), null, 'anything else too big is not sent');
});

test('requests are checked against their documented fields and limits, and copied with only those', () => {
  assert.deepEqual(readAgentLine('{"type":"serviceAct","id":"r1","action":"restart","path":"/bin/sh"}'), {
    msg: { type: 'serviceAct', id: 'r1', action: 'restart' },
  });
  const update = {
    type: 'update',
    id: 'u1',
    factorio: { version: '2.1.25', url: 'https://dl.factorio.com/x', sha256: 'ab', extra: 1 },
    mods: [{ name: 'orrery', version: '0.1.0', sha1: 'cd', url: 'https://mods.example/x' }],
  };
  assert.deepEqual(readAgentLine(JSON.stringify(update)), {
    msg: { ...update, factorio: { version: '2.1.25', url: 'https://dl.factorio.com/x', sha256: 'ab' } },
  });
  // A signed link up to LIMITS.url (2048) is taken, for the game and each mod; one character more refuses the update.
  const link = (n: number) => `https://dl-mod.factorio.com/files/x.zip?secure=${'s'.repeat(n - 'https://dl-mod.factorio.com/files/x.zip?secure='.length)}`;
  for (const [factorio, mod] of [[2048, 2048], [256, 2048], [2048, 256]]) {
    const long = { ...update, factorio: { ...update.factorio, url: link(factorio!) }, mods: [{ ...update.mods[0]!, url: link(mod!) }] };
    assert.deepEqual(readAgentLine(JSON.stringify(long)), { msg: { ...long, factorio: { version: '2.1.25', url: link(factorio!), sha256: 'ab' } } });
  }
  for (const [factorio, mod] of [[2049, 256], [256, 2049]]) {
    const long = { ...update, factorio: { ...update.factorio, url: link(factorio!) }, mods: [{ ...update.mods[0]!, url: link(mod!) }] };
    assert.deepEqual(readAgentLine(JSON.stringify(long)), { msg: null, id: 'u1', why: 'invalid update' });
  }
  const mods = Array.from({ length: LIMITS.mods + 1 }, () => update.mods[0]);
  assert.deepEqual(readAgentLine(JSON.stringify({ ...update, mods })), { msg: null, id: 'u1', why: 'invalid update' });
  assert.deepEqual(readAgentLine('{"type":"deploy","id":"d1"}'), { msg: null, id: 'd1', why: 'invalid deploy' });
  assert.deepEqual(readAgentLine('{"type":"toString","id":"t1"}'), { msg: null, id: 't1', why: 'unknown type' });
  assert.deepEqual(readAgentLine(`{"type":"logs","id":"${'x'.repeat(257)}"}`), { msg: null, id: null, why: 'invalid logs' });
  assert.deepEqual(readAgentLine('{"type":"logs","id":7}'), { msg: null, id: null, why: 'invalid logs' });
  assert.deepEqual(readAgentLine('nope'), { msg: null, id: null, why: 'not JSON' });
  assert.deepEqual(readAgentLine('{"type":"welcome"}'), { msg: { type: 'welcome' } });
  assert.deepEqual(readGameLine('{"type":"reject","reason":"no agent connection"}'), { msg: { type: 'reject', reason: 'no agent connection' } });
  assert.deepEqual(readGameLine('{"type":"say","author":"a","message":"m"}'), { msg: { type: 'say', author: 'a', message: 'm', source: 'discord' } });
  assert.deepEqual(readGameLine('{"type":"save"}'), { msg: { type: 'save' } });
  assert.deepEqual(readGameLine('{"type":"stopping"}'), { msg: null, id: null, why: 'unknown type' });
});

test("settingsSet is checked field by field against the game settings' rules; the password is optional, or null", () => {
  const settings = {
    name: 'Our base',
    description: 'Ünïcode "quoted" 😀',
    max_players: 8,
    require_user_verification: false,
    autosave_interval: 10,
    autosave_slots: 5,
    afk_autokick_interval: 0,
    auto_pause: true,
    auto_pause_when_players_connect: false,
    only_admins_can_pause_the_game: true,
    allow_commands: 'false',
  };
  const set = { type: 'settingsSet', id: 's1', settings, admins: ['alice', 'Bob.the-2nd_'] };
  assert.deepEqual(readAgentLine(JSON.stringify({ ...set, settings: { ...settings, visibility: { public: true }, token: 't' }, path: '/x' })), { msg: set }, 'only the documented fields');
  assert.deepEqual(readAgentLine(JSON.stringify({ ...set, game_password: null })), { msg: { ...set, game_password: null } }, 'null removes it');
  assert.deepEqual(readAgentLine(JSON.stringify({ ...set, game_password: 'x'.repeat(64) })), { msg: { ...set, game_password: 'x'.repeat(64) } });
  const refused = { msg: null, id: 's1', why: 'invalid settingsSet' };
  for (const password of ['', 'pass word', 'x'.repeat(65), 'é', 'a\nb', 1, false]) {
    assert.deepEqual(readAgentLine(JSON.stringify({ ...set, game_password: password })), refused, `password ${JSON.stringify(password)}`);
  }
  for (const [key, value] of [
    ['name', ''],
    ['name', 'x'.repeat(101)],
    ['name', ' Our base'],
    ['name', 'Our\nbase'],
    ['description', 'x'.repeat(257)],
    ['description', 'a\u2028b'],
    ['max_players', 1001],
    ['max_players', -1],
    ['max_players', 2.5],
    ['autosave_interval', 1441],
    ['autosave_slots', 0],
    ['afk_autokick_interval', 1441],
    ['auto_pause', 'true'],
    ['allow_commands', true],
    ['allow_commands', 'maybe'],
  ] as const) {
    assert.deepEqual(readAgentLine(JSON.stringify({ ...set, settings: { ...settings, [key]: value } })), refused, `${key} ${JSON.stringify(value)}`);
  }
  assert.ok(readAgentLine(JSON.stringify({ ...set, settings: { ...settings, name: 'x'.repeat(100), description: 'x'.repeat(256), max_players: 1000 } })).msg);
  const { auto_pause: _, ...missing } = settings;
  assert.deepEqual(readAgentLine(JSON.stringify({ ...set, settings: missing })), refused, 'every key, none left out');
  for (const admins of [['a b'], ['x'.repeat(61)], ['../x'], Array(LIMITS.admins + 1).fill('a'), 'alice']) {
    assert.deepEqual(readAgentLine(JSON.stringify({ ...set, admins })), refused, `admins ${JSON.stringify(admins).slice(0, 40)}`);
  }
  assert.ok(readAgentLine(JSON.stringify({ ...set, admins: Array(LIMITS.admins).fill('x'.repeat(60)) })).msg, '100 admins of 60 characters');
});

test('printable: control characters (but a tab) and the line separators become ?; command output and log lines are printable', () => {
  assert.equal(printable('a\nb\r\u001b[2J\u001b]0;t\u0007\u0000\u007f\u009b\u2028\u2029 é 😀\tz'), 'a?b??[2J?]0;t?????? é 😀\tz');
  assert.equal(printable('world-1.zip'), 'world-1.zip');
  assert.deepEqual(outputLines('ok\r\nx\u001b[31my\n\t[C]: in ?'), ['ok', 'x?[31my', '\t[C]: in ?']);
  assert.deepEqual(replyLines(['a\u001b]52;c;Zm9v\u0007', 'stack traceback:', '\t[C]: in ?']), ['a?]52;c;Zm9v?', 'stack traceback:', '\t[C]: in ?']);
});

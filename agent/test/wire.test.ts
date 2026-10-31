import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as hub from '../../hub/src/protocol.ts';
import { LIMITS, LineReader, LineTooLong, PROTOCOL_VERSION, encode, readAgentLine, readGameLine } from '../src/wire.ts';

test('the constants are the hub contract: the protocol version and every field limit; the line cap is 1 MiB', () => {
  assert.equal(PROTOCOL_VERSION, hub.PROTOCOL_VERSION);
  const { lineBytes, ...limits } = LIMITS;
  const { lineBytes: _, ...hubLimits } = hub.LIMITS;
  assert.deepEqual(limits, hubLimits);
  // The owner's decision (2026-10-31): 1 MiB per line on the Agent port; hub/src/protocol.ts at 32ef6e4 still says 64 KiB.
  assert.equal(lineBytes, 1024 * 1024);
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
  assert.deepEqual(readGameLine('{"type":"save"}'), { msg: null, id: null, why: 'unknown type' }); // not handled until M5
});

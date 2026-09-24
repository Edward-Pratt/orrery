import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModLine } from '../src/protocol.ts';

test('parses valid messages', () => {
  assert.deepEqual(parseModLine('{"type":"chat","player":"Steve","message":"hi"}'), {
    type: 'chat',
    player: 'Steve',
    message: 'hi',
  });
  assert.deepEqual(parseModLine('{"type":"started"}'), { type: 'started' });
  assert.deepEqual(parseModLine('{"type":"heartbeat","tps":19.9,"players":["a","b"]}'), {
    type: 'heartbeat',
    tps: 19.9,
    players: ['a', 'b'],
  });
});

test('rejects malformed JSON and non-objects', () => {
  for (const line of ['', 'not json', 'null', '42', '"chat"', '[]']) assert.equal(parseModLine(line), null, line);
});

test('rejects unknown types, including Object.prototype keys', () => {
  for (const type of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(parseModLine(JSON.stringify({ type })), null, type);
  }
});

test('rejects wrong field types', () => {
  assert.equal(parseModLine('{"type":"chat","player":"Steve","message":42}'), null);
  assert.equal(parseModLine('{"type":"chat","player":"Steve"}'), null);
  assert.equal(parseModLine('{"type":"heartbeat","tps":"20","players":[]}'), null);
  assert.equal(parseModLine('{"type":"heartbeat","tps":20,"players":["a",1]}'), null);
  assert.equal(parseModLine('{"type":"cmdResult","id":"x","output":"not an array"}'), null);
});

test('heartbeat dims are optional but validated', () => {
  assert.ok(parseModLine('{"type":"heartbeat","tps":20,"players":[]}'));
  const dims = [{ id: 0, name: 'Overworld', ms: 12.5 }];
  assert.deepEqual(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims })), {
    type: 'heartbeat',
    tps: 20,
    players: [],
    dims,
  });
  const six = Array(6).fill(dims[0]);
  assert.equal(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims: six })), null);
  assert.equal(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims: [{ id: 0, name: '', ms: 1 }] })), null);
  assert.equal(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims: 'x' })), null);
});

test('v1.2b messages validate every field', () => {
  assert.ok(parseModLine('{"type":"quest","player":"Steve","quests":[{"name":"Stone Age","main":true}]}'));
  assert.equal(parseModLine('{"type":"quest","player":"Steve","quests":[]}'), null);
  assert.equal(parseModLine('{"type":"quest","player":"Steve","quests":[{"name":"x","main":"yes"}]}'), null);
  assert.ok(parseModLine('{"type":"link","player":"Steve","uuid":"u","code":"ABC234"}'));
  assert.equal(parseModLine('{"type":"link","player":"Steve","code":"ABC234"}'), null);
  assert.ok(parseModLine('{"type":"unlink","player":"Steve"}'));
  assert.ok(parseModLine('{"type":"backup","ok":false,"detail":"disk full"}'));
  assert.equal(parseModLine('{"type":"backup","ok":"false","detail":"x"}'), null);
  assert.ok(parseModLine('{"type":"cmdLate","id":"1","output":["a"]}'));
  assert.ok(parseModLine('{"type":"unlink","player":"Steve","extra":1}')); // extra fields are ignored
});

// A Mod's lines (`parseModLine`): valid messages, malformed and unknown ones, field types, `heartbeat`'s dims, the v1.2b
// messages, what the Mod sends, copies holding only the schema's fields (an Agent port message's too), and a game
// connection's milestones and paused heartbeat. The Agent port is in `protocol-agent.test.ts`, the limits in
// `protocol-limits.test.ts`, a reply's data in `protocol-replies.test.ts`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentLine, parseModLine } from '../src/protocol.ts';

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
  assert.deepEqual(parseModLine('{"type":"unlink","player":"Steve","extra":1}'), { type: 'unlink', player: 'Steve' }); // extra fields are dropped
});

test('the Mod port keeps parsing what the Mod and the tests send', () => {
  const lines = [
    { type: 'hello', protocol: 1, serverId: 'gtnh', token: 'test-token-0123456', modVersion: '2.6.0' },
    { type: 'heartbeat', tps: 18, players: ['Steve', 'Alex'], dims: [{ id: -1, name: 'Nether', ms: 60 }] },
    { type: 'chat', player: 'Steve', message: 'hi' },
    { type: 'death', player: 'Steve', message: 'Steve fell from a high place' },
    { type: 'achievement', player: 'Steve', achievement: 'Taking Inventory' },
    { type: 'cmdResult', id: '1', output: ['There are 0/20 players online:'] },
    { type: 'cmdLate', id: '1', output: ['https://spark.lucko.me/abc'] },
    { type: 'quest', player: 'Steve', quests: [{ name: 'Stone Age', main: true }] },
    { type: 'link', player: 'Steve', uuid: 'u-1', code: 'ABC234' },
    { type: 'backup', ok: true, detail: 'Backup done in 1 s' },
  ];
  for (const msg of lines) assert.deepEqual(parseModLine(JSON.stringify(msg)), msg, msg.type);
});

test('parsed messages hold only their schema fields, nested ones too', () => {
  assert.deepEqual(parseModLine('{"type":"chat","player":"Steve","message":"hi","serverId":"other","stopping":true}'), {
    type: 'chat',
    player: 'Steve',
    message: 'hi',
  });
  const heartbeat = parseModLine(
    JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims: [{ id: 0, name: 'Overworld', ms: 1, extra: 'x' }], extra: 1 }),
  );
  assert.deepEqual(heartbeat, { type: 'heartbeat', tps: 20, players: [], dims: [{ id: 0, name: 'Overworld', ms: 1 }] });
  const quest = parseModLine('{"type":"quest","player":"S","quests":[{"name":"x","main":true,"by":"y"}]}');
  assert.deepEqual(quest, { type: 'quest', player: 'S', quests: [{ name: 'x', main: true }] });
  const proto = parseModLine('{"type":"unlink","player":"Steve","__proto__":{"polluted":true}}')!;
  assert.deepEqual(Object.keys(proto), ['type', 'player']);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  const sample = parseAgentLine(
    JSON.stringify({
      type: 'hostSample',
      sample: { ts: 1, cpu: 0.5, load: [1, 2, 3], memory: { used: 1, total: 2, swap: 3 }, disks: [{ mount: '/', free: 1, total: 2, dev: 'x' }], extra: 1 },
    }),
  );
  assert.deepEqual(sample, { type: 'hostSample', sample: { ts: 1, cpu: 0.5, load: [1, 2, 3], memory: { used: 1, total: 2 }, disks: [{ mount: '/', free: 1, total: 2 }] } });
  const saves = parseAgentLine('{"type":"saves","saves":[{"name":"a.zip","size":1,"mtime":2,"kind":"auto","current":false,"path":"/etc"}],"free":3}');
  assert.deepEqual(saves, { type: 'saves', saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'auto', current: false }], free: 3 });
});

test('a game connection may send milestones and a paused heartbeat', () => {
  assert.deepEqual(parseModLine('{"type":"heartbeat","tps":0,"players":[],"paused":true}'), { type: 'heartbeat', tps: 0, players: [], paused: true });
  assert.equal(parseModLine('{"type":"heartbeat","tps":0,"players":[],"paused":"yes"}'), null);
  for (const kind of ['research', 'rocket', 'platform', 'landing']) {
    assert.ok(parseModLine(JSON.stringify({ type: 'milestone', kind, text: 'x' })), kind);
  }
  const landing = { type: 'milestone', kind: 'landing', text: 'First landing on Vulcanus', player: 'Ann', force: 'player' };
  assert.deepEqual(parseModLine(JSON.stringify(landing)), landing);
  assert.equal(parseModLine('{"type":"milestone","kind":"boss","text":"x"}'), null);
  assert.equal(parseModLine('{"type":"milestone","kind":"rocket"}'), null);
  assert.equal(parseModLine('{"type":"milestone","kind":"rocket","text":"x","player":1}'), null);
  assert.equal(parseModLine('{"type":"agentHello","protocol":1,"agentId":"vm","token":"t","agentVersion":"1"}'), null); // Agent port only
});

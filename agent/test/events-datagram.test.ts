// `parseDatagram` against the hub's `parseModLine`: the mod's datagrams map to the game connection's messages, within
// the hub's limits, and those that aren't the mod's shape are dropped; `deathMessage`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModLine } from '../../hub/src/protocol.ts';
import { deathMessage, parseDatagram, type GameEvent } from '../src/events-datagram.ts';

test('the mod’s datagrams map to the game connection’s messages, within the hub’s limits', () => {
  const read = (msg: object) => parseDatagram(Buffer.from(JSON.stringify(msg)));
  const cases: [object, GameEvent][] = [
    [{ seq: 1, t: 'chat', player: 'Alice', message: 'hi [color=red]x[/color]' }, { type: 'chat', player: 'Alice', message: 'hi [color=red]x[/color]' }],
    [{ seq: 2, t: 'join', player: 'Alice' }, { type: 'join', player: 'Alice' }],
    [{ seq: 3, t: 'leave', player: 'Alice', reason: 'dropped' }, { type: 'leave', player: 'Alice' }],
    [{ seq: 4, t: 'death', player: 'Alice', cause: 'medium-biter' }, { type: 'death', player: 'Alice', message: 'Alice was killed by a medium biter' }],
    [{ seq: 5, t: 'death', player: 'Alice', cause: 'character', killer: 'Bob' }, { type: 'death', player: 'Alice', message: 'Alice was killed by Bob' }],
    [{ seq: 6, t: 'death', player: 'Alice', cause: 'artillery-turret' }, { type: 'death', player: 'Alice', message: 'Alice was killed by an artillery turret' }],
    [{ seq: 7, t: 'death', player: 'Alice' }, { type: 'death', player: 'Alice', message: 'Alice died' }],
    [{ seq: 8, t: 'milestone', kind: 'research', text: 'Mining productivity 5' }, { type: 'milestone', kind: 'research', text: 'Mining productivity 5' }],
    [{ seq: 9, t: 'milestone', kind: 'rocket', text: '', force: 'enemy-team' }, { type: 'milestone', kind: 'rocket', text: '', force: 'enemy-team' }],
    [{ seq: 10, t: 'milestone', kind: 'landing', text: 'Vulcanus', player: 'Alice' }, { type: 'milestone', kind: 'landing', text: 'Vulcanus', player: 'Alice' }],
    [{ seq: 11, t: 'milestone', kind: 'platform', text: 'Ship', player: 'x'.repeat(65) }, { type: 'milestone', kind: 'platform', text: 'Ship' }],
    [{ seq: 12, t: 'link', player: 'Alice', code: 'ABC234' }, { type: 'link', player: 'Alice', uuid: '', code: 'ABC234' }],
    [{ seq: 13, t: 'unlink', player: 'Alice', extra: 'dropped' }, { type: 'unlink', player: 'Alice' }],
    [{ seq: 14, t: 'chat', player: 'Alice', message: '😀'.repeat(600) }, { type: 'chat', player: 'Alice', message: '😀'.repeat(512) }],
    [{ seq: 15, t: 'death', player: 'Alice', cause: 'x'.repeat(65) }, { type: 'death', player: 'Alice', message: 'Alice died' }],
  ];
  for (const [msg, event] of cases) {
    const d = read(msg);
    assert.deepEqual(d, { seq: (msg as { seq: number }).seq, event }, JSON.stringify(msg));
    assert.deepEqual(parseModLine(JSON.stringify(event)), event, 'the hub takes it as it is');
  }
  assert.deepEqual(read({ seq: 0, t: 'hello' }), { seq: 0, event: null });
  const dropped: object[] = [
    { t: 'chat', player: 'Alice', message: 'no seq' },
    { seq: -1, t: 'join', player: 'Alice' },
    { seq: 1.5, t: 'join', player: 'Alice' },
    { seq: '1', t: 'join', player: 'Alice' },
    { seq: 1, player: 'Alice' },
    { seq: 1, t: 'quit', player: 'Alice' },
    { seq: 1, t: 'join' },
    { seq: 1, t: 'join', player: '' },
    { seq: 1, t: 'join', player: 'x'.repeat(65) },
    { seq: 1, t: 'chat', player: 'Alice' },
    { seq: 1, t: 'milestone', kind: 'launch', text: 'x' },
    { seq: 1, t: 'milestone', kind: 'research' },
    { seq: 1, t: 'link', player: 'Alice', code: 'ABC 234' },
    { seq: 1, t: 'link', player: 'Alice', code: 'A'.repeat(17) },
    { seq: 1, t: 'link', player: 'Alice' },
  ];
  for (const msg of dropped) assert.equal(typeof read(msg), 'string', JSON.stringify(msg));
  assert.equal(typeof parseDatagram(Buffer.from('{"seq":1,')), 'string');
  assert.equal(typeof parseDatagram(Buffer.from('[1]')), 'string');
  assert.equal(deathMessage('Alice', 'locomotive', null), 'Alice was killed by a locomotive');
});

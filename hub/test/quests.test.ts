import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuestAnnouncer, type QuestBatch, type QuestMode } from '../src/quests.ts';

const main = { name: 'Stone Age', main: true };
const q = (name: string) => ({ name, main: false });

function setup(mode: QuestMode) {
  const out: QuestBatch[] = [];
  const announcer = new QuestAnnouncer({ s: mode }, (b) => out.push(b));
  return { announcer, out };
}

test('batched: main quests at once, the rest rolled up per player on flush', () => {
  const { announcer, out } = setup('batched');
  announcer.add('s', 'Steve', [main, q('a')]);
  announcer.add('s', 'Steve', [q('b'), q('c')]);
  announcer.add('s', 'Alex', [q('d')]);
  assert.deepEqual(out, [{ serverId: 's', player: 'Steve', quests: [main], count: 1 }]);
  announcer.flush();
  assert.deepEqual(out.slice(1), [
    { serverId: 's', player: 'Steve', quests: [q('c')], count: 3 },
    { serverId: 's', player: 'Alex', quests: [q('d')], count: 1 },
  ]);
  announcer.flush();
  assert.equal(out.length, 3); // nothing left
});

test('main, all and off modes', () => {
  const m = setup('main');
  m.announcer.add('s', 'Steve', [main, q('a')]);
  m.announcer.flush();
  assert.deepEqual(m.out, [{ serverId: 's', player: 'Steve', quests: [main], count: 1 }]);
  const all = setup('all');
  all.announcer.add('s', 'Steve', [main, q('a')]);
  assert.deepEqual(all.out, [{ serverId: 's', player: 'Steve', quests: [main, q('a')], count: 2 }]);
  const off = setup('off');
  off.announcer.add('s', 'Steve', [main]);
  off.announcer.flush();
  assert.deepEqual(off.out, []);
});

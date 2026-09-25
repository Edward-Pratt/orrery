import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuestAnnouncer, type QuestMode } from '../src/quests.ts';
import type { Announcement, ServerHub } from '../src/servers.ts';

const main = { name: 'Stone Age', main: true };
const q = (name: string) => ({ name, main: false });

function setup(mode: QuestMode) {
  const out: (Announcement & { serverId: string })[] = [];
  const hub = { announce: (serverId: string, a: Announcement) => out.push({ ...a, serverId }) } as unknown as Pick<ServerHub, 'announce'>;
  const announcer = new QuestAnnouncer(hub, { s: mode });
  return { announcer, out };
}

test('batched: main quests at once, the rest rolled up per player on flush', () => {
  const { announcer, out } = setup('batched');
  announcer.add('s', 'Steve', [main, q('a')]);
  announcer.add('s', 'Steve', [q('b'), q('c')]);
  announcer.add('s', 'Alex', [q('d')]);
  assert.deepEqual(out, [{ type: 'questBatch', player: 'Steve', quests: [main], count: 1, serverId: 's' }]);
  announcer.flush();
  assert.deepEqual(out.slice(1), [
    { type: 'questBatch', player: 'Steve', quests: [q('c')], count: 3, serverId: 's' },
    { type: 'questBatch', player: 'Alex', quests: [q('d')], count: 1, serverId: 's' },
  ]);
  announcer.flush();
  assert.equal(out.length, 3); // nothing left
});

test('main, all and off modes', () => {
  const m = setup('main');
  m.announcer.add('s', 'Steve', [main, q('a')]);
  m.announcer.flush();
  assert.deepEqual(m.out, [{ type: 'questBatch', player: 'Steve', quests: [main], count: 1, serverId: 's' }]);
  const all = setup('all');
  all.announcer.add('s', 'Steve', [main, q('a')]);
  assert.deepEqual(all.out, [{ type: 'questBatch', player: 'Steve', quests: [main, q('a')], count: 2, serverId: 's' }]);
  const off = setup('off');
  off.announcer.add('s', 'Steve', [main]);
  off.announcer.flush();
  assert.deepEqual(off.out, []);
});

// `GameEvents`' link flow: `link` for an offline name dropped, `link` with `uuid ""`, and so `unlink`; a link from a
// player not in the last poll's list relayed after a fresh `/orrery-status` has them, every drop logged. The setup is
// `events-world.ts`'s.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { eventually } from './fake-hub.ts';
import { BANNER, printed, setup, up } from './events-world.ts';

test('link for an offline name is dropped; for an online one it is relayed with uuid "", and so is unlink', async (t) => {
  const s = await setup(t);
  await s.start([BANNER, up(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on');
  await s.send(s.factorio, { seq: 1, t: 'link', player: 'Mallory', code: 'ABC234' });
  await s.send(s.factorio, { seq: 2, t: 'unlink', player: 'Mallory' });
  await s.send(s.factorio, { seq: 3, t: 'link', player: 'Alice', code: 'ABC234' });
  await s.send(s.factorio, { seq: 4, t: 'unlink', player: 'Alice' });
  await eventually(() => s.got.length === 2);
  await sleep(30);
  assert.deepEqual(s.got, [
    { type: 'link', player: 'Alice', uuid: '', code: 'ABC234' },
    { type: 'unlink', player: 'Alice' },
  ]);
  s.players.push('Mallory'); // the next /orrery-status has them online
  await s.send(s.factorio, { seq: 5, t: 'link', player: 'Mallory', code: 'XYZ999' });
  await eventually(() => s.got.length === 3);
  assert.deepEqual(s.got[2], { type: 'link', player: 'Mallory', uuid: '', code: 'XYZ999' });
});

test('a link from a player who joined since the last poll: a fresh /orrery-status decides; every drop is logged', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const asked: string[] = [];
  const s = await setup(t, {
    run: async (command) => {
      asked.push(command);
      // The fresh poll: Mallory joined after the last one, which had only Alice.
      return command === '/orrery-status' ? JSON.stringify({ ok: true, tick: 1, players: ['Alice', 'Mallory'], version: '2.1.24', mods: { orrery: '0.1.0' } }) : '{"ok":true}';
    },
  });
  await s.start([BANNER, up(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on');
  await s.send(s.factorio, { seq: 1, t: 'link', player: 'Mallory', code: 'ABC234' });
  await eventually(() => s.got.length === 1, 2000, 'the link');
  assert.deepEqual(s.got, [{ type: 'link', player: 'Mallory', uuid: '', code: 'ABC234' }]);
  assert.deepEqual(asked, ['/orrery-status']);
  await s.send(s.factorio, { seq: 2, t: 'unlink', player: 'Alice' }); // online at the last poll: no fresh one
  await eventually(() => s.got.length === 2, 2000, 'the unlink');
  assert.deepEqual(asked, ['/orrery-status']);

  const drops = () => printed(log).filter((l) => l.startsWith('[events] dropped a'));
  await s.send(s.factorio, { seq: 3, t: 'link', player: 'Bob\n2026 forged', code: 'ABC234' });
  await s.send(s.factorio, { seq: 4, t: 'unlink', player: 'Bob' });
  await s.send(s.factorio, { seq: 5, t: 'unlink', player: 'Bob' });
  await eventually(() => drops().length === 3, 2000, 'every drop logged');
  assert.deepEqual(drops(), [
    '[events] dropped a link for Bob?2026 forged: not online at a fresh /orrery-status',
    '[events] dropped an unlink for Bob: not online at a fresh /orrery-status',
    '[events] dropped an unlink for Bob: not online at a fresh /orrery-status',
  ]);
  assert.equal(s.got.length, 2);
});

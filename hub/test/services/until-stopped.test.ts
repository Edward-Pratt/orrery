// The stop's poll pack and game updates share (`until-stopped.ts`): it ends at a stopped unit, at `over` without
// reading again, and past `stopMs` with the error the updates log; both updates end it when the hub closes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inactive as packStop } from '../../src/packs/pack-job.ts';
import { untilStopped } from '../../src/services/until-stopped.ts';
import { inactive as gameStop } from '../../src/updates/game-job.ts';

const unit = (states: string[]) => {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    read: async () => ({ state: states[Math.min(reads++, states.length - 1)] }) as never,
  };
};

test('the poll reads the unit until it is inactive or failed', async () => {
  for (const last of ['inactive', 'failed']) {
    const s = unit(['active', 'deactivating', last]);
    await untilStopped(s, 'factorio', { stopMs: 1_000, pollMs: 1 }, () => false);
    assert.equal(s.reads, 3);
  }
});

test('the poll ends once over says so, and reads nothing after it: a closing hub leaves no poll running', async () => {
  const s = unit(['active']);
  let closed = false;
  const poll = untilStopped(s, 'factorio', { stopMs: 60_000, pollMs: 1 }, () => closed);
  while (s.reads < 3) await new Promise((r) => setTimeout(r, 1));
  closed = true;
  await poll;
  const reads = s.reads;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.reads, reads);
});

test('a unit still up past stopMs fails the poll, naming the time', async () => {
  const s = unit(['active']);
  await assert.rejects(untilStopped(s, 'factorio', { stopMs: 20, pollMs: 1 }, () => false), { message: "The service didn't stop within 0 s." });
});

test('a closing hub ends both updates\' polls: a game update\'s resolves for its caller to see, a pack update\'s throws', async () => {
  const s = unit(['active']);
  const c = { closed: false, d: { services: s }, o: { stopMs: 60_000, pollMs: 1 } };
  const game = gameStop(c as never, 'factorio', () => false);
  const pack = packStop(c as never, 'gtnh');
  while (s.reads < 4) await new Promise((r) => setTimeout(r, 1));
  c.closed = true;
  await game;
  await assert.rejects(pack, { message: 'The hub is closing.' });
});

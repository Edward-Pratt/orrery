import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db } from '../src/db.ts';
import { PlaytimeTracker } from '../src/playtime.ts';
import type { ServerHub, ServerState } from '../src/servers.ts';

process.env.TZ = 'Europe/London';

function setup() {
  let states: ServerState[] = [];
  const hub = { list: () => states } as unknown as Pick<ServerHub, 'list'>;
  const db = new Db(':memory:');
  const tracker = new PlaytimeTracker(hub, db);
  const server = (players: string[], online = true): ServerState[] => [
    { id: 's', name: 'S', online, hung: false, tps: 20, players, dims: [] },
  ];
  return { db, tracker, set: (s: ServerState[]) => (states = s), server };
}

test('polls open and close sessions as players come and go', () => {
  const { db, tracker, set, server } = setup();
  const t0 = Date.UTC(2026, 8, 24, 12, 0);
  set(server(['Steve']));
  tracker.poll(t0);
  set(server(['Steve', 'Alex']));
  tracker.poll(t0 + 10_000);
  set(server(['Alex']));
  tracker.poll(t0 + 30_000);
  assert.equal(db.playtime('s', 'Steve', 0, t0 + 60_000, t0 + 60_000), 30_000);
  assert.deepEqual(db.lastSeen('s', 'Alex'), { online: true });
  assert.equal(db.peak('s', '2026-09-24'), 2);
});

test('a server going offline closes every session', () => {
  const { db, tracker, set, server } = setup();
  const t0 = Date.UTC(2026, 8, 24, 12, 0);
  set(server(['Steve', 'Alex']));
  tracker.poll(t0);
  set(server([], false));
  tracker.poll(t0 + 5000);
  assert.equal(db.lastSeen('s', 'Steve'), t0 + 5000);
  assert.equal(db.lastSeen('s', 'Alex'), t0 + 5000);
});

test('peaks are keyed by the local day, not UTC', () => {
  const { db, tracker, set, server } = setup();
  set(server(['Steve']));
  tracker.poll(Date.UTC(2026, 8, 24, 23, 30)); // 00:30 BST on 25 Sep
  assert.equal(db.peak('s', '2026-09-25'), 1);
  assert.equal(db.peak('s', '2026-09-24'), null);
});

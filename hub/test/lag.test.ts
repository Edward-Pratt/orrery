import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db } from '../src/db.ts';
import { LagMonitor, sparkline, type LagConfig } from '../src/lag.ts';
import type { ServerHub, ServerState } from '../src/servers.ts';

const MIN = 60_000;

function setup(configs: Record<string, LagConfig> = { s: { tps: 15, minutes: 2, enabled: true } }) {
  let state: ServerState = { id: 's', name: 'S', online: true, hung: false, tps: 20, players: [], dims: [] };
  const hub = { list: () => [state] } as unknown as Pick<ServerHub, 'list'>;
  const db = new Db(':memory:');
  const notices: string[] = [];
  const lag = new LagMonitor(hub, db, configs, (_id, text) => notices.push(text));
  let now = 1_000_000;
  const sample = (patch: Partial<ServerState>) => {
    state = { ...state, ...patch };
    lag.sample((now += MIN));
  };
  return { db, notices, sample };
}

const nether = [{ id: -1, name: 'Nether', ms: 72.4 }];

test('alerts after TPS stays low for the configured minutes, then once on recovery', () => {
  const { notices, sample } = setup();
  sample({ tps: 12.3, dims: nether });
  assert.deepEqual(notices, []); // one low minute isn't lag yet
  sample({ tps: 12.3, dims: nether });
  sample({ tps: 11, dims: nether }); // still lagging: no repeat
  assert.deepEqual(notices, ['🐢 Lag: 12.3 TPS; slowest: Nether (DIM -1) 72 ms/tick']);
  sample({ tps: 19.9 });
  sample({ tps: 20 });
  assert.deepEqual(notices.slice(1), ['✅ TPS back to normal (19.9)']);
});

test('a single normal sample resets the count', () => {
  const { notices, sample } = setup();
  sample({ tps: 10 });
  sample({ tps: 20 });
  sample({ tps: 10 });
  assert.deepEqual(notices, []);
});

test('offline or hung servers are neither sampled nor judged; lag state clears silently', () => {
  const { db, notices, sample } = setup();
  sample({ tps: 10 });
  sample({ tps: 10 }); // lag alert
  sample({ online: false, tps: null });
  sample({ online: true, hung: true, tps: 10 });
  sample({ hung: false, tps: 20 }); // back: no "back to normal", the outage had its own alerts
  assert.equal(notices.length, 1);
  assert.equal(db.tpsSince('s', 0).length, 3);
});

test('thresholds are per server and can be switched off', () => {
  const strict = setup({ s: { tps: 18, minutes: 1, enabled: true } });
  strict.sample({ tps: 17 });
  assert.equal(strict.notices.length, 1);
  const off = setup({ s: { tps: 15, minutes: 1, enabled: false } });
  off.sample({ tps: 5 });
  assert.deepEqual(off.notices, []);
  assert.equal(off.db.tpsSince('s', 0).length, 1); // still recorded for /tps
});

test('sparkline scales 0–20 TPS onto eight bars', () => {
  assert.equal(sparkline([0, 5, 10, 15, 20, 25, -1]), '▁▃▅▇██▁');
});

// Game updates, on the Host `fake-world.ts` builds: a restart mid-swap (the agent dying as it starts the new Factorio)
// rolled back from `state/update.json`, a restart in the stop step leaving a server stopped before the update stopped
// (and starting one the hub stopped), and an `updateDone` kept until a connect, and while its write fails
// (`update.json` kept, sent again on each connect, a new `update` refused meanwhile); a planted
// `/srv/factorio/update.json` (and `/srv/factorio/state/update.json`) ignored, a malformed own one removed.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { eventually } from './fake-hub.ts';
import { type Done, world, exists, until } from './fake-world.ts';

test("an updateDone whose write failed stays pending: update.json kept, sent again on each connect until a write succeeds, refusing a new update meanwhile", async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  w.written = false; // the connection drops as the updateDone goes out
  await w.u.cancel();
  const done = await w.done();
  assert.equal(done.outcome, 'cancelled');
  await sleep(50);
  assert.equal(JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).outcome, 'cancelled', 'kept');
  await assert.rejects(w.u.update(w.request('2.1.25', [['orrery', '0.2.0']], 'u2')), /the update u1 has not been reported yet/);

  w.u.connected(); // a reconnect whose write fails too
  await eventually(() => w.sent.filter((m) => m.type === 'updateDone').length === 2, 2000, 'sent again');
  await sleep(50);
  assert.ok(await exists(join(w.state, 'update.json')));

  w.written = true;
  w.u.connected();
  await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'update.json removed once a write succeeded');
  const dones = w.sent.filter((m) => m.type === 'updateDone');
  assert.equal(dones.length, 3);
  for (const d of dones) assert.deepEqual(d, done, 'the same each time: the hub ignores a repeat');
  w.u.connected();
  await sleep(50);
  assert.equal(w.sent.filter((m) => m.type === 'updateDone').length, 3, 'not again once written');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']], 'u2'));
  await eventually(() => w.steps().find((m) => m.id === 'u2' && m.step === 'stop'), 5000, "u2's stop");
  await w.u.cancel();
  await eventually(() => w.sent.find((m) => m.type === 'updateDone' && m.id === 'u2'), 5000, "u2's updateDone");
});

test('a restart of the agent mid-swap rolls back from state/update.json', async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  w.unit.hang = true; // the agent dies as it starts the new Factorio
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']]));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  await w.u.resume();
  await eventually(() => w.unit.calls.includes('start') || null, 3000, 'the swap to start the server');
  assert.equal(JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).phase, 'gate');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.25', 'swapped');

  w.unit.hang = false;
  w.sent.length = 0;
  const u = w.restart();
  await u.start();
  const done = await w.done();
  assert.equal(done.outcome, 'rolled back');
  assert.equal(done.id, 'u1');
  assert.match((await w.step('gate', 'failed')).detail, /The agent restarted before the health gate passed/);
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  assert.deepEqual((await readdir(join(w.data, 'mods'))).sort(), ['mod-list.json', 'mod-settings.dat', 'orrery_0.1.0.zip']);
  assert.equal(await readFile(join(w.data, 'mods/mod-settings.dat'), 'utf8'), 'startup settings v1');
  assert.match((await w.saves.list()).saves[0]!.name, /^restored-\d{8}T\d{6}Z-orrery-pre-update-2\.1\.24-/);
  assert.equal(w.unit.state.active, 'active');
  await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'update.json removed once reported');

  // Not connected when it ends: the updateDone waits for the next connect.
  const before = w.sent.length;
  w.connected = false;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']], 'u2'));
  await until(async () => JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).phase === 'stop', 5000, 'u2 at its stop');
  await w.u.cancel();
  await until(async () => JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).phase === 'done', 3000, 'u2 done');
  assert.equal(w.sent.length, before, 'nothing sent while not connected');
  w.connected = true;
  w.u.connected();
  const late = w.sent.slice(before);
  assert.deepEqual(late.map((m) => m.type), ['updateDone']);
  assert.equal((late[0] as Done).outcome, 'cancelled');
});

test('a planted /srv/factorio/update.json is ignored', async (t) => {
  const w = await world(t);
  const planted = {
    id: 'evil',
    factorio: '2.1.25',
    mods: [],
    expect: null,
    from: { factorio: '2.1.20', mods: null, count: null },
    previous: 'releases/2.1.20',
    backup: 'world.zip',
    phase: 'gate',
    outcome: null,
    resumed: true,
  };
  await writeFile(join(w.data, 'update.json'), JSON.stringify(planted));
  await mkdir(join(w.data, 'state'));
  await writeFile(join(w.data, 'state/update.json'), JSON.stringify(planted));
  await w.u.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(w.sent, [], 'no step, no updateDone');
  assert.deepEqual(w.unit.calls, [], 'the server untouched');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  assert.equal(await readFile(join(w.data, 'update.json'), 'utf8'), JSON.stringify(planted), 'not even removed');
  assert.equal(w.u.busy, false);

  // The agent's own file in another shape is no update either: removed, nothing done.
  await writeFile(join(w.state, 'update.json'), JSON.stringify({ ...planted, previous: '../../etc' }));
  await w.restart().start();
  assert.equal(await exists(join(w.state, 'update.json')), false);
  assert.deepEqual(w.unit.calls, []);
});

test("a restart of the agent in the stop step leaves a server stopped before the update stopped, and starts one the hub stopped", async (t) => {
  const w = await world(t);
  await w.unit.act('stop');
  w.unit.calls.length = 0;
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  assert.equal(JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).wasActive, false);
  w.sent.length = 0;
  let u = w.restart();
  await u.start();
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.deepEqual(w.unit.calls, [], 'the owner stopped it: it stays stopped');
  assert.equal(w.unit.state.active, 'inactive');
  await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'update.json removed once reported');

  // Running at the backup, then stopped by the hub before its updateResume reached the agent: started again.
  await w.unit.act('start');
  w.unit.calls.length = 0;
  w.sent.length = 0;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']], 'u2'));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  w.sent.length = 0;
  u = w.restart();
  await u.start();
  assert.equal((await w.done()).outcome, 'failed before swap');
  assert.deepEqual(w.unit.calls, ['stop', 'start']);
});

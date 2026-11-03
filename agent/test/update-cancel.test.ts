// Game updates, on the Host `fake-world.ts` builds: `updateCancel` during a download and while waiting for the stop
// cleaning both `.incoming` folders and `mods.next`, refused after the swap, and one after `updateResume` (or while
// the hub's stop still runs, as after a hub restart) never stopping the unit and starting the one stopped for it once
// stopped, a server stopped before the update left stopped (also when it fails after `updateResume`, before the swap:
// `failed in staging`, never started); the stop step only ever `waiting`; `updateResume` and `updateCancel` through
// `HubClient` with request ids of their own (with none running: `ok: false`).
import assert from 'node:assert/strict';
import { readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { HubClient } from '../src/hub.ts';
import { eventually, fakeHub } from './fake-hub.ts';
import { modUrl, zip, world, exists, until } from './fake-world.ts';

test('updateCancel before the swap cleans .incoming; after it, it is refused', async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  // flib's download sends a little, then hangs until the agent gives up on it.
  w.routes.set(modUrl('flib', '0.16.2'), async (_url, signal) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(1000));
        signal.addEventListener('abort', () => c.error(signal.reason));
      },
    });
    return new Response(body);
  });
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']]));
  await until(async () => (await readdir(join(w.data, '.incoming'))).includes('flib_0.16.2.zip'), 3000, 'the download under way');
  assert.ok(await exists(join(w.data, 'mods.next/orrery_0.2.0.zip')), 'orrery staged');
  await w.u.cancel();
  const done = await w.done();
  assert.deepEqual(done, { type: 'updateDone', id: 'u1', outcome: 'cancelled', from: '2.1.24 · 3 mods', to: '2.1.25 · 4 mods' });
  assert.equal((await w.step('prepare', 'failed')).detail, 'Cancelled by the hub');
  assert.deepEqual(await readdir(join(w.data, '.incoming')), [], "the data folder's .incoming is clean");
  assert.deepEqual(await readdir(join(w.install, '.incoming')), [], "the install folder's .incoming is clean");
  assert.equal(await exists(join(w.data, 'mods.next')), false);
  assert.deepEqual((await readdir(join(w.data, 'mods'))).sort(), ['mod-list.json', 'mod-settings.dat', 'orrery_0.1.0.zip'], 'mods untouched');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  assert.deepEqual(w.unit.calls, []);

  // Cancelled while it waits for the hub's stop: the same; then once swapped, too late.
  w.sent.length = 0;
  w.routes.set(modUrl('flib', '0.16.2'), async () => new Response(new Uint8Array(zip('flib', '0.16.2'))));
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']], 'u2'));
  await w.step('stop', 'waiting');
  await w.u.cancel();
  assert.equal((await w.done()).outcome, 'cancelled');
  assert.equal(await exists(join(w.data, 'mods.next')), false);
  assert.deepEqual(w.unit.calls, []);
  assert.ok(!w.steps().some((m) => m.step === 'stop' && m.state !== 'waiting'), "the stop is the hub's: its end is not a step");

  // Cancelled after updateResume, while the agent checks the stop (the hub giving up): it never stops the unit, and
  // starts the one the hub stopped (which the hub starts too: a second start does nothing).
  w.sent.length = 0;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']], 'u2b'));
  await w.step('stop', 'waiting');
  w.unit.state = { ...w.unit.state, active: 'deactivating', sub: 'stop-sigterm' };
  await w.u.resume();
  await w.step('swap', 'running');
  await w.u.cancel();
  w.unit.state = { ...w.unit.state, active: 'inactive', sub: 'dead' };
  assert.equal((await w.done()).outcome, 'cancelled');
  assert.deepEqual(w.unit.calls, ['start'], 'a cancel never stops the unit; the one stopped for it is started');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');

  w.sent.length = 0;
  w.broken.add('2.1.25');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']], 'u3'));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  await w.u.resume();
  await w.step('gate', 'running');
  await assert.rejects(w.u.cancel(), /past the swap: too late to cancel/);
  assert.equal((await w.done()).outcome, 'rolled back');
});

test('an update of a server stopped before it that fails after updateResume, before the swap, leaves it stopped', async (t) => {
  const w = await world(t);
  t.mock.method(console, 'error', () => {});
  await w.unit.act('stop');
  w.unit.calls.length = 0;
  t.mock.method(w.saves, 'keep', async () => {
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await w.u.resume(); // the hub stopped nothing: the server was stopped already
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.deepEqual(w.unit.calls, [], 'the owner stopped it: it stays stopped');
  assert.equal(w.unit.state.active, 'inactive');
  await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'update.json removed once reported');

});

test('a hub that restarts during its own stop: the cancel it sends then starts the server the update stopped', async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  // The hub stops the server, then restarts while Factorio saves: the new hub sends updateCancel, not updateResume.
  w.unit.state = { ...w.unit.state, active: 'deactivating', sub: 'stop-sigterm' };
  await w.u.cancel();
  await sleep(50);
  assert.deepEqual(w.unit.calls, [], 'not while it still stops');
  w.unit.state = { ...w.unit.state, active: 'inactive', sub: 'dead' };
  assert.equal((await w.done()).outcome, 'cancelled');
  assert.deepEqual(w.unit.calls, ['start'], 'started once stopped');
  assert.equal(w.unit.state.active, 'active');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');

  // A server that was stopped before the update stays stopped.
  await w.unit.act('stop');
  w.unit.calls.length = 0;
  w.sent.length = 0;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']], 'u2'));
  await w.step('stop', 'waiting');
  await w.u.cancel();
  assert.equal((await w.done()).outcome, 'cancelled');
  assert.deepEqual(w.unit.calls, []);
});

test("the hub's updateResume and updateCancel carry request ids of their own: each acts on the one update running", async (t) => {
  const w = await world(t);
  const hub = await fakeHub();
  t.after(() => hub.close());
  // The handlers as src/index.ts has them.
  const client = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: {} as never, token: 't'.repeat(32), root: w.dir, state: w.state },
    version: 'agent-v0.0.0',
    handlers: { update: (req) => w.u.update(req), updateResume: () => w.u.resume(), updateCancel: () => w.u.cancel() },
    backoffMs: 10,
  });
  t.after(() => client.stop());
  client.start();
  const conn = (await eventually(() => hub.of('agentHello')[0]))!;
  await eventually(() => client.connected);
  const reply = (id: string) => eventually(() => conn.lines.find((l) => l.type === 'reply' && l.id === id), 3000, `the reply to ${id}`);

  conn.send({ type: 'updateResume', id: 'r1' });
  conn.send({ type: 'updateCancel', id: 'r2' });
  assert.deepEqual(await reply('r1'), { type: 'reply', id: 'r1', ok: false, error: 'no update is running' });
  assert.deepEqual(await reply('r2'), { type: 'reply', id: 'r2', ok: false, error: 'no update is running' });

  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  conn.send(w.request('2.1.25', [['orrery', '0.2.0']], 'U1'));
  assert.equal((await reply('U1')).ok, true);
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  conn.send({ type: 'updateResume', id: 'r3' }); // a fresh id, not U1
  assert.deepEqual(await reply('r3'), { type: 'reply', id: 'r3', ok: true });
  assert.deepEqual([(await w.done()).id, (await w.done()).outcome], ['U1', 'ok']);

  w.sent.length = 0;
  conn.send(w.request('2.1.25', [['orrery', '0.2.0']], 'U2'));
  await w.step('stop', 'waiting');
  conn.send({ type: 'updateCancel', id: 'r4' });
  assert.deepEqual(await reply('r4'), { type: 'reply', id: 'r4', ok: true });
  assert.deepEqual([(await w.done()).id, (await w.done()).outcome], ['U2', 'cancelled']);
  assert.deepEqual(conn.invalid, []);
});

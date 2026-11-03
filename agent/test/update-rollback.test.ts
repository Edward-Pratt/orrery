// Game updates, on the Host `fake-world.ts` builds: a gate failure rolled back to the old release, mods.prev with its
// mod-settings.dat and the world as the stop saved it copied as the newest (the swap's copy, not the older pre-update
// save); on a stopped server, the world as it was before the swap, not as the new release wrote it at the rollback's
// stop; a copy for the rollback that fails (`keep`, a full disk) ending the update `failed before swap` with nothing
// moved and the pre-update save held until the end; a rollback whose `update.json` writes fail still rolled back and
// started, and a swap whose own write fails ending `failed before swap` with nothing moved; one that fails before
// flipping back keeping the release it came from; a rollback with the hub unreachable `rolled back` (the forward gate
// still needing the game connection), and a recovery one after a restart.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAgentLine } from '../../hub/src/protocol.ts';
import { eventually } from './fake-hub.ts';
import { world, exists, until } from './fake-world.ts';

test('a gate failure rolls back to the old release, mods.prev with its mod-settings.dat, and the world as the stop saved it', async (t) => {
  const w = await world(t, { gateMs: 300 });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.broken.add('2.1.25');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  // Factorio saves into the world it loaded as it stops: newer than the pre-update save.
  await writeFile(join(w.data, 'saves/world.zip'), 'the world, saved at the stop');
  await w.u.resume();
  const done = await w.done();
  assert.equal(done.outcome, 'rolled back');
  assert.match((await w.step('gate', 'failed')).detail, /^Not up within \d+ s: no \/orrery-status answer$/);
  assert.match((await w.step('rollback', 'done')).detail, /^Back on Factorio 2\.1\.24 with its mods, orrery-pre-update-2\.1\.24-\S+\.zip copied as the newest save$/);
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24', 'the old release');
  assert.deepEqual((await readdir(join(w.data, 'mods'))).sort(), ['mod-list.json', 'mod-settings.dat', 'orrery_0.1.0.zip'], 'the old mods');
  assert.equal(await readFile(join(w.data, 'mods/mod-settings.dat'), 'utf8'), 'startup settings v1', 'mod-settings.dat survives the rollback');
  assert.equal(await exists(join(w.data, 'mods.prev')), false);
  assert.equal(await exists(join(w.data, 'mods.next')), false);
  // The swap's copy of the world as the stop saved it (not the pre-update save, older by the countdown's play),
  // copied as the newest: --start-server-load-latest loads it.
  const saves = await w.saves.list();
  assert.match(done.backup!, /^orrery-pre-update-2\.1\.24-\d{8}T\d{6}Z\.zip$/);
  assert.equal(saves.saves[0]!.name, `restored-${saves.saves[0]!.name.split('-')[1]}-${done.backup}`);
  assert.equal(await readFile(join(w.data, 'saves', saves.saves[0]!.name), 'utf8'), 'the world, saved at the stop');
  assert.equal(await readFile(join(w.data, 'saves', done.backup!), 'utf8'), 'the world, saved at the stop');
  assert.ok(saves.saves[0]!.mtime > (await stat(join(w.data, 'saves/world.zip'))).mtimeMs);
  assert.deepEqual(w.unit.calls, ['stop', 'start', 'stop', 'start']);
  for (const m of w.sent) assert.ok(parseAgentLine(JSON.stringify(m)), `the hub takes ${JSON.stringify(m)}`);
});

test('a rollback on a stopped server restores the world as it was before the swap, not as the new release saved it at the rollback stop', async (t) => {
  const w = await world(t, { gateMs: 300 });
  await w.unit.act('stop');
  w.unit.calls.length = 0;
  // Factorio saves into the world it loaded as it stops (SIGINT): whatever release runs, in its own format.
  const act = w.unit.act;
  w.unit.act = async (verb) => {
    if (verb === 'stop' && w.unit.state.active === 'active') await writeFile(join(w.data, 'saves/world.zip'), `save of ${await readlink(join(w.install, 'current'))}`);
    return act(verb);
  };
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.broken.add('2.1.25'); // it loads the map, then never passes the gate
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await w.u.resume();
  const done = await w.done();
  assert.equal(done.outcome, 'rolled back');
  assert.equal(await readFile(join(w.data, 'saves/world.zip'), 'utf8'), 'save of releases/2.1.25', 'the new release wrote the world it loaded');
  const newest = (await w.saves.list()).saves[0]!;
  assert.equal(newest.name, `restored-${newest.name.split('-')[1]}-${done.backup}`);
  assert.equal(await readFile(join(w.data, 'saves', newest.name), 'utf8'), 'the world', 'the old release loads the world as it was before the swap');
  assert.equal(await readFile(join(w.data, 'saves', done.backup!), 'utf8'), 'the world');
  assert.deepEqual(w.unit.calls, ['start', 'stop', 'start']);
});

test("a copy for the rollback that fails (a full disk) ends the update before the swap: nothing moved, the pre-update save held and named", async (t) => {
  const w = await world(t);
  const error = t.mock.method(console, 'error', () => {});
  const released: string[] = [];
  const release = w.saves.release.bind(w.saves);
  t.mock.method(w.saves, 'release', (name: string) => {
    released.push(name);
    release(name);
  });
  t.mock.method(w.saves, 'keep', async () => {
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  await writeFile(join(w.data, 'saves/world.zip'), 'the world, saved at the stop');
  await w.u.resume();
  const done = await w.done();
  assert.equal(done.outcome, 'failed before swap');
  assert.equal((await w.step('swap', 'failed')).detail, "Can't keep a copy of world.zip for a rollback, so nothing was changed: ENOSPC: no space left on device, write");
  assert.match(done.backup!, /^orrery-pre-update-2\.1\.24-\d{8}T\d{6}Z\.zip$/, 'the backup step\'s save, still held, is the one named');
  assert.deepEqual(released, [done.backup], 'released once, at the end, not before the copy');
  assert.ok(await exists(join(w.data, 'saves', done.backup!)));
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24', 'never flipped');
  assert.deepEqual((await readdir(join(w.data, 'mods'))).sort(), ['mod-list.json', 'mod-settings.dat', 'orrery_0.1.0.zip'], 'mods untouched');
  assert.equal(await exists(join(w.data, 'mods.next')), false);
  assert.equal(await exists(join(w.data, 'mods.prev')), false);
  assert.equal(await readFile(join(w.data, 'saves/world.zip'), 'utf8'), 'the world, saved at the stop', 'the old release loads its own world');
  assert.deepEqual(w.unit.calls, ['stop', 'start'], 'the old server started again, the new release never');
  assert.equal(w.unit.state.active, 'active');
  assert.ok(!w.steps().some((m) => m.step === 'gate' || m.step === 'rollback'));
  assert.ok(error.mock.calls.some((c) => /u1: Can't keep a copy of world\.zip/.test(String(c.arguments[0]))), 'logged');
  for (const m of w.sent) assert.ok(parseAgentLine(JSON.stringify(m)), `the hub takes ${JSON.stringify(m)}`);
});

test("a swap whose bookkeeping can't be written (a full disk) ends before anything moves and starts the old server", async (t) => {
  const w = await world(t);
  const error = t.mock.method(console, 'error', () => {});
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  w.unit.state = { ...w.unit.state, active: 'deactivating', sub: 'stop-sigterm' };
  await w.u.resume();
  await w.step('swap', 'running'); // the resume is recorded; every write of update.json from here fails
  const tmp = join(w.state, `update.json.${process.pid}.tmp`);
  await mkdir(tmp);
  t.after(() => rm(tmp, { recursive: true, force: true }));
  w.unit.state = { ...w.unit.state, active: 'inactive', sub: 'dead' };
  const done = await w.done();
  // Not recorded as swapping, a flip would leave a restarted agent nothing to roll back from: nothing moves.
  assert.equal(done.outcome, 'failed before swap');
  assert.deepEqual(w.unit.calls, ['start']);
  assert.equal(w.unit.state.active, 'active');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  assert.deepEqual((await readdir(join(w.data, 'mods'))).sort(), ['mod-list.json', 'mod-settings.dat', 'orrery_0.1.0.zip'], 'the old mods');
  assert.equal(await exists(join(w.data, 'mods.next')), false);
  assert.ok(error.mock.calls.some((c) => /can't write .*update\.json/.test(String(c.arguments[0]))), 'logged');
});

test("a rollback whose bookkeeping can't be written (a full disk) still rolls back and starts the old server", async (t) => {
  const w = await world(t, { gateMs: 300 });
  const error = t.mock.method(console, 'error', () => {});
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.broken.add('2.1.25');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  await w.u.resume();
  await w.step('gate', 'running'); // the swap is recorded; every write of update.json from here fails
  const tmp = join(w.state, `update.json.${process.pid}.tmp`);
  await mkdir(tmp);
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const done = await w.done();
  assert.equal(done.outcome, 'rolled back');
  assert.equal(w.unit.calls.at(-1), 'start');
  assert.equal(w.unit.state.active, 'active');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  assert.deepEqual((await readdir(join(w.data, 'mods'))).sort(), ['mod-list.json', 'mod-settings.dat', 'orrery_0.1.0.zip'], 'the old mods');
  assert.ok(error.mock.calls.some((c) => /can't write .*update\.json/.test(String(c.arguments[0]))), 'logged');
});

test('a rollback that fails before flipping back keeps the release the update came from', async (t) => {
  const w = await world(t, { gateMs: 300 });
  // Two newer releases from earlier tries that rolled back: the newest three are 2.1.27, 2.1.26 and 2.1.25.
  for (const v of ['2.1.26', '2.1.27']) await mkdir(join(w.install, 'releases', v, 'data'), { recursive: true });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.broken.add('2.1.25');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  await w.u.resume();
  await w.step('gate', 'running');
  w.unit.act = async (verb) => {
    if (verb === 'stop') throw new Error('Interactive authentication required.');
  };
  const done = await w.done();
  assert.equal(done.outcome, 'failed');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.25');
  assert.deepEqual((await readdir(join(w.install, 'releases'))).sort(), ['2.1.24', '2.1.25', '2.1.26', '2.1.27'], 'the release to go back to is kept');
});

test('with the hub unreachable, a rollback whose old server answers with its version and mods is rolled back, not failed', async (t) => {
  const w = await world(t, { gateMs: 300 });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  // The hub goes away right after its go-ahead: the new server's gate still needs the game connection, the rollback's
  // only while the Agent connection is up.
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  await w.u.resume();
  w.connected = false;
  await until(async () => JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).phase === 'done', 5000, 'u1 done');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  w.connected = true;
  w.u.connected();
  // Rolled back (2.1.25 itself runs: only the game connection was missing), and not failed (the old one ran).
  assert.equal((await w.done()).outcome, 'rolled back');
  await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'update.json removed once reported');

  // The agent restarts mid-swap with no hub to reach: its recovery rollback ends rolled back too.
  w.sent.length = 0;
  w.unit.hang = true;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']], 'u2'));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  await w.u.resume();
  await eventually(() => w.unit.calls.at(-1) === 'start' || null, 3000, 'the swap to start the server');
  w.unit.hang = false;
  w.connected = false;
  await w.restart().start();
  assert.equal(JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).outcome, 'rolled back');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  w.connected = true;
  w.u.connected();
  assert.deepEqual([(await w.done()).id, (await w.done()).outcome], ['u2', 'rolled back']);
});

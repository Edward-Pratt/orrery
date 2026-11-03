// Game updates, on the Host `fake-world.ts` builds: a full update while the server runs (pre-update save, the hub's
// stop, swap, gate; mod-settings.dat as Factorio left it at the stop; mods.prev; the newest 3 releases kept; every
// message the hub's `parseAgentLine` takes); the game's own mods kept on or off as the current `mod-list.json` has
// them (space-age off stays off), one new in the release enabled and expected by the gate, `installed` without the one
// off; an update on a stopped server keeping a copy of the newest save.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAgentLine } from '../../hub/src/protocol.ts';
import { eventually } from './fake-hub.ts';
import { releaseTar } from './fake-release.ts';
import { world, exists, until } from './fake-world.ts';

test('an update while the server runs: a pre-update save, the hub stops it, the swap, the gate; mod-settings.dat survives', async (t) => {
  const w = await world(t);
  for (const v of ['2.1.21', '2.1.22', '2.1.23']) await mkdir(join(w.install, 'releases', v, 'data'), { recursive: true });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  w.mod('Squeak Through', '1.8.2');
  await w.u.start();
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2'], ['Squeak Through', '1.8.2']]));
  await assert.rejects(w.u.update(w.request('2.1.25', [['orrery', '0.2.0']], 'u2')), /the update u1 is running/);
  await assert.rejects(w.u.resume(), /is not waiting for the server to stop/);

  await w.step('stop', 'waiting');
  const prepared = await w.step('prepare', 'done');
  assert.equal(prepared.detail, 'Staged Factorio 2.1.25 and 3 mods, mod-settings.dat carried over');
  const backup = await w.step('backup', 'done');
  assert.match(backup.detail, /^Saved orrery-pre-update-2\.1\.24-\d{8}T\d{6}Z\.zip$/);
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24', 'nothing swapped before the stop');
  assert.ok(await exists(join(w.install, 'releases/2.1.25/bin/x64/factorio')));
  assert.equal(JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).phase, 'stop', 'the bookkeeping is in the agent state folder');
  assert.equal(await exists(join(w.data, 'update.json')), false, 'never under the data folder');

  // The hub's stop, with its countdown, then updateResume. Factorio writes its settings as it stops.
  await w.unit.act('stop');
  await writeFile(join(w.data, 'mods/mod-settings.dat'), 'startup settings v2');
  await w.u.resume();
  const done = await w.done();
  // Counted as the hub counts them: every enabled mod, the game's own (base, space-age) included.
  assert.deepEqual(done, { type: 'updateDone', id: 'u1', outcome: 'ok', from: '2.1.24 · 3 mods', to: '2.1.25 · 5 mods', backup: done.backup });
  assert.match(done.backup!, /^orrery-pre-update-2\.1\.24-\d{8}T\d{6}Z\.zip$/);
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.25');
  assert.deepEqual((await readdir(join(w.data, 'mods'))).sort(), ['Squeak Through_1.8.2.zip', 'flib_0.16.2.zip', 'mod-list.json', 'mod-settings.dat', 'orrery_0.2.0.zip']);
  assert.equal(await readFile(join(w.data, 'mods/mod-settings.dat'), 'utf8'), 'startup settings v2', 'mod-settings.dat survives the swap');
  assert.deepEqual(JSON.parse(await readFile(join(w.data, 'mods/mod-list.json'), 'utf8')).mods.map((m: { name: string }) => m.name), ['base', 'space-age', 'orrery', 'flib', 'Squeak Through']);
  assert.ok(await exists(join(w.data, 'mods.prev/orrery_0.1.0.zip')), 'the old mods kept as mods.prev');
  assert.deepEqual(w.unit.calls, ['stop', 'start'], 'the hub stopped it; the agent started it');
  assert.deepEqual(
    w.steps().filter((m) => m.state !== 'running').map((m) => `${m.step} ${m.state}`),
    ['prepare done', 'backup done', 'stop waiting', 'swap done', 'gate done'],
  );
  assert.deepEqual(new Set(w.steps().filter((m) => m.step === 'stop').map((m) => m.state)), new Set(['waiting']), "the stop is the hub's: its step is only ever waiting");
  assert.ok(w.steps().some((m) => m.step === 'swap' && m.state === 'running' && m.detail === 'Checking that the server is stopped'));
  assert.deepEqual((await readdir(join(w.install, 'releases'))).sort(), ['2.1.23', '2.1.24', '2.1.25'], 'the newest 3 releases kept');
  assert.deepEqual(await readdir(join(w.install, '.incoming')), []);
  assert.deepEqual(await readdir(join(w.data, '.incoming')), []);
  await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'update.json removed once reported');
  for (const m of w.sent) assert.ok(parseAgentLine(JSON.stringify(m)), `the hub takes ${JSON.stringify(m)}`);
  assert.ok(!JSON.stringify(w.sent).includes('SECRET'));
});

test("the game's own mods keep their enabled state from the current mod-list.json; one new in the release is enabled; the gate expects exactly that", async (t) => {
  const w = await world(t);
  // space-age off by hand; a mod the update drops listed too.
  const list = { mods: [{ name: 'base', enabled: true }, { name: 'space-age', enabled: false }, { name: 'orrery', enabled: true }, { name: 'old-mod', enabled: false }] };
  await writeFile(join(w.data, 'mods/mod-list.json'), JSON.stringify(list));
  await eventually(() => w.installed && w.installed.mods.length === 2, 2000, 'installed without space-age');
  // 2.1.25 ships one more of the game's own mods.
  const info = JSON.stringify({ name: 'quality', version: '2.1.25', title: 'quality' });
  w.offer('2.1.25', releaseTar('2.1.25', { extra: [{ name: 'factorio/data/quality/info.json', data: info }] }));
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']]));
  await w.step('stop', 'waiting');
  const staged = JSON.parse(await readFile(join(w.data, 'mods.next/mod-list.json'), 'utf8'));
  assert.deepEqual(staged.mods, [
    { name: 'base', enabled: true },
    { name: 'quality', enabled: true },
    { name: 'space-age', enabled: false },
    { name: 'orrery', enabled: true },
    { name: 'flib', enabled: true },
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).expect, { base: '2.1.25', quality: '2.1.25', orrery: '0.2.0', flib: '0.16.2' });
  await w.unit.act('stop');
  await w.u.resume();
  const done = await w.done();
  assert.equal(done.outcome, 'ok', JSON.stringify(w.steps().at(-1)));
  // As the hub names its row: the game's own mods enabled in the latest installed (base), and the update's.
  assert.deepEqual([done.from, done.to], ['2.1.24 · 2 mods', '2.1.25 · 3 mods']);
  assert.match((await w.step('gate', 'done')).detail, /exactly its 4 mods/);
  await eventually(() => w.installed?.factorio === '2.1.25', 2000, 'installed after the update');
  assert.deepEqual(w.installed!.mods.map((m) => m.name), ['base', 'flib', 'orrery', 'quality'], 'installed reports what runs: no space-age');
});

test('an update on a stopped server keeps a copy of the newest save for a rollback', async (t) => {
  const w = await world(t);
  await w.unit.act('stop');
  w.unit.calls.length = 0;
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  assert.equal((await w.step('backup', 'done')).detail, 'The server is stopped: no save made; the swap keeps a copy of world.zip, the newest, for a rollback');
  await w.step('stop', 'waiting');
  await w.u.resume();
  const done = await w.done();
  assert.equal(done.outcome, 'ok');
  assert.match(done.backup!, /^orrery-pre-update-2\.1\.24-\d{8}T\d{6}Z\.zip$/);
  assert.equal(done.from, '2.1.24 · 3 mods');
  assert.equal(done.to, '2.1.25 · 3 mods');
  assert.deepEqual(w.unit.calls, ['start']);
  assert.deepEqual((await w.saves.list()).saves.map((s) => s.name), ['world.zip', done.backup], 'no save made; the copy older than the world');
});

// restore refused while active (the fake systemctl on `PATH`), for a symlinked or unlisted save, or when the server
// started during the copy (written meanwhile only under its `.partial` name, nothing left behind), copying without
// overwriting and stamped newest (2 s past a file ahead of the clock or one under 2 s behind it, else now); a restore
// of a restored copy (ten chained) named after the original; `keep`'s copy byte for byte, 2 s older, held, the next
// second when taken.

import assert from 'node:assert/strict';
import { readFile, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { KEEP_NAMED, stamp } from '../src/saves.ts';
import { ServiceWatch, systemctl } from '../src/service.ts';
import { fakeSystemctl } from './fake-systemctl.ts';
import { HOUR, T0, file, stopped, world } from './saves-world.ts';

test('restore refuses while the unit is active: a fresh systemctl show, from the fake on PATH', async (t) => {
  const sc = await fakeSystemctl(t);
  const watch = new ServiceWatch('factorio.service', systemctl());
  const w = await world(t, { unit: () => watch.read() });
  await file(w.saves, 'world.zip', T0);
  for (const [active, sub] of [
    ['active', 'running'],
    ['deactivating', 'stop-sigterm'],
    ['activating', 'auto-restart'],
    ['reloading', 'reload'],
  ]) {
    await sc.set({ active: active!, sub: sub!, since: T0, result: 'success' });
    await assert.rejects(w.s.restore('world.zip'), new RegExp(`^Error: the server is ${active}: stop it first$`));
  }
  assert.deepEqual(await readdir(w.saves), ['world.zip'], 'nothing copied');
  await sc.set({ active: 'failed', sub: 'failed', since: T0, result: 'exit-code' });
  await w.s.restore('world.zip');
  assert.equal((await readdir(w.saves)).length, 2, 'stopped (failed counts): copied');
});

test('restore refuses a symlinked save and any name not listed', async (t) => {
  const w = await world(t);
  await file(w.saves, 'world.zip', T0);
  await file(w.dir, 'secret.zip', T0);
  await symlink(join(w.dir, 'secret.zip'), join(w.saves, 'evil.zip'));
  await symlink('/etc/passwd', join(w.saves, 'passwd.zip'));
  for (const name of ['evil.zip', 'passwd.zip', '../secret.zip', 'world.zip/', 'notthere.zip', '']) {
    await assert.rejects(w.s.restore(name), /is not a listed save/, JSON.stringify(name));
  }
  assert.deepEqual((await readdir(w.saves)).sort(), ['evil.zip', 'passwd.zip', 'world.zip']);
});

test('restore copies a listed save to restored-<time>-<name>, never over a file, stamped 2 s past every other file', async (t) => {
  let now = T0;
  const w = await world(t, { now: () => now });
  await file(w.saves, 'world.zip', T0 - HOUR, 'the world');
  await file(w.saves, '_autosave1.zip', T0 - 60_000);
  await file(w.saves, 'notes.txt', T0 + 10 * HOUR); // any other file counts, even one stamped in the future
  const copy = `restored-${stamp(T0)}-world.zip`;

  await w.s.restore('world.zip');
  assert.equal(await readFile(join(w.saves, copy), 'utf8'), 'the world');
  assert.equal(await readFile(join(w.saves, 'world.zip'), 'utf8'), 'the world', 'the source untouched');
  assert.equal((await stat(join(w.saves, copy))).mtimeMs, T0 + 10 * HOUR + 2000, 'a file ahead of the clock: 2 s past it');
  assert.equal((await w.s.list()).saves[0]!.name, copy, 'the newest save: the next start loads it');
  assert.equal(w.pushed.at(-1)!.saves[0]!.name, copy, 'and the hub hears of it');

  // The same name again (the same second): refused, and the copy there is kept as it was.
  await file(w.saves, copy, T0 - HOUR, 'already here');
  await assert.rejects(w.s.restore('world.zip'), /exists already: nothing was overwritten/);
  assert.equal(await readFile(join(w.saves, copy), 'utf8'), 'already here');
  assert.equal((await stat(join(w.saves, copy))).mtimeMs, T0 - HOUR, 'not even its time touched');

  // Newer than everything also when the clock is ahead of every file: stamped now.
  now = T0 + 20 * HOUR;
  await w.s.restore('world.zip');
  assert.equal((await stat(join(w.saves, `restored-${stamp(now)}-world.zip`))).mtimeMs, now);

  // The newest file less than 2 s before the clock: still 2 s past it, not now.
  now = T0 + 30 * HOUR;
  await file(w.saves, '_autosave2.zip', now - 1000);
  await w.s.restore('world.zip');
  assert.equal((await stat(join(w.saves, `restored-${stamp(now)}-world.zip`))).mtimeMs, now + 1000);
});

test('a restore of a restored copy names the new copy after the original: chained restores never outgrow a file name', async (t) => {
  let now = T0;
  const w = await world(t, { now: () => now });
  await file(w.saves, 'world.zip', T0 - HOUR, 'the world');
  await w.s.restore('world.zip');
  let name = `restored-${stamp(now)}-world.zip`;
  // Ten restores, each of the copy the last one made (a rollback's on a stopped server, or the dashboard's).
  for (let i = 1; i <= 10; i++) {
    now = T0 + i * 1000;
    await w.s.restore(name);
    name = `restored-${stamp(now)}-world.zip`;
    assert.equal(await readFile(join(w.saves, name), 'utf8'), 'the world', `restore ${i}`);
  }
  assert.ok(!(await readdir(w.saves)).some((n) => n.includes('restored-') && n.indexOf('restored-', 1) !== -1), 'no name carries two prefixes');
  // A world file of the owner's that merely starts so keeps the rest of its name.
  await file(w.saves, 'restored-world.zip', T0 - HOUR, 'theirs');
  now = T0 + HOUR;
  await w.s.restore('restored-world.zip');
  assert.equal(await readFile(join(w.saves, `restored-${stamp(now)}-restored-world.zip`), 'utf8'), 'theirs');
});

test("keep copies a save byte for byte as a held orrery-pre-update-<from>-<time>.zip, 2 s older than it: a start still loads the save itself", async (t) => {
  const w = await world(t, { now: () => T0 });
  await file(w.saves, 'world.zip', T0 - 1000, 'the world, saved at the stop');
  await file(w.saves, 'older.zip', T0 - 10 * HOUR, 'older');
  const name = await w.s.keep('world.zip', '2.1.24');
  assert.equal(name, `orrery-pre-update-2.1.24-${stamp(T0)}.zip`);
  assert.equal(await readFile(join(w.saves, name), 'utf8'), 'the world, saved at the stop');
  assert.equal((await stat(join(w.saves, name))).mtimeMs, T0 - 3000, '2 s before the save it copies');
  const listed = (await w.s.list()).saves;
  assert.deepEqual(listed.map((s) => s.name), ['world.zip', name, 'older.zip'], 'the save itself stays the newest');
  assert.equal(listed[1]!.kind, 'named');
  assert.ok(!(await readdir(w.saves)).some((n) => n.endsWith('.partial')), 'no partial file left');

  // The same second again (a pre-update save made just before): the next free second, never over a file.
  const again = await w.s.keep('world.zip', '2.1.24');
  assert.equal(again, `orrery-pre-update-2.1.24-${stamp(T0 + 1000)}.zip`);
  assert.equal(await readFile(join(w.saves, name), 'utf8'), 'the world, saved at the stop');

  // Held from pruning until released: past the 20 named saves kept, it stays.
  for (let i = 0; i < KEEP_NAMED + 2; i++) await file(w.saves, `orrery-${stamp(T0 + (i + 5) * 1000)}.zip`, T0 + (i + 5) * 1000);
  await w.s.prune();
  assert.ok((await readdir(w.saves)).includes(name), 'held');
  w.s.release(name);
  await w.s.prune();
  assert.ok(!(await readdir(w.saves)).includes(name), 'pruned once released');

  await assert.rejects(w.s.keep('nothing.zip', '2.1.24'), /nothing\.zip is not a listed save/);
  await assert.rejects(w.s.keep('world.zip', '../x'), /is not a version/);
});

test('restore writes the copy under a name that is no save, and refuses if the server started meanwhile: nothing left behind', async (t) => {
  let reads = 0;
  let during: string[] = [];
  let listed: string[] = [];
  const w = await world(t, {
    now: () => T0, // the copy's name
    unit: async () => {
      if (++reads === 1) return stopped;
      // The second read, the copy whole but not yet given its name: no save of it is there for a start to load.
      during = await readdir(w.saves);
      listed = (await w.s.list()).saves.map((s) => s.name);
      return { ...stopped, active: 'active', sub: 'running' }; // someone pressed Start during the copy
    },
  });
  await file(w.saves, 'world.zip', T0 - HOUR, 'the world');
  await assert.rejects(w.s.restore('world.zip'), /^Error: the server started during the restore \(it is active\): nothing was restored$/);
  assert.equal(reads, 2, 'the unit read again before the copy got its name');
  assert.deepEqual(during.sort(), [`.restored-${stamp(T0)}-world.zip.partial`, 'world.zip']);
  assert.deepEqual(listed, ['world.zip'], 'the partial copy is not listed');
  assert.deepEqual(await readdir(w.saves), ['world.zip'], 'no copy and no partial file left');
});

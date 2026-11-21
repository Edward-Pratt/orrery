// `saves` pushed on change only; a pre-update save named with its version's dots (`/orrery-save` given the `.zip`; the
// fakes write a save where Factorio does, `fake-rcon.ts`'s `savedAs`); the 6 h save only after play (a fake clock); a
// save that never appears (or keeps growing) fails after the bounded wait; one save at a time, an RCON timeout still
// waiting for the file, one never sent failing at once. The listing, pruning and the sweep at `start` are
// `saves-folder.test.ts`'s; a restore and `keep` `saves-copy.test.ts`'s; uploads `save-upload.test.ts`'s.

import assert from 'node:assert/strict';
import { appendFile, lstat, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { RconNoAnswer, RconTimeout } from '../src/rcon.ts';
import { SAVE_EVERY_MS, Saves, stamp } from '../src/saves.ts';
import { eventually } from './fake-hub.ts';
import { savedAs } from './fake-rcon.ts';
import { HOUR, T0, file, stopped, world } from './saves-world.ts';

test('saves are pushed on the first listing and on each change only', async (t) => {
  const w = await world(t, { intervalMs: 10 });
  t.after(() => w.s.stop());
  await file(w.saves, 'world.zip', T0);
  w.s.start();
  await eventually(() => w.pushed.length === 1, 2000, 'the first list');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(w.pushed.length, 1, 'nothing changed: nothing pushed');
  await file(w.saves, '_autosave1.zip', T0 + 1000);
  await eventually(() => w.pushed.length === 2, 2000, 'the change');
  assert.deepEqual(
    w.pushed[1]!.saves.map((s) => s.name),
    ['_autosave1.zip', 'world.zip'],
  );
});

test('the 6 h save only after play: due 6 h after the last named save, and only if anyone played since', async (t) => {
  let now = T0;
  const w = await world(t, { now: () => now });
  await w.s.refresh(); // no named save yet: the count starts at the agent's start
  now = T0 + HOUR;
  w.s.played(true); // someone plays, but 6 h haven't passed
  now = T0 + SAVE_EVERY_MS - 1;
  w.s.played(false);
  assert.deepEqual(w.commands, []);
  now = T0 + SAVE_EVERY_MS;
  w.s.played(false); // nobody on now, but someone played since the start
  assert.deepEqual(w.commands, [`/orrery-save orrery-${stamp(now)}.zip`]);
  await eventually(() => w.backups.length === 1, 2000, 'the save written');
  assert.equal(w.backups[0]!.ok, true);

  now = T0 + 2 * SAVE_EVERY_MS + 1;
  for (let i = 0; i < 3; i++) w.s.played(false);
  assert.equal(w.commands.length, 1, 'nobody played since the last: no save');
  now += 1;
  w.s.played(true);
  assert.equal(w.commands.length, 2, 'play again: the save that was due');
  await eventually(() => w.backups.length === 2, 2000);

  // An agent started later takes the count from the newest named save there.
  let later = now + HOUR;
  const fresh = await world(t, { now: () => later });
  await file(fresh.saves, `orrery-${stamp(later - HOUR)}.zip`, later - HOUR);
  await fresh.s.refresh();
  fresh.s.played(true);
  later += SAVE_EVERY_MS - HOUR - 1;
  fresh.s.played(true);
  assert.deepEqual(fresh.commands, [], 'not 6 h since that save');
  later += 1;
  fresh.s.played(true);
  assert.equal(fresh.commands.length, 1);
  await eventually(() => fresh.backups.length === 1, 2000);
});

test("a pre-update save keeps its version's dots: the command names the .zip, as Factorio makes a name's last . part its extension", async (t) => {
  const w = await world(t);
  const name = await w.s.preUpdate('2.1.24');
  assert.match(name, /^orrery-pre-update-2\.1\.24-\d{8}T\d{6}Z\.zip$/);
  assert.deepEqual(w.commands, [`/orrery-save ${name}`]);
  assert.ok((await readdir(w.saves)).includes(name), 'written under that name');
  assert.ok(!(await readdir(w.saves)).includes('orrery-pre-update-2.1.zip'), 'not as Factorio cuts a name without .zip');
});

test('a save that never appears times out after the bounded wait; one that keeps changing too', async (t) => {
  const w = await world(t, { waitMs: 300 });
  w.write = async () => {}; // the mod says ok, but no file comes
  const started = performance.now();
  await w.s.save();
  const took = performance.now() - started;
  assert.equal(w.backups.length, 1);
  assert.equal(w.backups[0]!.ok, false);
  assert.match(w.backups[0]!.detail, /^orrery-\d{8}T\d{6}Z\.zip: did not appear within 0\.3 s$/);
  assert.ok(took >= 300 && took < 2000, `${took} ms`);

  let timer: NodeJS.Timeout | undefined;
  t.after(() => clearInterval(timer));
  w.write = async (name) => {
    timer = setInterval(() => void appendFile(join(w.saves, savedAs(name)), 'x'), 10);
  };
  await w.s.save();
  clearInterval(timer);
  assert.match(w.backups[1]!.detail, /still being written after 0\.3 s$/);
});

test('a save is answered once its file held for the stable time; one at a time; an RCON timeout still waits for the file, unless never sent', async (t) => {
  const w = await world(t, { stableMs: 100 });
  w.write = async (name) => {
    setTimeout(() => void writeFile(join(w.saves, savedAs(name)), 'x'.repeat(2_500_000)), 30);
  };
  const started = performance.now();
  await Promise.all([w.s.save(), w.s.save()]);
  assert.ok(performance.now() - started >= 130, 'written, then held for 100 ms');
  assert.equal(w.commands.length, 1, 'one save for both');
  assert.equal(w.backups.length, 1, 'and one backup');
  assert.match(w.backups[0]!.detail, /^Saved orrery-\d{8}T\d{6}Z\.zip \(2\.5 MB\)$/);
  assert.equal(w.backups[0]!.ok, true);
  assert.ok(w.pushed.at(-1)!.saves.some((s) => s.kind === 'named'), 'the list pushed with it');

  // A big map's save outlasts RCON's answer: the command was sent, so the file decides.
  const slow = await world(t);
  slow.s = new Saves({
    dir: slow.saves,
    log: join(slow.data, 'factorio-current.log'),
    run: async (command) => {
      await writeFile(join(slow.saves, savedAs(command.slice('/orrery-save '.length))), 'map');
      throw new RconNoAnswer('RCON command timed out after 4000 ms');
    },
    unit: async () => stopped,
    pollMs: 10,
    stableMs: 50,
  });
  slow.s.on('backup', (b) => slow.backups.push(b));
  await slow.s.save();
  assert.equal(slow.backups[0]!.ok, true, slow.backups[0]!.detail);

  // No auth answer: the command was never sent, so no file can come. It fails at once, not after the wait.
  const unsent = await world(t, { waitMs: 300, run: async () => Promise.reject(new RconTimeout('RCON did not answer within 4000 ms')) });
  await unsent.s.save();
  assert.match(unsent.backups[0]!.detail, /^orrery-\d{8}T\d{6}Z\.zip: RCON did not answer within 4000 ms$/);

  // The mod refusing it (or RCON gone) fails at once.
  const refused = await world(t, { run: async () => '{"ok":false,"error":"bad name"}' });
  await refused.s.save();
  assert.match(refused.backups[0]!.detail, /\/orrery-save answered "\{\\"ok\\":false,\\"error\\":\\"bad name\\"\}"$/);
  assert.equal((await lstat(refused.saves)).isDirectory(), true);
});

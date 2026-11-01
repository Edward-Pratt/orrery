import assert from 'node:assert/strict';
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseAgentLine } from '../../hub/src/protocol.ts';
import { RconNoAnswer, RconTimeout } from '../src/rcon.ts';
import { KEEP_NAMED, KEEP_WORLD, SAVE_EVERY_MS, Saves, kindOf, loadedMap, stamp, type BackupResult, type SavesMsg, type SavesOptions } from '../src/saves.ts';
import { ServiceWatch, systemctl, type UnitState } from '../src/service.ts';
import { eventually } from './fake-hub.ts';
import { fakeSystemctl } from './fake-systemctl.ts';

/** Now, in whole seconds (as save names carry it): every time in these tests is relative to it, never a fixed date. */
const T0 = Math.floor(Date.now() / 1000) * 1000;
const HOUR = 3600_000;
const stopped: UnitState = { unit: 'factorio.service', active: 'inactive', sub: 'dead', since: T0, result: 'success' };

/**
 * A server data folder with `saves/`, and `Saves` on it with fast waits. `run` answers `/orrery-save` like the mod
 * and, like Factorio, writes the save (`write`, which a test may replace); `commands` records every command.
 */
async function world(t: TestContext, o: Partial<SavesOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-saves-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, 'factorio');
  const saves = join(data, 'saves');
  await mkdir(saves, { recursive: true });
  const commands: string[] = [];
  const w = {
    dir,
    data,
    saves,
    commands,
    write: (name: string) => writeFile(join(saves, `${name}.zip`), 'map'),
    s: null as unknown as Saves,
    backups: [] as BackupResult[],
    pushed: [] as SavesMsg[],
  };
  w.s = new Saves({
    dir: saves,
    log: join(data, 'factorio-current.log'),
    run: async (command) => {
      commands.push(command);
      const name = command.slice('/orrery-save '.length);
      await w.write(name);
      return JSON.stringify({ ok: true, name });
    },
    unit: async () => stopped,
    pollMs: 10,
    stableMs: 50,
    waitMs: 1000,
    ...o,
  });
  w.s.on('backup', (b) => w.backups.push(b));
  w.s.on('saves', (m) => w.pushed.push(m));
  return w;
}

/** A file in `dir` with this content and modified time. */
async function file(dir: string, name: string, at: number, content = name): Promise<void> {
  await writeFile(join(dir, name), content);
  await utimes(join(dir, name), at / 1000, at / 1000);
}

test('save names and kinds, and the map Factorio loaded from its own log line', () => {
  assert.equal(stamp(Date.UTC(2026, 9, 31, 12, 0, 5, 999)), '20261031T120005Z', 'UTC, whole seconds');
  assert.equal(kindOf(`orrery-${stamp(T0)}.zip`), 'named');
  assert.equal(kindOf(`orrery-pre-update-2.1.24-${stamp(T0)}.zip`), 'named');
  assert.equal(kindOf('_autosave3.zip'), 'auto');
  for (const name of ['world.zip', `restored-${stamp(T0)}-world.zip`, 'orrery-x.zip', `orrery-${stamp(T0)}.zip.zip`]) assert.equal(kindOf(name), 'world', name);

  assert.equal(loadedMap('   0.912 Loading map /srv/factorio/saves/world.zip: 637539 bytes.\n   0.931 Loading level.dat: 1 bytes.\n'), '/srv/factorio/saves/world.zip');
  assert.equal(loadedMap('   0.912 Info Loader.cpp:12: Loading map /srv/factorio/saves/a.zip: 1 bytes.\r\n'), '/srv/factorio/saves/a.zip', 'an engine prefix');
  assert.equal(
    loadedMap('   0.9 Loading map /srv/factorio/saves/a.zip: 1 bytes.\n  12.5 Loading map /srv/factorio/saves/b.zip: 2 bytes.\n'),
    '/srv/factorio/saves/b.zip',
    'the last one',
  );
  assert.equal(loadedMap('  12.3 Script @__orrery__/control.lua:9: Loading map /srv/factorio/saves/x.zip: 1 bytes.\n'), null, "a mod's log() line");
  assert.equal(loadedMap('2026-10-31 12:00:00 [CHAT] Bob: Loading map /srv/factorio/saves/x.zip: 1 bytes.\n'), null, 'a chat line');
  assert.equal(loadedMap('   0.912 Loading map /srv/factorio/saves/world.zip: 637539 bytes.'), null, 'only whole lines');
});

test('every *.zip is listed with its kind, newest first, the current world marked from the log; symlinks and the rest left out', async (t) => {
  const w = await world(t);
  await file(w.saves, 'world.zip', T0 - 5 * HOUR);
  await file(w.saves, '_autosave1.zip', T0 - 2 * HOUR);
  await file(w.saves, `orrery-${stamp(T0 - HOUR)}.zip`, T0 - HOUR);
  await file(w.saves, `restored-${stamp(T0)}-world.zip`, T0);
  await file(w.saves, 'notes.txt', T0);
  await mkdir(join(w.saves, 'folder.zip'));
  await file(w.dir, 'secret.zip', T0 + HOUR);
  await symlink(join(w.dir, 'secret.zip'), join(w.saves, 'evil.zip'));
  await writeFile(join(w.data, 'factorio-current.log'), `   0.912 Loading map ${w.saves}/world.zip: 637539 bytes.\n`);

  const msg = await w.s.list();
  assert.deepEqual(
    msg.saves.map((s) => [s.name, s.kind, s.current]),
    [
      [`restored-${stamp(T0)}-world.zip`, 'world', false],
      [`orrery-${stamp(T0 - HOUR)}.zip`, 'named', false],
      ['_autosave1.zip', 'auto', false],
      ['world.zip', 'world', true],
    ],
  );
  assert.equal(msg.saves[3]!.mtime, T0 - 5 * HOUR);
  assert.equal(msg.saves[3]!.size, 'world.zip'.length);
  assert.ok(msg.free > 0);
  assert.ok(parseAgentLine(JSON.stringify({ type: 'saves', ...msg })), 'a saves message the hub takes');

  // A log that names a file elsewhere marks nothing.
  await writeFile(join(w.data, 'factorio-current.log'), `   0.912 Loading map ${w.dir}/world.zip: 1 bytes.\n`);
  assert.ok((await w.s.list()).saves.every((s) => !s.current));

  // The container swaps the saves folder for a symlink to another one: nothing is listed from there.
  await rename(w.saves, join(w.dir, 'elsewhere'));
  await symlink(join(w.dir, 'elsewhere'), w.saves);
  await assert.rejects(w.s.list());
});

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
  assert.deepEqual(w.commands, [`/orrery-save orrery-${stamp(now)}`]);
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

test('pruning keeps the newest 20 named saves and 3 world files, never the current world or a save a running update needs', async (t) => {
  const w = await world(t);
  const named = Array.from({ length: 25 }, (_, i) => (i % 5 === 0 ? `orrery-pre-update-2.1.${i}-${stamp(T0 + i * HOUR)}.zip` : `orrery-${stamp(T0 + i * HOUR)}.zip`));
  for (const [i, name] of named.entries()) await file(w.saves, name, T0 + i * HOUR);
  const worlds = Array.from({ length: 6 }, (_, i) => `world-${i}.zip`);
  for (const [i, name] of worlds.entries()) await file(w.saves, name, T0 + i * 60_000);
  for (let i = 1; i <= 4; i++) await file(w.saves, `_autosave${i}.zip`, T0 - i * HOUR);
  await writeFile(join(w.data, 'factorio-current.log'), `   1.000 Loading map ${w.saves}/world-0.zip: 10 bytes.\n`);
  w.s.hold(named[0]!); // the oldest: the pre-update save of an update still running
  w.s.hold(named[1]!);
  w.s.release(named[1]!);

  await w.s.prune();
  const left = new Set(await readdir(w.saves));
  assert.deepEqual(
    named.filter((n) => left.has(n)),
    [named[0], ...named.slice(25 - KEEP_NAMED)],
    'the newest 20 named, pre-update ones included, and the held one',
  );
  assert.deepEqual(
    worlds.filter((n) => left.has(n)),
    ['world-0.zip', ...worlds.slice(6 - KEEP_WORLD)],
    'the newest 3 world files, and the current one',
  );
  for (let i = 1; i <= 4; i++) assert.ok(left.has(`_autosave${i}.zip`), 'autosaves are Factorio’s');
});

test('a name with a control character is no save: never listed, pruned or restored, so it never forges a log line', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const w = await world(t);
  // The container's user makes an old "world" whose name holds a whole timestamped agent.log line.
  const forged = `a\n${new Date(T0).toISOString()} [hub] connected to the hub at 100.101.102.103:25584 as agent-v1.0.0\nb.zip`;
  const escape = 'esc\u001b]0;title\u0007.zip';
  await file(w.saves, forged, T0 - 10 * HOUR);
  await file(w.saves, escape, T0 - 10 * HOUR);
  const worlds = Array.from({ length: KEEP_WORLD + 1 }, (_, i) => `world-${i}.zip`);
  for (const [i, name] of worlds.entries()) await file(w.saves, name, T0 - i * HOUR);
  assert.deepEqual((await w.s.list()).saves.map((s) => s.name), worlds);

  await w.s.prune();
  const left = await readdir(w.saves);
  assert.ok(left.includes(forged) && left.includes(escape), 'not pruned: not a save');
  assert.ok(!left.includes(worlds.at(-1)!), 'the oldest listed world file is');
  assert.deepEqual(log.mock.calls.map((c) => String(c.arguments[0])), [`[saves] pruned ${worlds.at(-1)}`]);
  await assert.rejects(w.s.restore(forged), /is not a listed save/);
  await assert.rejects(w.s.restore(escape), /is not a listed save/);
});

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
    timer = setInterval(() => void appendFile(join(w.saves, `${name}.zip`), 'x'), 10);
  };
  await w.s.save();
  clearInterval(timer);
  assert.match(w.backups[1]!.detail, /still being written after 0\.3 s$/);
});

test('a save is answered once its file held for the stable time; one at a time; an RCON timeout still waits for the file, unless never sent', async (t) => {
  const w = await world(t, { stableMs: 100 });
  w.write = async (name) => {
    setTimeout(() => void writeFile(join(w.saves, `${name}.zip`), 'x'.repeat(2_500_000)), 30);
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
      await writeFile(join(slow.saves, `${command.slice('/orrery-save '.length)}.zip`), 'map');
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

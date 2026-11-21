// names, kinds and `loadedMap` (a mod's `log()` line can't name the map); the list with kinds, newest first, the
// current world, symlinks and folders left out, a swapped `saves/` refused; a name with a control character (a forged
// log line) never listed, pruned or restored; pruning keeps 20 named and 3 world files, the current world and a held
// save; a partial file an exit left (a restore's or `keep`'s) removed at `start` (and no other file, nor a symlink of
// that shape or what it points at).

import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAgentLine } from '../../hub/src/protocol.ts';
import { KEEP_NAMED, KEEP_WORLD, kindOf, loadedMap, stamp } from '../src/saves.ts';
import { eventually } from './fake-hub.ts';
import { HOUR, T0, file, world } from './saves-world.ts';

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

test("start removes a partial copy left by a restore the agent's exit cut short, before the first listing, and nothing else", async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const w = await world(t);
  t.after(() => w.s.stop());
  // The agent exited during a restore (process.exit skips its finally): its partial copy stays, hidden from the list.
  const left = `.restored-${stamp(T0 - HOUR)}-world.zip.partial`;
  const leftKeep = `.orrery-pre-update-2.1.24-${stamp(T0 - HOUR)}.zip.partial`; // a game update's copy (keep)
  const kept = [
    'world.zip',
    `restored-${stamp(T0 - 2 * HOUR)}-world.zip`,
    '.other.partial', // not a restore's
    `.restored-${stamp(T0)}-world.zip`, // no .partial
    `.restored-${stamp(T0)}-\u001b]0;x\u0007.zip.partial`, // not printable: no restore makes it
  ];
  for (const name of kept) await file(w.saves, name, T0 - 3 * HOUR);
  await file(w.saves, left, T0 - HOUR, 'half a world');
  await file(w.saves, leftKeep, T0 - HOUR, 'half a world');
  // The container's link with that shape, to a file outside saves/: neither it nor what it points at is removed.
  await file(w.dir, 'outside.zip', T0);
  const linked = `.restored-${stamp(T0)}-evil.zip.partial`;
  await symlink(join(w.dir, 'outside.zip'), join(w.saves, linked));
  await mkdir(join(w.saves, `.restored-${stamp(T0)}-folder.zip.partial`));

  w.s.start();
  await eventually(() => w.pushed.length === 1, 2000, 'the first list');
  const now = await readdir(w.saves);
  assert.ok(!now.includes(left) && !now.includes(leftKeep), 'the partial copies are removed');
  assert.deepEqual(now.sort(), [...kept, linked, `.restored-${stamp(T0)}-folder.zip.partial`].sort(), 'nothing else is');
  assert.equal(await readFile(join(w.dir, 'outside.zip'), 'utf8'), 'outside.zip');
  assert.deepEqual(
    log.mock.calls.map((c) => String(c.arguments[0])).sort(),
    [`[saves] removed ${left}, left by a copy the agent's exit cut short`, `[saves] removed ${leftKeep}, left by a copy the agent's exit cut short`].sort(),
  );
});

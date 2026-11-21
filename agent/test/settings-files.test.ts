// The game settings' files (`settings-files.ts`) through `GameSettings` on `settings-host.ts`'s temp Host: a symlink
// or a FIFO in a file's place and a config folder swapped for a link never read or written through; the file written
// with exactly the managed keys, mode 600, no partial left, other keys dropped; a planted state file ignored, partial
// files removed at start.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADMINS_FILE, SETTINGS_FILE, parseSettings, renderSettings } from '../src/settings.ts';
import { FIELDS, SETUP, STOPPED, T0, agent, fileOf, host, request, unitState } from './settings-host.ts';

test('a symlink or a FIFO in place of a file, or a config folder swapped for a link, is never read or written through', async (t) => {
  const h = await host(t);
  const elsewhere = join(h.dir, 'elsewhere.json');
  await writeFile(elsewhere, JSON.stringify({ ...SETUP, name: 'Elsewhere' }));
  await rm(join(h.config, SETTINGS_FILE));
  await symlink(elsewhere, join(h.config, SETTINGS_FILE));
  const { s } = agent(h, { unit: STOPPED });
  assert.match((await s.report()).problem ?? '', /missing or not a regular file/);
  // A write replaces the link, never what it points at.
  await s.set(request({ name: 'Ours' }, { game_password: 'Fresh-pass1' }));
  assert.equal(JSON.parse(await readFile(elsewhere, 'utf8')).name, 'Elsewhere');
  assert.ok((await lstat(join(h.config, SETTINGS_FILE))).isFile());
  assert.equal(fileOf(h).name, 'Ours');
  // A FIFO there (or in the adminlist's place) never blocks a read.
  await rm(join(h.config, SETTINGS_FILE));
  await rm(join(h.config, ADMINS_FILE));
  execFileSync('mkfifo', [join(h.config, SETTINGS_FILE), join(h.config, ADMINS_FILE)]);
  const fifo = await s.report();
  assert.match(fifo.problem ?? '', /missing or not a regular file/);
  assert.deepEqual(fifo.admins, []);

  const swapped = await host(t);
  const real = join(swapped.dir, 'real-config');
  await rm(swapped.config, { recursive: true });
  await mkdir(real);
  await writeFile(join(real, SETTINGS_FILE), JSON.stringify(SETUP));
  await symlink(real, swapped.config);
  const other = agent(swapped, { unit: STOPPED });
  assert.match((await other.s.report()).problem ?? '', /the config folder can't be read \((ENOTDIR|ELOOP)\)/);
  await assert.rejects(other.s.set(request({ name: 'Ours' })), /ENOTDIR|ELOOP/);
  assert.equal(JSON.parse(await readFile(join(real, SETTINGS_FILE), 'utf8')).name, 'orrery Factorio', 'nothing written through the link');
});

test("the file written holds exactly orrery's keys: never public nor on the LAN, no credentials, allow_commands a string; mode 600, through a partial file", async (t) => {
  const h = await host(t, { settings: { ...SETUP, tags: ['a'], username: 'u', token: 't', password: 'p', admins: ['x'], visibility: { public: true, lan: true } } });
  const { s } = agent(h, { unit: STOPPED });
  await s.set(request({ allow_commands: 'false', name: 'Our base' }));
  const file = fileOf(h);
  assert.deepEqual(Object.keys(file), [
    '_comment',
    'name',
    'description',
    'max_players',
    'visibility',
    'game_password',
    'require_user_verification',
    'autosave_interval',
    'autosave_slots',
    'afk_autokick_interval',
    'auto_pause',
    'auto_pause_when_players_connect',
    'only_admins_can_pause_the_game',
    'allow_commands',
    'non_blocking_saving',
  ]);
  assert.deepEqual(file.visibility, { public: false, lan: false });
  assert.equal(file.allow_commands, 'false');
  assert.equal(file.non_blocking_saving, false);
  assert.equal(file.game_password, SETUP.game_password, 'left out: the file’s kept');
  assert.equal((await stat(join(h.config, SETTINGS_FILE))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(h.config)).sort(), [ADMINS_FILE, SETTINGS_FILE], 'no partial file left');
  assert.deepEqual((await s.report()).extra, [], 'the extra keys are gone');
  // What it writes, it reads back the same.
  assert.deepEqual(parseSettings(renderSettings({ fields: { ...FIELDS, name: 'Our base', allow_commands: 'false' }, password: 'x' })).model?.fields, { ...FIELDS, name: 'Our base', allow_commands: 'false' });
});

test('the state file is read back shape-checked: a planted or broken one is ignored; partial files an exit left are removed at start', async (t) => {
  const h = await host(t);
  await mkdir(h.state);
  await writeFile(join(h.state, 'settings.json'), JSON.stringify({ lastGood: { fields: { name: 'x' }, password: 'a b' }, startedWith: { since: 'x' }, armedAt: 'soon', failedLive: ['../x', 'name'], rolledBack: 'a\nb' }));
  await writeFile(join(h.config, '.server-settings.json.0123456789ab.partial'), 'half');
  await writeFile(join(h.config, '.server-settings.json.keep'), 'not ours');
  const a = agent(h, { unit: STOPPED });
  await a.s.start();
  const r = a.pushes[0]!;
  assert.deepEqual(r.pending, ['name']);
  assert.equal(r.rolledBack, 'a?b');
  assert.deepEqual((await readdir(h.config)).sort(), ['.server-settings.json.keep', ADMINS_FILE, SETTINGS_FILE]);
  // armedAt was not a number: a failed start now rolls nothing back.
  a.setUnit(unitState('failed', 'failed', T0 + 60_000, 'exit-code'));
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(a.pushes.length, 1);
});

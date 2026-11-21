// The live part of a game settings write (`settings-live.ts`) through `GameSettings` on `settings-host.ts`'s temp
// Host, RCON answering like Factorio 2.1.24: the commands exactly, the password first, one per changed key, then
// `/promote` and `/demote`, restart-only keys pending, the push after the reply; a wrong reply pending and tried again,
// a failing RCON leaving the rest pending, an admin not in the file in time; an "already" reply applied
// (`factorioConfig` given the running server's verification and description), the description sent trimmed; stopped:
// no RCON, the adminlist written.

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADMINS_FILE } from '../src/settings.ts';
import { eventually } from './fake-hub.ts';
import { factorioConfig } from './fake-rcon.ts';
import { ACTIVE, FIELDS, T0, agent, fileOf, host, hubTakes, request, unitState } from './settings-host.ts';

test('live: one /config set per changed key, the password first, then /promote and /demote; restart-only keys pending; the push after the reply', async (t) => {
  const h = await host(t, { admins: ['alice', 'Carol'] });
  const a = agent(h);
  a.setUnit(ACTIVE); // the run the agent came to: it started with setup's file
  await eventually(() => a.pushes.length > 0, 2000, 'the push at the start');
  const answer = await a.s.set(
    request(
      { name: 'Our base', description: 'A "quiet" place', max_players: 8, require_user_verification: false, auto_pause: false, allow_commands: 'false', afk_autokick_interval: 1 },
      { game_password: 'Fam1ly-Pass!', admins: ['carol', 'Bob'] },
    ),
  );
  assert.deepEqual(a.commands, [
    '/config set password Fam1ly-Pass!',
    '/config set require-user-verification false',
    '/config set name Our base',
    '/config set description A "quiet" place',
    '/config set max-players 8',
    '/config set afk-auto-kick 1',
    '/config set allow-commands false',
    '/promote Bob',
    '/demote alice',
  ]);
  assert.deepEqual(answer, {
    applied: ['name', 'description', 'max_players', 'require_user_verification', 'afk_autokick_interval', 'allow_commands', 'game_password', 'admins'],
    pending: ['auto_pause'],
  });
  const pushed = await eventually(() => a.pushes.find((p) => p.settings?.name === 'Our base'), 2000, 'the push after the save');
  assert.deepEqual(pushed, {
    settings: { ...FIELDS, name: 'Our base', description: 'A "quiet" place', max_players: 8, require_user_verification: false, auto_pause: false, allow_commands: 'false', afk_autokick_interval: 1, game_password_set: true },
    admins: ['Carol', 'bob'],
    problem: null,
    pending: ['auto_pause'],
    extra: [],
    rolledBack: null,
  });
  assert.ok(hubTakes(pushed));

  // Nothing changed: no command. Back to the started value: nothing pending.
  a.commands.length = 0;
  assert.deepEqual(await a.s.set(request({ ...pushed.settings, auto_pause: false }, { admins: ['carol', 'Bob'] })), { applied: [], pending: ['auto_pause'] });
  assert.deepEqual(a.commands, []);
  assert.deepEqual(await a.s.set(request({ ...pushed.settings, auto_pause: true }, { admins: ['carol', 'Bob'] })), { applied: [], pending: [] });
  // Removing the password (verification on again first, so it is allowed), and clearing the description: both live.
  await a.s.set(request({ ...pushed.settings, require_user_verification: true, description: '' }, { game_password: null, admins: ['carol', 'Bob'] }));
  assert.deepEqual(a.commands, ['/config set password', '/config set require-user-verification true', '/config set description']);
  assert.equal(fileOf(h).game_password, '');
});

test('live: a wrong reply leaves its key pending (and the next save tries it again); RCON failing leaves every key after it pending; an admin not in the file in time too', async (t) => {
  const h = await host(t);
  let refuse = 'max-players';
  const a = agent(h, {
    reply: (c) => (c.startsWith(`/config set ${refuse}`) ? 'Value is not valid.' : c.startsWith('/promote') ? '' : factorioConfig(c, join(h.config, ADMINS_FILE))),
  });
  a.setUnit(ACTIVE);
  await eventually(() => a.pushes.length > 0);
  assert.deepEqual(await a.s.set(request({ name: 'N1', max_players: 8 }, { admins: ['alice', 'bob'] })), { applied: ['name'], pending: ['max_players', 'admins'] });
  assert.deepEqual((await a.s.report()).pending, ['max_players', 'admins']);
  refuse = 'none';
  a.commands.length = 0;
  // max_players again (no change since), and the admins: bob still missing from the file, so promoted again.
  assert.deepEqual(await a.s.set(request({ name: 'N1', max_players: 8 }, { admins: ['alice', 'bob'] })), { applied: ['max_players'], pending: ['admins'] });
  assert.deepEqual(a.commands, ['/config set max-players 8', '/promote bob']);

  const h2 = await host(t);
  const b = agent(h2, { reply: (c) => (c.includes('name') ? new Error('RCON command timed out after 4000 ms') : factorioConfig(c, join(h2.config, ADMINS_FILE))) });
  b.setUnit(ACTIVE);
  assert.deepEqual(await b.s.set(request({ name: 'N1', description: 'D', max_players: 8 }, { admins: ['bob'] })), { applied: [], pending: ['name', 'description', 'max_players', 'admins'] });
  assert.deepEqual(b.commands, ['/config set name N1'], 'nothing after the first failure');
  assert.equal(fileOf(h2).name, 'N1', 'the file has them all: the next start applies them');
  // A start applies the file: nothing is pending after it.
  b.setUnit(unitState('active', 'running', T0 + 50_000));
  await eventually(async () => (await b.s.report()).pending.length === 0, 2000, 'nothing pending after a start');
});

test('stopped: no RCON at all, the adminlist written (lowercased, as Factorio keeps it), every change pending', async (t) => {
  const h = await host(t, { admins: ['Alice'] });
  const a = agent(h, { unit: unitState('failed', 'failed', T0, 'exit-code') });
  assert.deepEqual(await a.s.set(request({ name: 'Our base', auto_pause: false }, { admins: ['alice', 'Bob'] })), { applied: [], pending: ['name', 'auto_pause', 'admins'] });
  assert.deepEqual(a.commands, []);
  assert.deepEqual(JSON.parse(await readFile(join(h.config, ADMINS_FILE), 'utf8')), ['alice', 'bob']);
  assert.equal((await stat(join(h.config, ADMINS_FILE))).mode & 0o777, 0o600);
  // The same admins in another case: no write.
  const before = await stat(join(h.config, ADMINS_FILE));
  await a.s.set(request({ name: 'Our base' }, { admins: ['ALICE', 'bob'] }));
  assert.equal((await stat(join(h.config, ADMINS_FILE))).ino, before.ino);
});

test('live: an already empty description and verification already as asked are applied; the description goes trimmed, as Factorio takes it', async (t) => {
  const h = await host(t);
  const running = { verification: true, description: '' };
  const a = agent(h, { reply: (c) => factorioConfig(c, join(h.config, ADMINS_FILE), running) });
  a.setUnit(ACTIVE);
  await eventually(() => a.pushes.length > 0);
  // Spaces alone: Factorio clears the description, which it already had empty.
  assert.deepEqual(await a.s.set(request({ description: '   ' }, { admins: ['alice'] })), { applied: ['description'], pending: [] });
  assert.deepEqual(a.commands, ['/config set description']);
  a.commands.length = 0;
  assert.deepEqual(await a.s.set(request({ description: '  Our base  ' }, { admins: ['alice'] })), { applied: ['description'], pending: [] });
  assert.deepEqual(a.commands, ['/config set description Our base']);
  // A write before that couldn't apply verification, which the running server has all the same: applied on "already".
  const h2 = await host(t);
  let fail = true;
  const b = agent(h2, { reply: (c) => (fail && c.includes('require-user-verification') ? new Error('RCON command timed out after 4000 ms') : factorioConfig(c, join(h2.config, ADMINS_FILE), running)) });
  b.setUnit(ACTIVE);
  assert.deepEqual(await b.s.set(request({ require_user_verification: false }, { game_password: 'pass-word', admins: ['alice'] })), { applied: ['game_password'], pending: ['require_user_verification'] });
  running.verification = false; // the command took after all
  fail = false;
  b.commands.length = 0;
  assert.deepEqual(await b.s.set(request({ require_user_verification: false }, { admins: ['alice'] })), { applied: ['require_user_verification'], pending: [] });
  assert.deepEqual(b.commands, ['/config set require-user-verification false']);
});

// The game settings' rules (`settings-rules.ts`) through `GameSettings` on `settings-host.ts`'s temp Host: setup's
// file read with Factorio's defaults, the report taken by the hub's `parseAgentLine`; files failing a rule (not JSON,
// a range, `allow_commands` a boolean, a control character, a key Factorio needs missing) read as no settings, the key
// named and never its value, other keys `extra`; every refusal across fields (verification off with no password, left
// out or null; a file password the rule refuses; an admin twice in two cases; a new name over 50 bytes, an unchanged
// one accepted; a broken character; a busy agent; a unit starting or stopping) writing nothing; a malformed file and a
// fresh write.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { SETTINGS_FILE } from '../src/settings.ts';
import type { Request } from '../src/wire.ts';
import { FIELDS, SETUP, STOPPED, T0, agent, fileOf, host, hubTakes, request, unitState } from './settings-host.ts';

test("setup's file reads with Factorio's defaults for the keys it leaves out; the password only as set; the hub takes the report", async (t) => {
  const h = await host(t, { admins: ['alice', 'Bob', 'bob', 'not a name', 'x'.repeat(61), 7 as unknown as string] });
  const { s } = agent(h);
  const r = await s.report();
  assert.deepEqual(r, {
    settings: { ...FIELDS, game_password_set: true },
    admins: ['alice', 'Bob'],
    problem: null,
    pending: [],
    extra: [],
    rolledBack: null,
  });
  assert.ok(hubTakes(r));
  assert.doesNotMatch(JSON.stringify(r), /Abcdefghij/, 'never the password');
  await writeFile(join(h.config, SETTINGS_FILE), JSON.stringify({ ...SETUP, game_password: '' }));
  assert.equal((await s.report()).settings?.game_password_set, false);
});

test('a file that fails a rule reads as no settings, the key named and never its value; other keys are listed as extra', async (t) => {
  const cases: [object | string, RegExp][] = [
    ['{"name": "x",', /is not valid JSON/],
    ['[1]', /is not a JSON object/],
    [{ ...SETUP, max_players: 1001 }, /^max_players is not valid$/],
    [{ ...SETUP, max_players: '8' }, /^max_players is not valid$/],
    [{ ...SETUP, allow_commands: false }, /^allow_commands is a boolean: Factorio needs the string/],
    [{ ...SETUP, allow_commands: 'maybe' }, /^allow_commands is not valid$/],
    [{ ...SETUP, name: 'Secret\nname' }, /^name is not valid$/],
    [{ ...SETUP, name: undefined }, /^name is missing/],
    [{ ...SETUP, description: undefined }, /^description is missing/],
    [{ ...SETUP, visibility: undefined }, /^visibility is missing/],
    [{ ...SETUP, game_password: 7 }, /^game_password is not a string$/],
  ];
  for (const [file, problem] of cases) {
    const h = await host(t, { settings: file });
    const r = await agent(h).s.report();
    assert.equal(r.settings, null, JSON.stringify(file));
    assert.match(r.problem ?? '', problem);
    assert.doesNotMatch(r.problem ?? '', /Secret|1001|maybe/);
    assert.ok(hubTakes(r));
  }
  const h = await host(t, {
    settings: { ...SETUP, tags: ['a'], max_upload_slots: 5, username: 'u', token: 't', admins: ['x'], 'Bad Key': 1, _comment_tags: 'c' },
  });
  const r = await agent(h).s.report();
  assert.deepEqual(r.extra, ['tags', 'max_upload_slots', 'username', 'token', 'admins']);
  assert.deepEqual(r.settings, { ...FIELDS, game_password_set: true });
  assert.ok(hubTakes(r));
});

test('refused with a reason, writing nothing: no password without the account check, one the file holds that the rule refuses, an admin twice, a long new name, a broken character, a busy Agent, a unit starting or stopping', async (t) => {
  const h = await host(t);
  const before = await readFile(join(h.config, SETTINGS_FILE), 'utf8');
  const refused = async (a: ReturnType<typeof agent>, req: Request<'settingsSet'>, why: RegExp) => {
    await assert.rejects(a.s.set(req), why);
    assert.equal(await readFile(join(h.config, SETTINGS_FILE), 'utf8'), before, String(why));
  };
  const a = agent(h);
  await refused(a, request({ require_user_verification: false }, { game_password: null }), /^Error: Without the account check a game password is needed\.$/);
  await refused(a, request({}, { admins: ['Bob', 'alice', 'bob'] }), /admins: bob is listed twice/);
  await refused(a, request({ name: 'Ü'.repeat(26) }), /Factorio keeps only the first 50 bytes/);
  await refused(a, request({ name: 'a\ud800b' }), /broken character/);
  await refused(agent(h, { ready: async () => Promise.reject(new Error('a game update is running')) }), request({ name: 'X' }), /a game update is running/);
  for (const active of ['activating', 'deactivating']) {
    await refused(agent(h, { unit: unitState(active, 'start', T0) }), request({ name: 'X' }), /starting or stopping: try again in a minute/);
  }
  assert.deepEqual(a.commands, [], 'no RCON');

  // The file has no password: left out, there is none to keep.
  await writeFile(join(h.config, SETTINGS_FILE), JSON.stringify({ ...SETUP, game_password: '' }));
  await assert.rejects(a.s.set(request({ require_user_verification: false })), /a game password is needed/);
  // One set by hand that the rule refuses (a space): it can't be kept, but a new one can be set.
  await writeFile(join(h.config, SETTINGS_FILE), JSON.stringify({ ...SETUP, game_password: 'pass word' }));
  await assert.rejects(a.s.set(request({ name: 'X' })), /The file's game password can't be kept: set a new one\./);
  await a.s.set(request({ name: 'X' }, { game_password: 'pass-word' }));
  assert.equal(fileOf(h).game_password, 'pass-word');

  // A name over 50 bytes that the file already has is no change: it doesn't stop a save of other keys.
  await writeFile(join(h.config, SETTINGS_FILE), JSON.stringify({ ...SETUP, name: 'n'.repeat(60) }));
  await a.s.set(request({ name: 'n'.repeat(60), max_players: 4 }));
  assert.equal(fileOf(h).max_players, 4);
});

test('a malformed file: no settings and why; the next save writes a fresh one from the fields (the password only if given)', async (t) => {
  const h = await host(t, { settings: '{"name": ' });
  const a = agent(h, { unit: STOPPED });
  const r = await a.s.report();
  assert.equal(r.settings, null);
  assert.match(r.problem!, /not valid JSON/);
  await a.s.set(request({ name: 'Fresh' }));
  assert.equal(fileOf(h).name, 'Fresh');
  assert.equal(fileOf(h).game_password, '');
  assert.deepEqual((await a.s.report()).settings, { ...FIELDS, name: 'Fresh', game_password_set: false });
});

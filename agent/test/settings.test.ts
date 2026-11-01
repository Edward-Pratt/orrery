import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseAgentLine } from '../../hub/src/protocol.ts';
import type { GameSettingsFields, GameSettingsReport } from '../../hub/src/types.ts';
import { RconSession } from '../src/rcon.ts';
import type { UnitState } from '../src/service.ts';
import { GOOD_WITHIN_MS as GOOD } from '../src/gate.ts';
import { ADMINS_FILE, GameSettings, SETTINGS_FILE, parseSettings, renderSettings } from '../src/settings.ts';
import { StatusPoller } from '../src/status.ts';
import { readAgentLine, type Request } from '../src/wire.ts';
import { eventually } from './fake-hub.ts';
import { PASSWORD, factorioConfig, fakeRcon } from './fake-rcon.ts';

/** Seconds, as systemd's change times are. */
const T0 = Math.floor(Date.now() / 1000) * 1000 - 60_000;
const unitState = (active: string, sub: string, since: number, result = 'success'): UnitState => ({ unit: 'factorio.service', active, sub, since, result });
const ACTIVE = unitState('active', 'running', T0);
const STOPPED = unitState('inactive', 'dead', T0);

/** server-settings.json as deploy/setup-agent-host.sh writes it. */
const SETUP = {
  _comment: 'Written by orrery deploy/setup-agent-host.sh, and kept on a re-run once edited.',
  name: 'orrery Factorio',
  description: '',
  game_password: 'Abcdefghij0123456789',
  visibility: { public: false, lan: false },
  require_user_verification: true,
  auto_pause: true,
  autosave_interval: 10,
  autosave_slots: 5,
  non_blocking_saving: false,
  allow_commands: 'admins-only',
};
/** SETUP's values, with Factorio's own for the keys it leaves out. */
const FIELDS: GameSettingsFields = {
  name: 'orrery Factorio',
  description: '',
  max_players: 0,
  require_user_verification: true,
  autosave_interval: 10,
  autosave_slots: 5,
  afk_autokick_interval: 0,
  auto_pause: true,
  auto_pause_when_players_connect: false,
  only_admins_can_pause_the_game: true,
  allow_commands: 'admins-only',
};

/** A `settingsSet` as the agent's wire check passes it on (so every value here is one the hub's rules let through). */
function request(settings: Partial<GameSettingsFields> = {}, more: { game_password?: string | null; admins?: string[] } = {}): Request<'settingsSet'> {
  const r = readAgentLine(JSON.stringify({ type: 'settingsSet', id: 's1', settings: { ...FIELDS, ...settings }, admins: [], ...more }));
  assert.ok(r.msg?.type === 'settingsSet', JSON.stringify(r));
  return r.msg;
}

/** A Host's config folder (with setup's files, unless told otherwise), the agent's state folder and Factorio's log. */
async function host(t: TestContext, o: { settings?: object | string | null; admins?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config');
  await mkdir(config);
  const settings = o.settings === undefined ? SETUP : o.settings;
  if (settings !== null) await writeFile(join(config, SETTINGS_FILE), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  await writeFile(join(config, ADMINS_FILE), JSON.stringify(o.admins ?? ['alice']));
  return { dir, config, state: join(dir, 'state'), log: join(dir, 'factorio-current.log') };
}
type Host = Awaited<ReturnType<typeof host>>;

/**
 * A `GameSettings` on `h`: the unit as `unit` says (changed with `setUnit`), RCON answering like Factorio 2.1.24
 * (`factorioConfig`, or `reply`), every command and push kept, a clock that moves only when told.
 */
function agent(h: Host, options: { unit?: UnitState; reply?: (c: string) => string | Error | undefined; ready?: () => Promise<void> } = {}) {
  const o = options;
  let unit = o.unit ?? ACTIVE;
  let now = T0 + 30_000;
  const commands: string[] = [];
  const pushes: GameSettingsReport[] = [];
  const reply = o.reply ?? ((c: string) => factorioConfig(c, join(h.config, ADMINS_FILE)));
  const s = new GameSettings({
    config: h.config,
    state: h.state,
    log: h.log,
    unit: { read: async () => unit },
    run: async (c) => {
      commands.push(c);
      const r = reply(c);
      if (r instanceof Error) throw r;
      if (r === undefined) throw new Error('no such command');
      return r;
    },
    ready: o.ready ?? (async () => {}),
    push: (r) => pushes.push(r),
    now: () => now,
    adminWaitMs: 300,
    pollMs: 10,
  });
  return {
    s,
    commands,
    pushes,
    /** The unit's new state, as `ServiceWatch` would report it. */
    setUnit: (u: UnitState) => {
      unit = u;
      s.service(u);
    },
    at: (ms: number) => (now = T0 + ms),
  };
}

const fileOf = (h: Host) => JSON.parse(readFileSync(join(h.config, SETTINGS_FILE), 'utf8')) as Record<string, unknown>;
const stateOf = (h: Host) => {
  try {
    return JSON.parse(readFileSync(join(h.state, 'settings.json'), 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
};
const hubTakes = (r: GameSettingsReport) => parseAgentLine(JSON.stringify({ type: 'settings', ...r })) !== null;

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

test('the game password reaches only the file, the state file and its one command: no log line, reply, push or error holds it', async (t) => {
  const PW = 'Zq9-unique-PASSWORD-x7';
  const h = await host(t);
  // A real RCON session against a Factorio that never answers the password's command (a blocking save, say).
  const rcon = await fakeRcon((c) => (c.startsWith('/config set password') ? undefined : factorioConfig(c, join(h.config, ADMINS_FILE))));
  const session = new RconSession(rcon.port, PASSWORD, 200);
  t.after(async () => {
    session.close();
    await rcon.close();
  });
  const logged: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, m, (...args: unknown[]) => logged.push(args.map(String).join(' ')));
  const pushes: GameSettingsReport[] = [];
  const s = new GameSettings({
    config: h.config,
    state: h.state,
    log: h.log,
    unit: { read: async () => ACTIVE },
    run: (c) => session.exec(c),
    ready: async () => {},
    push: (r) => pushes.push(r),
  });
  s.service(ACTIVE);
  const answers = [await s.set(request({ require_user_verification: false, name: 'N' }, { game_password: PW }))];
  answers.push(await s.set(request({ require_user_verification: false, name: 'M' })));
  const errors: string[] = [];
  await s.set(request({ require_user_verification: false, name: 'x'.repeat(60) })).catch((e: Error) => errors.push(String(e)));
  await eventually(() => pushes.some((p) => p.settings?.name === 'M'), 2000, 'the push');
  // A good start with it: the state file keeps it as the last good settings.
  s.service(unitState('active', 'running', Math.floor(Date.now() / 1000) * 1000));
  s.rconUp();
  await eventually(() => stateOf(h)?.lastGood?.fields.name === 'M', 2000, 'the last good settings');
  assert.deepEqual(answers[0]!.pending.slice(0, 2), ['name', 'require_user_verification'], 'the password timed out: the rest pending');
  assert.ok(rcon.commands().includes(`/config set password ${PW}`), 'its one command');
  const everything = [...logged, ...pushes.map((p) => JSON.stringify(p)), ...answers.map((a) => JSON.stringify(a)), ...errors].join('\n');
  assert.ok(logged.length > 0 && errors.length === 1);
  assert.ok(!everything.includes(PW), everything);
  const holding = [];
  for (const dir of [h.config, h.state]) for (const f of await readdir(dir)) if ((await readFile(join(dir, f), 'utf8')).includes(PW)) holding.push(f);
  assert.deepEqual(holding.sort(), ['server-settings.json', 'settings.json']);
  assert.equal((await stat(join(h.state, 'settings.json'))).mode & 0o777, 0o600);
});

test('a good start makes what it started with the last good settings; a failed start after a write puts them back and says so, until the next write', async (t) => {
  const h = await host(t);
  await writeFile(h.log, '   0.512 Factorio initialised\n   0.513 Error CommandLineMultiplayer.cpp:360: Hosting multiplayer game failed: Value (-1) outside of range\n   0.552 Goodbye\n');
  const a = agent(h, { unit: STOPPED });
  a.setUnit(STOPPED);
  a.setUnit(unitState('active', 'running', T0 + 10_000));
  a.at(15_000);
  a.s.rconUp();
  await eventually(() => stateOf(h)?.lastGood?.fields.name === 'orrery Factorio', 2000, 'setup’s file as the last good one');
  assert.equal(stateOf(h)!.lastGood.password, SETUP.game_password, 'with its password');

  // A write while it runs; that run crashing later is not the watched start.
  a.at(20_000);
  await a.s.set(request({ name: 'Broken' }));
  a.setUnit(unitState('activating', 'auto-restart', T0 + 25_000, 'exit-code'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fileOf(h).name, 'Broken');
  // The restart reads the new file, and fails before RCON answers: the last good settings go back.
  a.setUnit(unitState('active', 'running', T0 + 36_000));
  a.setUnit(unitState('activating', 'auto-restart', T0 + 37_000, 'exit-code'));
  const rolled = await eventually(() => a.pushes.find((p) => p.rolledBack !== null), 2000, 'the rollback push');
  assert.equal(fileOf(h).name, 'orrery Factorio');
  assert.equal(fileOf(h).game_password, SETUP.game_password);
  assert.match(rolled.rolledBack!, /^\d{4}-\d\d-\d\dT.*Z: Error CommandLineMultiplayer\.cpp:360: Hosting multiplayer game failed: Value \(-1\) outside of range$/);
  assert.equal(rolled.settings?.name, 'orrery Factorio');
  assert.ok(hubTakes(rolled));
  // Kept across an agent restart, and cleared by the next write.
  await a.s.saved;
  const again = agent(h, { unit: STOPPED });
  assert.equal((await again.s.report()).rolledBack, rolled.rolledBack);
  await again.s.set(request({ name: 'Fixed' }));
  assert.equal((await again.s.report()).rolledBack, null);
});

test('a good start after a write makes the new file the last good one; with none ever readable a failed start writes nothing', async (t) => {
  const h = await host(t);
  const a = agent(h, { unit: STOPPED });
  a.setUnit(STOPPED);
  await a.s.set(request({ name: 'Second' }));
  a.setUnit(unitState('active', 'running', T0 + 40_000));
  a.at(41_000);
  a.s.rconUp();
  await eventually(() => stateOf(h)?.lastGood?.fields.name === 'Second' && stateOf(h)?.armedAt === null, 2000, 'Second as the last good one');
  a.setUnit(unitState('inactive', 'dead', T0 + 50_000));
  await a.s.set(request({ name: 'Third' }));
  a.setUnit(unitState('failed', 'failed', T0 + 60_000, 'exit-code'));
  await eventually(() => a.pushes.some((p) => p.rolledBack), 2000, 'the rollback');
  assert.equal(fileOf(h).name, 'Second');

  const bad = await host(t, { settings: '{ not json' });
  const b = agent(bad, { unit: STOPPED });
  b.setUnit(unitState('active', 'running', T0 + 1_000)); // started with an unreadable file
  b.s.rconUp();
  b.setUnit(unitState('inactive', 'dead', T0 + 2_000));
  await b.s.set(request({ name: 'Fresh' }, { game_password: 'new-pass1' }));
  b.setUnit(unitState('failed', 'failed', T0 + 60_000, 'exit-code'));
  const r = await eventually(() => b.pushes.find((p) => p.rolledBack), 2000, 'the failure reported');
  assert.match(r.rolledBack!, /no earlier start had readable settings to put back \(no error line in factorio-current\.log\)/);
  assert.equal(fileOf(bad).name, 'Fresh', 'nothing written');
});

test('an agent come to a server that has run for long (its own deploy): with no last good start, what that run started with becomes it, and a failed start after the next write puts it back', async (t) => {
  const h = await host(t);
  const a = agent(h, { unit: ACTIVE });
  a.setUnit(ACTIVE); // running since T0: the agent's first reading
  a.at(GOOD + 60_000); // RCON answers only now, past 300 s of that change time
  a.s.rconUp();
  await eventually(() => stateOf(h)?.lastGood?.fields.name === 'orrery Factorio', 2000, 'the running file as the last good one');
  // The next write, then a start that fails before RCON answers: the file the server ran with goes back.
  await a.s.set(request({ name: 'Broken' }));
  a.setUnit(unitState('inactive', 'dead', T0 + GOOD + 70_000));
  a.setUnit(unitState('failed', 'failed', T0 + GOOD + 80_000, 'exit-code'));
  await eventually(() => a.pushes.some((p) => p.rolledBack), 2000, 'the rollback');
  assert.equal(fileOf(h).name, 'orrery Factorio');

  // A last good start already kept is not replaced by a late answer.
  const h2 = await host(t);
  const b = agent(h2, { unit: STOPPED });
  b.setUnit(STOPPED);
  b.setUnit(unitState('active', 'running', T0 + 1_000));
  b.at(2_000);
  b.s.rconUp();
  await eventually(() => stateOf(h2)?.lastGood?.fields.name === 'orrery Factorio', 2000, 'a good start');
  await writeFile(join(h2.config, SETTINGS_FILE), JSON.stringify({ ...SETUP, name: 'Hand edited' }));
  b.setUnit(unitState('inactive', 'dead', T0 + 3_000));
  b.setUnit(unitState('active', 'running', T0 + 4_000));
  b.at(4_000 + GOOD + 1);
  b.s.rconUp();
  await b.s.saved;
  await new Promise((r) => setTimeout(r, 30));
  await b.s.saved;
  assert.equal(stateOf(h2)!.lastGood.fields.name, 'orrery Factorio');
});

test('a slow start the gate watched (RCON first answers past 300 s) is no failed start: that run crashing later puts nothing back', async (t) => {
  const h = await host(t);
  const a = agent(h, { unit: STOPPED });
  a.setUnit(STOPPED);
  await a.s.set(request({ name: 'Slow' }));
  a.setUnit(unitState('active', 'running', T0 + 40_000));
  a.at(40_000 + GOOD + 1);
  a.s.rconUp();
  await eventually(() => stateOf(h)?.armedAt === null, 2000, 'disarmed');
  a.setUnit(unitState('activating', 'auto-restart', T0 + 3_600_000, 'exit-code')); // hours later
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fileOf(h).name, 'Slow');
  assert.ok(a.pushes.every((p) => p.rolledBack === null));
});

test('busy while a settingsSet runs or waits: a game update, a restore and a deploy are refused meanwhile', async (t) => {
  const h = await host(t);
  const waiting: (() => void)[] = [];
  const a = agent(h, { ready: () => new Promise<void>((r) => waiting.push(r)) });
  assert.equal(a.s.busy, false);
  const first = a.s.set(request({ name: 'One' }));
  const second = a.s.set(request({ name: 'Two' }));
  assert.equal(a.s.busy, true, 'at once, before any await');
  await eventually(() => waiting.length === 1);
  waiting[0]!();
  await first;
  assert.equal(a.s.busy, true, 'the second still waits');
  await eventually(() => waiting.length === 2);
  waiting[1]!();
  await second;
  assert.equal(a.s.busy, false);
  // A refused one ends it too.
  const refused = a.s.set(request({ require_user_verification: false }, { game_password: null }));
  await eventually(() => waiting.length === 3);
  waiting[2]!();
  await assert.rejects(refused);
  assert.equal(a.s.busy, false);
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

test('auto_pause follows what the running server started with, not the file (StatusPoller reads it so); a start brings the new value', async (t) => {
  const h = await host(t);
  const a = agent(h, { unit: STOPPED });
  assert.equal(a.s.autoPause, null, 'no start seen yet: the file decides');
  a.setUnit(ACTIVE);
  await eventually(() => a.s.autoPause === true);
  await a.s.set(request({ auto_pause: false }));
  assert.equal(a.s.autoPause, true);
  assert.deepEqual((await a.s.report()).pending, ['auto_pause']);
  a.setUnit(unitState('active', 'running', T0 + 50_000));
  await eventually(() => a.s.autoPause === false, 2000, 'the new start');
  assert.deepEqual((await a.s.report()).pending, []);

  // The poller's paused, nobody on: from `autoPause`, though the file says otherwise.
  const rcon = await fakeRcon(() => JSON.stringify({ ok: true, tick: 5, tick_paused: false, players: {}, version: '2.1.24', mods: { base: '2.1.24', orrery: '0.1.0' } }));
  const poller = new StatusPoller({ port: rcon.port, password: PASSWORD, settings: join(h.config, SETTINGS_FILE), autoPause: () => a.s.autoPause, intervalMs: 20 });
  t.after(async () => {
    poller.stop();
    await rcon.close();
  });
  await writeFile(join(h.config, SETTINGS_FILE), JSON.stringify({ ...SETUP, auto_pause: true }));
  const paused: boolean[] = [];
  poller.on('status', (r) => paused.push(r.paused));
  poller.start();
  await eventually(() => paused.length > 0);
  assert.equal(paused[0], false);
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

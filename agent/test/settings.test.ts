// `GameSettings` (`settings.ts`) on `settings-host.ts`'s temp Host, with a unit and a clock the test sets: the
// password (through a real `RconSession` whose command times out) in no log line, reply, push or error, and on disk
// only in the two files; a good start's file kept as last good, a failed start after a write rolled back with
// Factorio's error line (not on the crash of the run the write was made in), kept across a restart and cleared by the
// next write; with no last good, nothing written; a run come to late (past 300 s) giving the last good one only while
// there is none, and a slow watched start disarming the gate (its later crash puts nothing back); `busy` while a set
// runs or waits; `autoPause` from the start, and `StatusPoller` using it. The rules: `settings-rules.test.ts`; the
// files: `settings-files.test.ts`; the live commands: `settings-live.test.ts`. `test/gate.test.ts`: `StartGate`'s
// sequences (starts, good within 300 s only, a run come to late only `late`, armed and failed once, the old run's
// crash, states from before the arming, a kept arming time, a slow watched start `late` and disarmed).

import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GameSettingsReport } from '../../hub/src/types.ts';
import { GOOD_WITHIN_MS as GOOD } from '../src/gate.ts';
import { RconSession } from '../src/rcon.ts';
import { ADMINS_FILE, GameSettings, SETTINGS_FILE } from '../src/settings.ts';
import { StatusPoller } from '../src/status.ts';
import { eventually } from './fake-hub.ts';
import { PASSWORD, factorioConfig, fakeRcon } from './fake-rcon.ts';
import { ACTIVE, SETUP, STOPPED, T0, agent, fileOf, host, hubTakes, request, stateOf, unitState } from './settings-host.ts';

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

// `check` called directly on a temp host as setup leaves it (`host`, in `check-host.ts`), up to the stops. All pass, in
// order, the map back to S1's save only, the three `systemctl` calls exactly, never Lua; a stale password fails after
// one auth; a failed unit fails with RCON untried, and failing while awaited ends the wait; RCON refused or silent
// fails once the wait is up; players on or `auto_pause` off skip the stops; a restart that loaded an older save, a
// stop that saved nothing, `SIGTERM`, a start loading another file, S1 failing (stopped and started anyway), polkit
// refusing; `shutdownOf`, `udpOwner`, `enabledMods`. The checks after the stops are in `check-groups.test.ts`. No
// test's report has a secret.

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { enabledMods, shutdownOf, udpOwner } from '../src/check.ts';
import { AUTH } from '../src/rcon.ts';
import { UNIT, clean, host } from './check-host.ts';

test('check: on a host as setup leaves it every check the agent can make passes, in order; the stops roll the map back to S1 only; nothing secret is printed', async (t) => {
  const h = await host(t);
  assert.equal(await h.run(), true, h.text());
  assert.deepEqual(h.marks(), [
    'ok config:',
    'ok host:',
    'ok rcon:',
    'ok S1',
    'ok S2',
    'ok S20',
    'ok S3',
    'ok S5',
    'ok S4',
    'ok S6',
    'ok S8',
    'ok S16',
    'ok S16',
    'ok S21',
    'ok S25',
    'ok S29',
    'ok hub:',
  ]);
  assert.match(h.out[0]!, /^orrery agent agent-v0\.0\.0: first-boot check$/);
  assert.match(h.line('S1'), /^ok {3}S1 \/orrery-save while paused: orrery-\d{8}T\d{6}Z\.zip \(0\.0 MB\) in \d+\.\d s, from tick 1002$/);
  assert.match(h.line('S20'), /tick 1204 -> 1205, saved .*\/saves\/world\.zip, Goodbye/);
  const restored = (await readdir(h.saves)).find((n) => n.startsWith('restored-'))!;
  assert.match(restored, /^restored-\d{8}T\d{6}Z-orrery-\d{8}T\d{6}Z\.zip$/);
  assert.ok(h.line('S3').startsWith(`ok   S3 a start loads the newest save, the restored copy: loaded ${join(h.saves, restored)}, tick 1004 (S1 saved from 1002, stopped at 1405); up in `), h.line('S3'));
  assert.match(h.line('S3'), /; up in \d+\.\d s, 401 ticks back$/);
  assert.match(h.line('S5'), /^ok {3}S5 stop: SIGINT, saved .*\/world\.zip, Goodbye, inactive with Result=success in \d+\.\d s$/);
  assert.match(h.line('S4'), /bound by uid \d+, "Opening socket" logged, the mod's hello came from it to orrery-agent.service \(seq 7\)$/);
  assert.match(h.line('S8'), /^ok {3}S8 one packet of \d+ bytes, read whole \(\/help \d+ bytes\)$/);
  assert.match(h.out.find((l) => l.startsWith('ok   S16 orrery-agent'))!, /NRestarts 0 held over .*label system_u:system_r:unconfined_service_t:s0, SELinux enforcing$/);
  assert.match(h.line('S25'), /^ok {3}S25 Factorio \(pid 4242\) runs as uid \d+ with no passwd entry, HOME=/);
  assert.match(h.line('S29'), /^ok {3}S29 Factorio 2\.1\.24 .*mods: base 2\.1\.24, space-age 2\.1\.24, quality 2\.1\.24, elevated-rails 2\.1\.24, recycler 2\.1\.24, orrery 0\.1\.0$/);
  assert.match(h.line('hub:'), /^ok {3}hub: 127\.0\.0\.1:\d+ welcomed agent-v0\.0\.0$/);
  assert.ok(h.out.includes('summary: 17 ok, 0 FAIL, 0 warn'), h.text());
  // The to-do for the others, after the count, each naming who.
  const after = h.out.slice(h.out.indexOf('summary: 17 ok, 0 FAIL, 0 warn') + 1);
  assert.ok(after.length > 15 && after.every((l) => /^skip S\d+ (players|owner|friend|setup|owner and friend|friend and owner|friend, as root): /.test(l)), after.join('\n'));
  for (const s of ['S19', 'S22', 'S23', 'S10', 'S24']) assert.ok(after.some((l) => l.startsWith(`skip ${s} `)), s);
  // Exactly the three stops and starts, on its own unit, never blocking.
  assert.deepEqual(h.calls, [
    ['restart', '--no-block', '--', UNIT],
    ['stop', '--no-block', '--', UNIT],
    ['start', '--no-block', '--', UNIT],
  ]);
  assert.ok(!h.commands.some((c) => /^\/(c|sc|silent-command|command) /.test(c)), 'never Lua');
  clean(h.text());
});

test('check: a stale RCON password fails at once, after one try; S21 says the expansion may have failed', async (t) => {
  const h = await host(t, { password: 'a-stale-password-from-an-old-env-file' });
  assert.equal(await h.run({ waits: { rcon: 60_000 } }), false);
  assert.match(h.line('rcon:'), /^FAIL rcon: 127\.0\.0\.1:\d+: RCON refused the password: RCON_PASSWORD is not the one factorio\.service started with/);
  assert.equal(h.received().filter((p) => p.type === AUTH).length, 1, 'no retry: waiting cannot fix a password');
  assert.match(h.line('S21'), /^FAIL S21 RCON refused the password, so systemd may not have expanded \$\{RCON_PASSWORD\}: fallback, the sh -c form$/);
  for (const s of ['S1', 'S2', 'S20', 'S3', 'S5', 'S4', 'S6', 'S8', 'S25', 'S29']) assert.match(h.line(s), /^warn .* skipped \(no RCON/, s);
  assert.deepEqual(h.calls, [], 'nothing stopped');
  assert.ok(!h.text().includes('a-stale-password'));
  clean(h.text());
});

test('check: a failed factorio.service fails at once with its state, and RCON is never tried', async (t) => {
  const h = await host(t, { unit: { active: 'failed', sub: 'failed', since: Date.now() - 10_000, result: 'exit-code' } });
  assert.equal(await h.run({ waits: { rcon: 60_000 } }), false);
  assert.equal(h.line('unit:'), `FAIL unit: ${UNIT} is failed (failed), Result=exit-code: as root, journalctl -u ${UNIT} says why`);
  assert.deepEqual(h.received(), [], 'no RCON connection');
  // The checks that need no Factorio still run.
  assert.match(h.out.find((l) => l.includes('S16 orrery-agent'))!, /^ok {3}S16 orrery-agent\.service active \(running\)/);
  assert.equal(h.line('S21'), 'warn S21 the password is in neither unit file, but its expansion is not shown (RCON never answered)');
  clean(h.text());
});

test('check: factorio.service failing while RCON is awaited ends the wait at its state', async (t) => {
  const failed = { active: 'failed', sub: 'failed', since: Date.now(), result: 'exit-code' };
  const h = await host(t, { noRcon: true, unit: { active: 'activating', sub: 'start', since: Date.now(), result: 'success' }, later: [failed] });
  assert.equal(await h.run({ waits: { rcon: 60_000 } }), false);
  assert.match(h.line('rcon:'), /^FAIL rcon: 127\.0\.0\.1:\d+: factorio\.service is failed \(failed\), Result=exit-code: as root, journalctl/);
  assert.equal(h.shows(), 2, 'the first reading, then one after RCON was refused: no further wait');
  clean(h.text());
});

test('check: RCON that never answers fails once waits.rcon is up, both refused and taken but silent', async (t) => {
  const refused = await host(t, { noRcon: true });
  assert.equal(await refused.run({ waits: { rcon: 200 } }), false);
  assert.match(refused.line('rcon:'), /^FAIL rcon: 127\.0\.0\.1:\d+: RCON connection failed: connect ECONNREFUSED/);
  const silent = await host(t, { silent: true });
  assert.equal(await silent.run({ waits: { rcon: 1000, command: 50 } }), false); // room for many tries, however late the timers
  assert.match(silent.line('rcon:'), /^FAIL rcon: 127\.0\.0\.1:\d+: RCON command timed out after 50 ms$/);
  assert.ok(silent.commands.filter((c) => c === '/orrery-status').length >= 2, 'retried until the wait was up');
  for (const h of [refused, silent]) {
    assert.match(h.line('S29'), /skipped \(no RCON/);
    assert.ok(h.text().includes('summary: '), 'the report still ends with its count');
    clean(h.text());
  }
});

test('check: players on (or auto_pause off) skip the save and every stop: nothing is stopped, and that still passes', async (t) => {
  const on = await host(t, { players: ['alice'] });
  assert.equal(await on.run(), true, on.text());
  for (const s of ['S1', 'S20', 'S3', 'S5']) assert.match(on.line(s), new RegExp(`^warn ${s} skipped \\(1 online\\)`), s);
  assert.deepEqual(on.calls, []);
  assert.ok(!on.commands.some((c) => c.startsWith('/orrery-save')));
  assert.equal(on.line('S2').slice(0, 7), 'ok   S2');
  const off = await host(t, { autoPause: false });
  assert.equal(await off.run(), true, off.text());
  assert.match(off.line('S1'), /^warn S1 skipped \(auto_pause is off\)/);
  assert.deepEqual(off.calls, []);
});

test('check: a restart that loaded an older save is S20 lost ticks, and a stop that saved nothing fails S5', async (t) => {
  const h = await host(t, { saveOnStop: false });
  assert.equal(await h.run(), false);
  // The restart loaded S1's save (the newest file then), 200 ticks back.
  assert.match(h.line('S20'), /^FAIL S20 restart lost ticks or did not save \(factorio-previous\.log\): tick 1204 -> 1004, no "Saving map as" line, Goodbye/);
  assert.match(h.line('S5'), /^FAIL S5 stop: SIGINT, no "Saving map as" line, Goodbye, inactive with Result=success .*: fallback, raise the timeouts$/);
  assert.equal(h.calls.at(-1)![0], 'start', 'started again');
  clean(h.text());
});

test('check: a SIGTERM stop is a warning (PodmanArgs not applied); a start that loads another save fails S3', async (t) => {
  const term = await host(t, { signal: 'SIGTERM' });
  assert.equal(await term.run(), true, term.text());
  assert.match(term.line('S5'), /^warn S5 stop: SIGTERM, saved .*: Podman sent SIGTERM, so PodmanArgs --stop-signal=SIGINT was not applied$/);
  const world = await host(t, { load: 'world' });
  assert.equal(await world.run(), false);
  assert.match(world.line('S3'), /^FAIL S3 loaded .*\/saves\/world\.zip, tick 1406 \(S1 saved from 1002, stopped at 1405\); up in \d+\.\d s: fallback, start with --start-server <file>/);
});

test('check: S1 failing still runs the stop and start for S5, and the server is started again', async (t) => {
  const h = await host(t, { saveWrites: false });
  assert.equal(await h.run({ waits: { save: 50 } }), false);
  assert.match(h.line('S1'), /^FAIL S1 orrery-\d{8}T\d{6}Z\.zip: did not appear within 0\.05 s: fallback, while paused skip the named save/);
  assert.equal(h.line('S3'), 'FAIL S3 not restored: S1 made no save to restore');
  assert.match(h.line('S5'), /^ok {3}S5 stop: SIGINT/);
  assert.deepEqual(h.calls.map((c) => c[0]), ['restart', 'stop', 'start']);
  assert.match(h.line('S4'), /^ok /, 'Factorio is back for the checks after it');
});

test('check: polkit refusing the stops fails S20 and S3 with its message; the server keeps running for the rest', async (t) => {
  const h = await host(t, { refuse: true });
  assert.equal(await h.run(), false);
  assert.equal(h.line('S20'), `FAIL S20 systemctl restart ${UNIT} failed: Failed to restart ${UNIT}: Access denied`);
  assert.equal(h.line('S3'), `FAIL S3 systemctl stop ${UNIT} failed: Failed to stop ${UNIT}: Access denied`);
  assert.equal(h.line('S5'), 'warn S5 skipped (no stop)');
  assert.match(h.line('S29'), /^ok /, 'still up');
});

test('check helpers: shutdown lines, the UDP socket table and mod-list.json read defensively', () => {
  const lines = [
    '  149.969 Received SIGINT, shutting down',
    '  149.969 Info MainLoop.cpp:447: Saving map as /srv/factorio/saves/world.zip',
    '  150.000 Script @__evil__/control.lua:1: Saving map as /srv/factorio/saves/forged.zip',
    '2026-11-01 10:00:00 [CHAT] bob: 150.436 Goodbye',
    '  150.436 Goodbye',
  ];
  assert.deepEqual(shutdownOf(lines), { signal: 'SIGINT', saved: '/srv/factorio/saves/world.zip', goodbye: true });
  assert.deepEqual(shutdownOf(lines.slice(0, 1).concat(lines[3]!)), { signal: 'SIGINT', saved: null, goodbye: false }, 'a chat or a mod line counts for nothing');
  const table = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n' +
    '   1: 00000000:8596 00000000:0000 07 00000000:00000000 00:00000000 00000000  1001        0 1\n' +
    '   2: 0100007F:8596 00000000:0000 07 00000000:00000000 00:00000000 00000000  1002        0 2\n';
  assert.equal(udpOwner(table, 34198), 1002, '127.0.0.1 only');
  assert.equal(udpOwner(table, 34199), null);
  assert.deepEqual(enabledMods(JSON.stringify({ mods: [{ name: 'base', enabled: true }, { name: 'x', enabled: false }, { name: 7, enabled: true }, 'junk'] })), ['base']);
  assert.equal(enabledMods('{"mods": {}}'), null);
  assert.equal(enabledMods('not json'), null);
});

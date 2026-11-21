// `check` called directly on a temp host as setup leaves it (`host`, in `check-host.ts`), for the checks after the
// stops (the stops and the whole report are in `check.test.ts`): S4 off in agent.log, the Lua UDP port taken, and
// with the agent down the hello heard by the check; S16 `203/EXEC` and SELinux permissive; the password in a unit
// file; S6 with no `mods/mod-settings.dat` written (the friend's VM: on the ok line, never "not in"), one name under
// the release instead (a warning), and `mods/` a link to another mount; S6 failing still names one not written yet,
// and `mods/` unsearchable (`EACCES`) a warning, not on the ok line; a mod not loaded and a version other than
// `current`; the hub's rejection quoted and no hub. No test's report has a secret.

import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MODS, clean, host } from './check-host.ts';

test('check: S4 fails when the agent logs game events off; with the agent down the check asks for the hello and hears it', async (t) => {
  const off = await host(t, { events: 'off', players: ['alice'] });
  assert.equal(await off.run(), false);
  assert.match(off.line('S4'), /^FAIL S4 127\.0\.0\.1:\d+ bound by uid \d+, "Opening socket" logged, agent\.log: \[events\] game events are off until Factorio starts again: .*: fallback, a write_file tail$/);
  const down = await host(t, { agentRunning: false, players: ['alice'] });
  assert.equal(await down.run(), true, down.text());
  assert.match(down.line('S4'), /the mod's hello came from it \(seq 7; orrery-agent\.service is down, so the check listened on 127\.0\.0\.1:\d+\)$/);
  assert.ok(down.commands.includes('/orrery-hello'));
});

test('check: S4 with the Lua UDP port taken says the Opening line came but the socket failed or closed', async (t) => {
  const h = await host(t, { udpTaken: true, players: ['alice'] });
  assert.equal(await h.run(), false);
  assert.match(h.line('S4'), /^FAIL S4 127\.0\.0\.1:\d+ bound by uid \d+, "Opening socket" logged, but the socket failed or closed \(the port is taken\?\): fallback, a write_file tail$/);
});

test('check: S16 fails on 203/EXEC and warns with SELinux not enforcing', async (t) => {
  const exec = await host(t, { players: ['alice'], agentShow: 'ActiveState=activating\nSubState=auto-restart\nResult=exit-code\nExecMainStatus=203\nNRestarts=4\nMainPID=0\n' });
  assert.equal(await exec.run(), false);
  assert.match(exec.out.find((l) => l.includes('S16 orrery-agent'))!, /^FAIL S16 orrery-agent\.service 203\/EXEC \(activating \(auto-restart\), Result=exit-code, exit status 203\): fallback, a broader bin_t rule$/);
  assert.match(exec.line('hub:'), /^warn hub: .* whether the agent was welcomed is unknown/);
  const permissive = await host(t, { players: ['alice'], selinux: '0' });
  assert.equal(await permissive.run(), true, permissive.text());
  assert.match(permissive.out.find((l) => l.includes('S16 orrery-agent'))!, /^warn S16 .*; SELinux is not enforcing, so 203\/EXEC was not exercised$/);
});

test('check: S21 fails when a unit file holds the password, and prints neither the password nor the file', async (t) => {
  const h = await host(t, { leak: true, players: ['alice'] });
  assert.equal(await h.run(), false);
  assert.match(h.line('S21'), /^FAIL S21 the RCON password is in .*\/gen\/factorio\.service; .*\/gen\/factorio\.service has no \$\{RCON_PASSWORD\} for systemd to expand: fallback, the sh -c form$/);
  assert.ok(!h.text().includes('podman run'), 'the unit file is not printed');
  clean(h.text());
});

test('check: S29 fails on a mod enabled but not loaded and on a version other than current; mod names print without escapes', async (t) => {
  const h = await host(t, {
    players: ['alice'],
    current: '2.1.23',
    modList: [...Object.keys(MODS), 'krastorio2', 'x\u001b[2J'],
    mods: { ...MODS, 'evil\u001b]0;pwned\u0007': '1.0.0' },
  });
  assert.equal(await h.run(), false);
  assert.match(
    h.line('S29'),
    /^FAIL S29 not loaded: krastorio2, x\?\[2J; Factorio 2\.1\.24 runs, but .*\/current is 2\.1\.23; mods: .*, evil\?\]0;pwned\? 1\.0\.0$/,
  );
  assert.match(h.line('S6'), /no run of Factorio 2\.1\.23 was seen/);
  clean(h.text());
});

test("check: S6 never calls a file the data folder lacks outside it: one not written yet goes on the ok line, one under the release is a warning", async (t) => {
  // The friend's VM: mods/ is the data folder's, and Factorio had written no mod-settings.dat there (nor anywhere).
  const vm = await host(t, { unwritten: ['mods/mod-settings.dat'] });
  assert.equal(await vm.run(), true, vm.text());
  assert.match(vm.line('S6'), /^ok {3}S6 Factorio writes under \S+ \(factorio-current\.log \(uid \d+\), saves\/orrery-\S+\.zip\), nothing under \S+; mods\/mod-settings\.dat not written yet, in either$/);
  assert.ok(!vm.out.some((l) => / S6 not in /.test(l)), vm.text());
  assert.deepEqual(vm.marks().filter((m) => m.endsWith(' S6')), ['ok S6']);

  const release = await host(t, { unwritten: ['player-data.json', 'mods/mod-settings.dat'], inRelease: ['player-data.json'] });
  assert.equal(await release.run(), true, release.text());
  assert.match(release.line('S6'), /; mods\/mod-settings\.dat not written yet, in either$/);
  assert.match(release.out.find((l) => l.startsWith('warn S6'))!, /^warn S6 under \S+\/releases\/2\.1\.24, not \S+ \(names not verified, so no FAIL\): player-data\.json$/);

  // mods/ another mount, linked in: its files are the data folder's.
  const linked = await host(t, { modsLinked: true });
  assert.equal(await linked.run(), true, linked.text());
  assert.deepEqual(linked.marks().filter((m) => m.endsWith(' S6')), ['ok S6']);
  assert.match(linked.line('S6'), /nothing under \S+\/releases\/2\.1\.24$/);
});

test('check: S6 still names a file not written yet when it fails, and a file it cannot look up is a warning, never on the ok line', async (t) => {
  // The log under the release fails S6; the missing mod-settings.dat is said on that FAIL line all the same.
  const failed = await host(t, { unwritten: ['mods/mod-settings.dat'], inRelease: ['factorio-current.log'] });
  assert.equal(await failed.run(), false, failed.text());
  assert.match(failed.line('S6'), /^FAIL S6 \S+\/releases\/2\.1\.24\/factorio-current\.log exists: fallback, mount the release read-write; mods\/mod-settings\.dat not written yet, in either$/);
  assert.deepEqual(failed.marks().filter((m) => m.endsWith(' S6')), ['FAIL S6']);

  // mods/ can't be searched (EACCES): neither absent nor under the release, but a warning of its own. Root can.
  if (process.getuid!() === 0) return;
  const locked = await host(t);
  await chmod(join(locked.data, 'mods'), 0o000);
  try {
    await locked.run();
  } finally {
    await chmod(join(locked.data, 'mods'), 0o755);
  }
  assert.match(locked.line('S6'), /^ok {3}S6 Factorio writes under \S+ \(.*\), nothing under \S+\/releases\/2\.1\.24$/);
  assert.match(locked.out.find((l) => l.startsWith('warn S6'))!, /^warn S6 can't look in \S+ for: mods\/mod-settings\.dat \(EACCES\)$/);
  assert.deepEqual(locked.marks().filter((m) => m.endsWith(' S6')), ['ok S6', 'warn S6']);
});

test('check: the hub: a rejection since the agent started is quoted (no wait for a welcome); no hub listening is a warning', async (t) => {
  const rejected = await host(t, { players: ['alice'], hub: 'rejected' });
  assert.equal(await rejected.run({ waits: { welcome: 60_000 } }), true, rejected.text());
  assert.match(rejected.line('hub:'), /^warn hub: 127\.0\.0\.1:\d+ answers, but no welcome since orrery-agent\.service started: \[hub\] no connection to the hub at 127\.0\.0\.1:1 \(rejected: unknown agent\): retrying$/);
  const none = await host(t, { players: ['alice'], hub: 'none' });
  assert.equal(await none.run(), true, none.text());
  assert.match(none.line('hub:'), /^warn hub: can't reach 127\.0\.0\.1:1 \(connect ECONNREFUSED .*\); fine before the hub listens$/);
});

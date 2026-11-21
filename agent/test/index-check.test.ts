// `src/index.ts check` as a child process, with a temp config, a fake `systemctl` first on `PATH` and fake RCON
// (`index-world.ts`): `check` (exit 1 exactly when a line is `FAIL`, a mod name's escape sequences printed as `?`, no
// secret; each line in the pipe while RCON is still awaited).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { eventually, killed } from './fake-hub.ts';
import { PASSWORD, fakeRcon } from './fake-rcon.ts';
import { INDEX, TOKEN, status, world } from './index-world.ts';

test('check: exit 0 only without a FAIL; a mod name prints without its escapes, no secret', async (t) => {
  // Any mod's name reaches the report, which setup prints on a root terminal: its escape sequences must not. A player
  // on skips the stops; this machine is no Factorio host, so its own checks (S4, S16, S21, S25) fail, quickly.
  const mods = { base: '2.1.24', 'x\u001b]0;pwned\u0007\u001b[2J': '1.0.0', orrery: '0.1.0' };
  const rcon = await fakeRcon(() => JSON.stringify({ ...JSON.parse(status()), mods, players: ['alice'] }));
  t.after(() => rcon.close());
  const { env } = await world(t, rcon.port, 1);
  const child = spawn(process.execPath, [INDEX, 'check'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const [code] = await once(child, 'exit');
  assert.equal(code, /^FAIL /m.test(out) ? 1 : 0, out);
  assert.match(out, /^ok {3}config: agent factorio-vm/m);
  assert.match(out, /^ok {3}host: cpu \d+%/m);
  assert.match(out, /^ok {3}rcon: Factorio 2\.1\.24 answers \/orrery-status: tick \d+, 1 online/m);
  assert.match(out, /^warn S1 skipped \(1 online\)/m);
  assert.match(out, /^FAIL S29 .*; mods: base 2\.1\.24, x\?\]0;pwned\?\?\[2J 1\.0\.0, orrery 0\.1\.0$/m);
  assert.doesNotMatch(out, /[\u001b\u0007]/, 'no escape sequence reaches the terminal');
  assert.match(out, /^warn hub: can't reach 127\.0\.0\.1:1/m);
  assert.match(out, /^summary: \d+ ok, \d+ FAIL, \d+ warn\nskip S4 /m);
  assert.ok(!out.includes(TOKEN) && !out.includes(PASSWORD), 'no secret in the report');
});

test('check: each line reaches the pipe as its check ends, not at exit (setup shows the report live)', async (t) => {
  const rcon = await fakeRcon(() => undefined); // takes the connection, never answers: the check waits up to 5 minutes
  t.after(() => rcon.close());
  const { env } = await world(t, rcon.port, 1);
  const child = spawn(process.execPath, [INDEX, 'check'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => killed(child));
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await eventually(() => out.includes('waiting for /orrery-status'), 10_000, 'the waiting note');
  assert.equal(child.exitCode, null, 'still waiting for RCON');
  assert.match(out, /^orrery agent agent-v0\.0\.0: first-boot check\nok {3}config: .*\nok {3}host: .*\n {5}waiting for \/orrery-status/);
});

test('check: a bad config fails with exit 1', async (t) => {
  const { env } = await world(t, 1, 1);
  const child = spawn(process.execPath, [INDEX, 'check'], { env: { ...env, ORRERY_AGENT_TOKEN: 'short' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(out, /^FAIL config: .*\n.*ORRERY_AGENT_TOKEN/m);
});

// `src/index.ts` as a child process, with a temp config, a fake `systemctl` first on `PATH`, the fake hub and fake
// RCON: both connections, the saves pushed, `started`, a `serviceAct` restart as `restart --no-block --
// factorio.service` with `stopping` first, `agent.log` written, then `bye` on SIGTERM and exit 0; `restore`, `update`
// and `settingsSet` refused ("a deploy is running (…)") while `list-units` shows a deploy unit activating, active,
// reloading or deactivating, not once it failed; a `deploy` of its own release (`agent-v0.0.0`) refused, then one as
// `list-units` and `start --no-block -- orrery-agent-deploy@agent-v1.2.5.service`, and a `deploy-status.json` left at
// start sent once as `deployResult` after its unit's `show`; game settings pushed on connect, a `settingsSet` written
// and applied live (the reply, then the push); offline with no hub, then connecting when it listens; `check` (exit 1
// exactly when a line is `FAIL`, a mod name's escape sequences printed as `?`, no secret; each line in the pipe while
// RCON is still awaited).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { eventually, fakeHub } from './fake-hub.ts';
import { PASSWORD, factorioConfig, fakeRcon } from './fake-rcon.ts';

const TOKEN = 'k'.repeat(40);
const INDEX = new URL('../src/index.ts', import.meta.url).pathname;

/**
 * The agent's world in a temp folder: its config (pointing at a fake hub and a fake RCON), its own folder, the
 * server's data folder with server-settings.json, and a fake systemctl first on PATH that logs its argv (and can't
 * read orrery-agent.service, which only the check asks about).
 */
async function world(t: TestContext, rconPort: number, hubPort: number) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'agent');
  const data = join(dir, 'factorio');
  await mkdir(root);
  await mkdir(join(data, 'config'), { recursive: true });
  await mkdir(join(data, 'saves'));
  await writeFile(join(data, 'saves', 'world.zip'), 'map');
  await mkdir(join(dir, 'bin'));
  await writeFile(join(data, 'config', 'server-settings.json'), JSON.stringify({ auto_pause: true }));
  const config = {
    id: 'factorio-vm',
    hub: { host: '127.0.0.1', port: hubPort },
    server: { id: 'factorio', unit: 'factorio.service', install: join(dir, 'opt'), data, rconPort, factorioUdpPort: 34198, agentUdpPort: 34199 },
    mounts: ['/'],
  };
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  await writeFile(
    join(dir, 'bin', 'systemctl'),
    // A deploy unit has ended (its oneshot is inactive); orrery-agent.service can't be read; every other unit runs.
    // list-units prints `<dir>/units` (none: no deploy unit known).
    `#!/bin/sh\necho "$*" >> "${dir}/systemctl.log"\ncase "$*" in list-units*) cat "${dir}/units" 2>/dev/null; exit 0;; *orrery-agent-deploy@*) echo ActiveState=inactive; exit 0;; *orrery-agent.service) exit 1;; esac\nprintf 'ActiveState=active\\nSubState=running\\nStateChangeTimestamp=@1793475924\\nResult=success\\n'\n`,
  );
  await chmod(join(dir, 'bin', 'systemctl'), 0o755);
  const env = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    ORRERY_AGENT_CONFIG: join(dir, 'config.json'),
    ORRERY_AGENT_ROOT: root,
    ORRERY_AGENT_TOKEN: TOKEN,
    RCON_PASSWORD: PASSWORD,
  };
  return { dir, root, env };
}

/** A `settingsSet` the hub's rules let through: a new name and player limit, Bob an admin. */
const settingsSet = (id: string) => ({
  type: 'settingsSet',
  id,
  settings: {
    name: 'Our base',
    description: '',
    max_players: 8,
    require_user_verification: true,
    autosave_interval: 10,
    autosave_slots: 5,
    afk_autokick_interval: 0,
    auto_pause: true,
    auto_pause_when_players_connect: false,
    only_admins_can_pause_the_game: true,
    allow_commands: 'admins-only',
  },
  admins: ['bob'],
});

const status = () =>
  JSON.stringify({ ok: true, tick: Date.now(), tick_paused: false, players: {}, version: '2.1.24', mods: { base: '2.1.24', orrery: '0.1.0' }, loaded: true });

test('the agent connects both ways, pushes its saves, carries out serviceAct with stopping first; on SIGTERM sends bye, closes both connections and exits 0', async (t) => {
  const rcon = await fakeRcon(status);
  const hub = await fakeHub();
  t.after(async () => {
    await rcon.close();
    await hub.close();
  });
  const { dir, root, env } = await world(t, rcon.port, hub.port);
  const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  t.after(() => child.kill('SIGKILL'));

  const agent = await eventually(() => hub.of('agentHello')[0], 5000, 'the agentHello');
  assert.equal(agent.lines[0]!.agentVersion, 'agent-v0.0.0', 'package.json version, as a tag');
  const game = await eventually(() => hub.of('hello')[0], 5000, 'the game hello');
  assert.equal(game.lines[0]!.modVersion, '0.1.0');
  await eventually(() => agent.lines.some((m) => m.type === 'serviceState'), 5000, 'serviceState');
  assert.match(await readFile(join(dir, 'systemctl.log'), 'utf8'), /^show --timestamp=unix --property=ActiveState,SubState,Result,StateChangeTimestamp -- factorio.service$/m);
  const saves = await eventually(() => agent.lines.find((m) => m.type === 'saves'), 5000, 'saves');
  assert.deepEqual((saves.saves as { name: string; kind: string }[]).map((s) => [s.name, s.kind]), [['world.zip', 'world']]);
  await eventually(() => game.lines.some((m) => m.type === 'started'), 5000, 'started');

  agent.send({ type: 'serviceAct', id: 'r1', action: 'restart' });
  await eventually(() => agent.lines.find((m) => m.type === 'reply' && m.id === 'r1'), 5000, 'the reply');
  assert.deepEqual(agent.lines.find((m) => m.id === 'r1'), { type: 'reply', id: 'r1', ok: true });
  assert.match(await readFile(join(dir, 'systemctl.log'), 'utf8'), /^restart --no-block -- factorio.service$/m, 'the fake systemctl on PATH');
  await eventually(() => game.closed, 5000, 'the game connection closed after stopping');
  assert.equal(game.lines.at(-1)!.type, 'stopping');
  assert.match(await readFile(join(root, 'agent.log'), 'utf8'), /Z \[agent\] agent-v0\.0\.0: agent factorio-vm/);

  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, out);
  await eventually(() => agent.closed && game.closed, 2000, 'both connections closed');
  assert.deepEqual(agent.lines.at(-1), { type: 'bye' });
  assert.equal(hub.conns.length, 2, 'no reconnect after SIGTERM');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'connected'), 'utf8')).version, 'agent-v0.0.0');
  assert.deepEqual([...agent.invalid, ...game.invalid], []);
});

test('deploy: starts its own deploy unit (the reply means started), and reports the outcome deploy-agent.sh left once', async (t) => {
  const rcon = await fakeRcon(status);
  const hub = await fakeHub();
  t.after(async () => {
    await rcon.close();
    await hub.close();
  });
  const { dir, root, env } = await world(t, rcon.port, hub.port);
  // A deploy that ended while this agent was starting: rolled back, its log 40 lines at most.
  const log = Array.from({ length: 45 }, (_, i) => `line ${i}`).join('\n');
  const left = { tag: 'agent-v1.2.4', from: 'agent-v0.0.0', outcome: 'rolled back', finished: new Date().toISOString(), log };
  await writeFile(join(root, 'deploy-status.json'), JSON.stringify(left) + '\n');
  const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  t.after(() => child.kill('SIGKILL'));

  const agent = await eventually(() => hub.of('agentHello')[0], 5000, 'the agentHello');
  const result = await eventually(() => agent.lines.find((m) => m.type === 'deployResult'), 5000, 'the deployResult');
  assert.deepEqual(result, { type: 'deployResult', tag: 'agent-v1.2.4', outcome: 'rolled back', log: log.split('\n').slice(-40).join('\n') });
  assert.match(await readFile(join(dir, 'systemctl.log'), 'utf8'), /^show --property=ActiveState -- orrery-agent-deploy@agent-v1\.2\.4\.service$/m);

  agent.send({ type: 'deploy', id: 'd0', tag: 'agent-v0.0.0' });
  assert.deepEqual(await eventually(() => agent.lines.find((m) => m.id === 'd0'), 5000, 'the reply'), { type: 'reply', id: 'd0', ok: false, error: 'agent-v0.0.0 is already running' });
  agent.send({ type: 'deploy', id: 'd1', tag: 'agent-v1.2.5' });
  assert.deepEqual(await eventually(() => agent.lines.find((m) => m.id === 'd1'), 5000, 'the reply'), { type: 'reply', id: 'd1', ok: true });
  // Before it starts one, it asks systemd for any deploy unit still running.
  assert.match(await readFile(join(dir, 'systemctl.log'), 'utf8'), /^list-units --all --plain --no-legend --full -- orrery-agent-deploy@\*\.service\nstart --no-block -- orrery-agent-deploy@agent-v1\.2\.5\.service$/m);
  assert.doesNotMatch(await readFile(join(dir, 'systemctl.log'), 'utf8'), /orrery-agent-deploy@agent-v0\.0\.0/);
  assert.equal(agent.lines.filter((m) => m.type === 'deployResult').length, 1, 'once');
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, out);
  assert.deepEqual(agent.invalid, []);
});

test('restore and update are refused while a deploy unit of the agent runs (its restart would cut them short); not once it ended', async (t) => {
  const rcon = await fakeRcon(status);
  const hub = await fakeHub();
  t.after(async () => {
    await rcon.close();
    await hub.close();
  });
  const { dir, env } = await world(t, rcon.port, hub.port);
  const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const agent = await eventually(() => hub.of('agentHello')[0], 5000, 'the agentHello');
  await eventually(() => agent.lines.some((m) => m.type === 'serviceState'), 5000, 'serviceState');
  const ask = async (msg: Record<string, unknown>) => {
    agent.send(msg);
    return eventually(() => agent.lines.find((m) => m.type === 'reply' && m.id === msg.id), 5000, `the reply to ${msg.id as string}`);
  };
  const update = (id: string) => ({
    type: 'update',
    id,
    factorio: { version: '2.1.25', url: 'https://www.factorio.com/get-download/2.1.25/headless/linux64', sha256: 'a'.repeat(64) },
    mods: [{ name: 'orrery', version: '0.2.0', sha1: 'b'.repeat(40), url: 'https://dl-mod.factorio.com/files/orrery_0.2.0.zip?secure=x' }],
  });

  for (const active of ['activating', 'active', 'reloading', 'deactivating']) {
    await writeFile(join(dir, 'units'), `orrery-agent-deploy@agent-v1.2.5.service loaded ${active} start Deploy orrery agent agent-v1.2.5\n`);
    const error = `a deploy is running (orrery-agent-deploy@agent-v1.2.5.service is ${active})`;
    assert.deepEqual(await ask({ type: 'restore', id: `r-${active}`, name: 'world.zip' }), { type: 'reply', id: `r-${active}`, ok: false, error });
    assert.deepEqual(await ask(update(`u-${active}`)), { type: 'reply', id: `u-${active}`, ok: false, error });
    assert.deepEqual(await ask(settingsSet(`s-${active}`)), { type: 'reply', id: `s-${active}`, ok: false, error });
  }

  // Ended (failed): no longer the reason. The restore meets the running server, the update a Host with no release.
  await writeFile(join(dir, 'units'), 'orrery-agent-deploy@agent-v1.2.5.service loaded failed failed Deploy orrery agent agent-v1.2.5\n');
  const restore = await ask({ type: 'restore', id: 'r-ended', name: 'world.zip' });
  assert.equal(restore.ok, false);
  assert.doesNotMatch(String(restore.error), /deploy/);
  const updated = await ask(update('u-ended'));
  assert.equal(updated.ok, false);
  assert.match(String(updated.error), /does not point at a release/);
  assert.doesNotMatch(await readFile(join(dir, 'systemctl.log'), 'utf8'), /^start/m, 'nothing started');
  assert.equal(JSON.parse(await readFile(join(dir, 'factorio', 'config', 'server-settings.json'), 'utf8')).name, undefined, 'no settings written');
  assert.deepEqual(agent.invalid, []);
  child.kill('SIGTERM'); // and wait for its exit, so it writes no more into the folder the test removes
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

test('game settings: pushed on connect, written and applied live on settingsSet, and pushed again after the reply', async (t) => {
  let adminlist = '';
  const rcon = await fakeRcon((c) => (c === '/orrery-status' ? status() : (factorioConfig(c, adminlist) ?? [])));
  const hub = await fakeHub();
  t.after(async () => {
    await rcon.close();
    await hub.close();
  });
  const { dir, env } = await world(t, rcon.port, hub.port);
  const config = join(dir, 'factorio', 'config');
  adminlist = join(config, 'server-adminlist.json');
  await writeFile(
    join(config, 'server-settings.json'),
    JSON.stringify({ name: 'orrery Factorio', description: '', game_password: 'Abcdefghij0123456789', visibility: { public: false, lan: false }, auto_pause: true, allow_commands: 'admins-only' }),
  );
  await writeFile(adminlist, '[]');
  const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const agent = await eventually(() => hub.of('agentHello')[0], 5000, 'the agentHello');
  const pushed = () => agent.lines.filter((m) => m.type === 'settings') as Record<string, any>[];
  await eventually(() => pushed().length > 0, 5000, 'settings on connect');
  assert.equal(pushed()[0]!.settings.name, 'orrery Factorio');
  assert.equal(pushed()[0]!.settings.game_password_set, true);
  await eventually(() => hub.of('hello')[0], 5000, 'the game connection: RCON answers');

  agent.send(settingsSet('s1'));
  const reply = await eventually(() => agent.lines.find((m) => m.type === 'reply' && m.id === 's1'), 5000, 'the reply');
  assert.deepEqual(reply, { type: 'reply', id: 's1', ok: true, data: { applied: ['name', 'max_players', 'admins'], pending: [] } });
  assert.deepEqual(
    rcon.commands().filter((c) => c !== '/orrery-status' && c !== '/orrery-hello'),
    ['/config set name Our base', '/config set max-players 8', '/promote bob'],
  );
  const after = await eventually(() => pushed().find((p) => p.settings?.name === 'Our base'), 5000, 'settings after the save');
  assert.deepEqual(after.admins, ['bob']);
  assert.ok(agent.lines.indexOf(reply) < agent.lines.indexOf(after), 'the reply first');
  assert.deepEqual(agent.invalid, []);
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

test('with no hub reachable the agent keeps running, logs that once, and connects when the hub comes up', async (t) => {
  const rcon = await fakeRcon(status);
  t.after(() => rcon.close());
  const probe = await fakeHub();
  const port = probe.port;
  await probe.close(); // nothing listens on this port for now
  const { env } = await world(t, rcon.port, port);
  const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  t.after(() => child.kill('SIGKILL'));
  await eventually(() => out.includes('no connection to the hub'), 5000, 'the offline log line');
  const hub = await fakeHub(undefined, port);
  t.after(() => hub.close());
  await eventually(() => hub.of('hello')[0], 8000, 'both connections once the hub listens');
  assert.equal(child.exitCode, null, 'still running');
  assert.equal(out.split('no connection to the hub').length - 1, 1, `logged once while offline:\n${out}`);
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

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
  t.after(() => child.kill('SIGKILL'));
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

import assert from 'node:assert/strict';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { format } from 'node:util';
import { check, enabledMods, shutdownOf, udpOwner, type CheckOptions, type WAITS } from '../src/check.ts';
import type { Config } from '../src/config.ts';
import { AUTH } from '../src/rcon.ts';
import type { Systemctl, UnitState } from '../src/service.ts';
import { PASSWORD, fakeRcon, savedAs } from './fake-rcon.ts';

const TOKEN = 't'.repeat(40);
const VER = '2.1.24';
const UNIT = 'factorio.service';
const MODS = { base: VER, 'space-age': VER, quality: VER, 'elevated-rails': VER, recycler: VER, orrery: '0.1.0' };
const AGENT_PID = 777;
const FACTORIO_PID = 4242;

/** Waits short enough for a test, each that must not fire far over what the fake needs. */
const FAST: Partial<typeof WAITS> = {
  rcon: 3000,
  retry: 20,
  command: 2000,
  stop: 3000,
  save: 3000,
  stable: 30,
  poll: 5,
  agent: 2000,
  restarts: 20,
  events: 2000,
  hello: 2000,
  hub: 2000,
  welcome: 2000,
  cpu: 1,
};

const free = async (): Promise<UdpSocket> => {
  const s = createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', r));
  return s;
};

type Setup = {
  /** Online at every /orrery-status. */
  players?: string[];
  autoPause?: boolean;
  /** factorio.service before the check. */
  unit?: Omit<UnitState, 'unit'>;
  /** Each read of factorio.service after the first: these states in turn, before any stop or start. */
  later?: Omit<UnitState, 'unit'>[];
  /** False: a stop writes no save (as a SIGKILL would). */
  saveOnStop?: boolean;
  /** False: /orrery-save answers ok but no file appears. */
  saveWrites?: boolean;
  signal?: 'SIGINT' | 'SIGTERM';
  /** Factorio's Lua UDP port is another process's: Factorio logs its Opening line, then closes it and fails. */
  udpTaken?: boolean;
  /** 'world': a start always loads saves/world.zip, not the newest file. */
  load?: 'newest' | 'world';
  /** What the running agent logs at each start: the mod's hello, or events off. */
  events?: 'hello' | 'off';
  /** The agent holds its UDP port (else the check binds it and hears the hello itself). */
  agentRunning?: boolean;
  agentShow?: string;
  selinux?: string;
  /** The generated unit holds the password (a broken Quadlet). */
  leak?: boolean;
  /** The release `current` points at. */
  current?: string;
  modList?: string[];
  mods?: Record<string, string>;
  /** The RCON password the check has (setup's env file): another one than Factorio's is refused. */
  password?: string;
  /** No RCON listens at all. */
  noRcon?: boolean;
  /** RCON takes the connection but never answers /orrery-status. */
  silent?: boolean;
  hub?: 'welcomed' | 'rejected' | 'none';
  /** polkit refuses every stop, start and restart. */
  refuse?: boolean;
  /** Files S6 looks for that Factorio has not written in the data folder (relative to it). */
  unwritten?: string[];
  /** Of those, the ones under the release instead, written before the run. */
  inRelease?: string[];
  /** mods/ is a link to a folder outside the data folder (another mount, say). */
  modsLinked?: boolean;
};

/**
 * A host as setup leaves it, in a temp folder: the server's data folder, the install, the agent's folder (agent.log,
 * `connected`), a /proc with Factorio's process and socket, the unit files, a fake RCON shaped like Factorio's (each
 * command one tick, a save file holding its tick) and a systemctl that plays factorio.service: a stop or start queued
 * by `act` happens at the next `show`, so the check sees every state without any race.
 */
async function host(t: TestContext, s: Setup = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, 'srv');
  const install = join(dir, 'opt');
  const root = join(dir, 'agent');
  const proc = join(dir, 'proc');
  const saves = join(data, 'saves');
  const log = join(data, 'factorio-current.log');
  const agentLog = join(root, 'agent.log');
  const uid = process.getuid!();
  for (const d of [saves, join(data, 'config'), root, join(proc, 'net'), join(dir, 'gen'), join(dir, 'quadlet')]) await mkdir(d, { recursive: true });
  if (s.modsLinked) {
    await mkdir(join(dir, 'mods-mount'));
    await symlink(join(dir, 'mods-mount'), join(data, 'mods'));
  } else await mkdir(join(data, 'mods'));

  // The running agent holds its UDP port; with it down the port is free (found by binding, then let go).
  const agentSock = await free();
  const agentUdpPort = agentSock.address().port;
  if (s.agentRunning === false) agentSock.close();
  else t.after(() => agentSock.close());
  const factorioSock = await free(); // Factorio's Lua UDP socket: the source of the mod's datagrams
  t.after(() => factorioSock.close());
  const factorioUdpPort = factorioSock.address().port;

  // The release, written long before the run, and current pointing at it.
  const release = join(install, 'releases', VER);
  await mkdir(join(release, 'bin'), { recursive: true });
  await writeFile(join(release, 'bin', 'factorio'), 'elf');
  const old = new Date(Date.now() - 86_400_000);
  for (const p of [join(release, 'bin', 'factorio'), join(release, 'bin'), release]) await utimes(p, old, old);
  await symlink(`releases/${s.current ?? VER}`, join(install, 'current'));

  await writeFile(join(data, 'config', 'server-settings.json'), JSON.stringify({ auto_pause: s.autoPause ?? true }));
  const enabled = s.modList ?? Object.keys(MODS);
  await writeFile(join(data, 'mods', 'mod-list.json'), JSON.stringify({ mods: [...enabled.map((name) => ({ name, enabled: true })), { name: 'off-mod', enabled: false }] }));
  for (const name of ['player-data.json', 'mods/mod-settings.dat']) {
    if (!s.unwritten?.includes(name)) await writeFile(join(data, name), 'x');
  }
  for (const name of s.inRelease ?? []) {
    await mkdir(join(release, name, '..'), { recursive: true });
    await writeFile(join(release, name), 'x');
    await utimes(join(release, name), old, old);
  }
  for (const p of [join(release, 'mods'), release]) await utimes(p, old, old).catch(() => {});
  await writeFile(join(saves, 'world.zip'), '1000');

  // /proc: Factorio as this uid (its environment holds a secret the report must never show), the agent's label.
  await writeFile(
    join(proc, 'net', 'udp'),
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n' +
      `  12: 0100007F:${factorioUdpPort.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 07 00000000:00000000 00:00000000 00000000  ${uid}        0 9999 2 0000000000000000 0\n`,
  );
  await mkdir(join(proc, '1'));
  await writeFile(join(proc, '1', 'stat'), '1 (systemd) S 0 1 1 0 -1');
  await writeFile(join(proc, '1', 'status'), 'Name:\tsystemd\nUid:\t0\t0\t0\t0\n');
  await mkdir(join(proc, String(FACTORIO_PID), 'root', 'etc'), { recursive: true });
  await writeFile(join(proc, String(FACTORIO_PID), 'stat'), `${FACTORIO_PID} (factorio) S 1 ${FACTORIO_PID} 0 -1`);
  await writeFile(join(proc, String(FACTORIO_PID), 'status'), `Name:\tfactorio\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  await writeFile(join(proc, String(FACTORIO_PID), 'environ'), `PATH=/usr/bin\0HOME=${data}\0RCON_PASSWORD=${PASSWORD}\0`);
  await writeFile(join(proc, String(FACTORIO_PID), 'root', 'etc', 'passwd'), 'root:x:0:0:root:/root:/bin/sh\n');
  await mkdir(join(proc, String(AGENT_PID), 'attr'), { recursive: true });
  await writeFile(join(proc, String(AGENT_PID), 'attr', 'current'), 'system_u:system_r:unconfined_service_t:s0\0');
  await writeFile(join(dir, 'enforce'), s.selinux ?? '1');
  await writeFile(join(dir, 'gen', UNIT), `[Service]\nExecStart=/usr/bin/podman run --name factorio … --rcon-password ${s.leak ? PASSWORD : '${RCON_PASSWORD}'}\n`);
  await writeFile(join(dir, 'quadlet', 'factorio.container'), 'Exec=/opt/factorio/current/bin/arm64/factorio --rcon-password ${RCON_PASSWORD}\n');

  // The game: each command runs one tick; a save file holds the tick it was made at.
  const commands: string[] = [];
  let tick = 1000;
  let loaded = join(saves, 'world.zip');
  const status = () => JSON.stringify({ ok: true, tick: ++tick, tick_paused: false, players: s.players ?? {}, version: VER, mods: s.mods ?? MODS, loaded: true });
  const handle = async (command: string) => {
    commands.push(command);
    if (command === '/orrery-status') return s.silent ? undefined : status();
    tick++;
    if (command === '/orrery-unlink') return JSON.stringify({ ok: false, error: '/orrery-unlink is for players' });
    if (command === '/orrery-hello') {
      factorioSock.send(JSON.stringify({ t: 'hello', seq: 7 }), agentUdpPort, '127.0.0.1');
      return JSON.stringify({ ok: true, seq: 7 });
    }
    if (command === '/help') return Array.from({ length: 200 }, (_, i) => `/command-${i}: what it does, at some length`);
    const save = /^\/orrery-save (\S+)$/.exec(command);
    if (save) {
      if (s.saveWrites !== false) await writeFile(join(saves, savedAs(save[1]!)), String(tick));
      return JSON.stringify({ ok: true, name: save[1] });
    }
    return [];
  };
  let rcon = await fakeRcon(handle);
  const rconPort = rcon.port;
  const received = () => rcon.received;
  if (s.noRcon) await rcon.close();
  t.after(() => rcon.close());

  const lines = (events: 'hello' | 'off' = s.events ?? 'hello') => {
    const at = new Date().toISOString();
    return events === 'hello'
      ? `${at} [events] on: Factorio opened its Lua UDP socket on 127.0.0.1:${factorioUdpPort}\n${at} [events] the mod's hello came: seq 7\n`
      : `${at} [events] game events are off until Factorio starts again: Factorio could not open its Lua UDP socket\n`;
  };
  const taken = '   0.101 Info UDPSocket.cpp:238: Closing socket\n   0.101 Info UDPSocket.cpp:268: Socket closed\n' +
    '   0.101 Warning Game.cpp:73: Opening Lua UDP Socket failed: Binding IPv4 socket failed: Address already in use\n';
  const startLog = () =>
    `   0.100 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({127.0.0.1:${factorioUdpPort}}))\n${s.udpTaken ? taken : ''}   1.500 Info AppManager.cpp:520: Loading map ${loaded}: 1234 bytes.\n`;
  await writeFile(log, startLog());
  await writeFile(agentLog, lines());
  const agentStart = Date.now() - 30_000;
  if (s.hub !== 'none') await writeFile(join(root, 'connected'), JSON.stringify({ version: 'agent-v0.0.0', time: s.hub === 'rejected' ? agentStart - 60_000 : Date.now() }));
  if (s.hub === 'rejected') await appendFile(agentLog, `${new Date().toISOString()} [hub] no connection to the hub at 127.0.0.1:1 (rejected: unknown agent): retrying\n`);
  const hub = createServer((c) => c.destroy());
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => hub.close(() => r())));
  const hubPort = s.hub === 'none' ? 1 : (hub.address() as AddressInfo).port;

  // factorio.service.
  const second = (ms: number) => Math.floor(ms / 1000) * 1000;
  let unit: Omit<UnitState, 'unit'> = s.unit ?? { active: 'active', sub: 'running', since: second(Date.now() - 60_000), result: 'success' };
  const later = [...(s.later ?? [])];
  const pending: string[] = [];
  const calls: string[][] = [];
  let shows = 0;
  const transition = async (verb: string) => {
    if (verb === 'stop') {
      await rcon.close();
      const saved = s.saveOnStop === false ? '' : `  12.001 Info MainLoop.cpp:447: Saving map as ${loaded}\n  12.010 Info MainLoop.cpp:458: Saving progress: 100.000000%\n`;
      if (saved) await writeFile(loaded, String(tick));
      await appendFile(log, `  12.000 Received ${s.signal ?? 'SIGINT'}, shutting down\n  12.000 Quitting: signal.\n${saved}  12.300 Goodbye\n`);
      unit = { active: 'inactive', sub: 'dead', since: second(Date.now()), result: 'success' };
    } else {
      await rename(log, join(data, 'factorio-previous.log'));
      let newest = { name: 'world.zip', mtime: -1 };
      for (const name of await readdir(saves)) {
        const st = await lstat(join(saves, name));
        if (name.endsWith('.zip') && st.mtimeMs > newest.mtime) newest = { name, mtime: st.mtimeMs };
      }
      loaded = join(saves, s.load === 'world' ? 'world.zip' : newest.name);
      tick = Number(await readFile(loaded, 'utf8'));
      await writeFile(log, startLog());
      rcon = await fakeRcon(handle, Infinity, rconPort);
      unit = { active: 'active', sub: 'running', since: second(Date.now()), result: 'success' };
      await appendFile(agentLog, lines());
    }
  };
  const agentShow =
    s.agentShow ??
    `ActiveState=active\nSubState=running\nResult=success\nExecMainStatus=0\nNRestarts=0\nMainPID=${AGENT_PID}\nActiveEnterTimestamp=@${Math.floor(agentStart / 1000)}\n`;
  const systemctl: Systemctl = async (args) => {
    if (args[0] === 'show') {
      if (args.at(-1) === 'orrery-agent.service') return agentShow;
      if (shows++ > 0 && later.length > 0) unit = later.shift()!;
      const next = pending.shift();
      if (next) await transition(next);
      const at = unit.since ? `@${Math.floor(unit.since / 1000)}` : '';
      return `ActiveState=${unit.active}\nSubState=${unit.sub}\nResult=${unit.result}\nStateChangeTimestamp=${at}\n`;
    }
    calls.push(args);
    if (s.refuse) throw new Error(`Failed to ${args[0]} ${UNIT}: Access denied`);
    pending.push(...(args[0] === 'restart' ? ['stop', 'start'] : [args[0]!]));
    return '';
  };

  const config: Config = {
    id: 'factorio-vm',
    hub: { host: '127.0.0.1', port: hubPort },
    server: { id: 'factorio', unit: UNIT, install, data, rconPort, factorioUdpPort, agentUdpPort },
    mounts: ['/'],
    token: TOKEN,
    rconPassword: s.password ?? PASSWORD,
    root,
    state: join(root, 'state'),
  };
  const options: CheckOptions = {
    waits: FAST,
    systemctl,
    paths: { proc, selinux: join(dir, 'enforce'), generator: join(dir, 'gen'), quadlet: join(dir, 'quadlet') },
  };
  const out: string[] = [];
  const run = async (o: CheckOptions = {}) => {
    const log = t.mock.method(console, 'log', (...a: unknown[]) => out.push(format(...a)));
    const error = t.mock.method(console, 'error', (...a: unknown[]) => out.push(format(...a)));
    try {
      return await check(() => config, 'agent-v0.0.0', { ...options, ...o, waits: { ...FAST, ...o.waits } });
    } finally {
      log.mock.restore();
      error.mock.restore();
    }
  };
  return {
    run,
    out,
    text: () => out.join('\n'),
    /** The report's lines with a mark, `S20 …` as `['ok', 'S20']`. */
    marks: () => out.map((l) => /^(ok|FAIL|warn) {1,3}(\S+)/.exec(l)).filter((m) => m !== null).map((m) => `${m[1]} ${m[2]}`),
    line: (id: string) => out.find((l) => new RegExp(`^(ok|FAIL|warn) {1,3}${id} `).test(l)) ?? `(no ${id} line)`,
    commands,
    calls,
    received,
    shows: () => shows,
    agentLog,
    saves,
    data,
  };
}

/** No secret, and no character a terminal would act on, in the whole report. */
function clean(text: string): void {
  assert.ok(!text.includes(PASSWORD), 'the RCON password is never printed');
  assert.ok(!text.includes(TOKEN), 'the token is never printed');
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, 'no control character');
}

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

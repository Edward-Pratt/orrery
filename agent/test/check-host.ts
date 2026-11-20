// The temp Host check.test.ts runs `check` on (`host`), as setup leaves it: the data folder, the install, agent.log and
// `connected`, a `/proc` (Factorio's process, its environment holding the password, its UDP socket), the unit files,
// a fake RCON that runs a tick per command and writes a save holding its tick, and a `Systemctl` that plays
// factorio.service (a stop or start queued by `act` happens at the next `show`: no race); and `clean`, the check that
// a report holds no secret and no control character.
// modular-exempt: one fixture; host()'s closures share the fake unit, RCON and log state, so a split would scatter it.

import assert from 'node:assert/strict';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { format } from 'node:util';
import { check, type CheckOptions, type WAITS } from '../src/check.ts';
import type { Config } from '../src/config.ts';
import type { Systemctl, UnitState } from '../src/service.ts';
import { PASSWORD, fakeRcon, savedAs } from './fake-rcon.ts';

const TOKEN = 't'.repeat(40);
const VER = '2.1.24';
export const UNIT = 'factorio.service';
export const MODS = { base: VER, 'space-age': VER, quality: VER, 'elevated-rails': VER, recycler: VER, orrery: '0.1.0' };
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
export async function host(t: TestContext, s: Setup = {}) {
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
export function clean(text: string): void {
  assert.ok(!text.includes(PASSWORD), 'the RCON password is never printed');
  assert.ok(!text.includes(TOKEN), 'the token is never printed');
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, 'no control character');
}

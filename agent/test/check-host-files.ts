// The temp Host's files that `host` (`check-host.ts`) writes before the check runs, as setup leaves them (`files`):
// the release, written long before the run, and `current` pointing at it; the server's settings and `mod-list.json`;
// the files S6 looks for; a `/proc` with Factorio's process (its environment holding the password) and UDP socket,
// and the agent's label; SELinux's `enforce`; the generated unit and the `.container`. `Setup` says how the host
// differs from setup's.

import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UnitState } from '../src/service.ts';
import { PASSWORD } from './fake-rcon.ts';

export const VER = '2.1.24';
export const UNIT = 'factorio.service';
export const MODS = { base: VER, 'space-age': VER, quality: VER, 'elevated-rails': VER, recycler: VER, orrery: '0.1.0' };
export const AGENT_PID = 777;
const FACTORIO_PID = 4242;

export type Setup = {
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


/** The host's folders, as `host` names them. */
export type Dirs = { dir: string; data: string; install: string; proc: string; saves: string };

/** Writes the host's files under `d` for `s`, the socket in `/proc` on `factorioUdpPort`. */
export async function files(d: Dirs, s: Setup, factorioUdpPort: number): Promise<void> {
  const { dir, data, install, proc, saves } = d;
  const uid = process.getuid!();
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
}

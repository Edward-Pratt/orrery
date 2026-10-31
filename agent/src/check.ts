import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.ts';
import { HostSampler, procReaders, type HostReaders } from './host.ts';
import { Rcon } from './rcon.ts';
import { parseStatus, type Status } from './status.ts';

export type CheckOptions = {
  /** How long RCON gets to answer: Factorio may still be loading the map (factorio.service allows a 300 s start). */
  rconWaitMs?: number;
  retryMs?: number;
  hubWaitMs?: number;
  /** Between the two CPU readings of the host sample. */
  cpuMs?: number;
  read?: HostReaders;
};

const GB = 1024 ** 3;
const gb = (n: number) => (n / GB).toFixed(1);

/** `/orrery-status` over RCON, retried until it answers or `waitMs` is up; why not, if it never did. */
async function rconStatus(config: Config, waitMs: number, retryMs: number): Promise<Status | string> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let why: string;
    try {
      const rcon = await Rcon.connect('127.0.0.1', config.server.rconPort, config.rconPassword, 4000);
      try {
        const status = parseStatus(await rcon.exec('/orrery-status', 4000));
        if (status) return status;
        why = '/orrery-status gave no status (is the orrery mod loaded?)';
      } finally {
        rcon.close();
      }
    } catch (err) {
      why = (err as Error).message;
    }
    if (Date.now() + retryMs > deadline) return why;
    await sleep(retryMs);
  }
}

/** Null if a TCP connection to the hub opens (and is closed at once, nothing sent), else why not. */
function reach(host: string, port: number, waitMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: waitMs });
    socket.once('connect', () => (socket.destroy(), resolve(null)));
    socket.once('timeout', () => (socket.destroy(), resolve('timed out')));
    socket.once('error', (err) => resolve(err.message));
  });
}

/**
 * The first-boot check (setup's last step, `index.ts check`), as a report on stdout: the config and secrets, a host
 * sample, RCON's `/orrery-status` (the game's version and every loaded mod) and whether the hub can be reached. True
 * when all passed; the hub is only a warning, since setup may run before the hub listens (`--no-hub`).
 */
export async function check(load: () => Config, version: string, o: CheckOptions = {}): Promise<boolean> {
  const say = (mark: 'ok' | 'FAIL' | 'warn', what: string) => console.log(`${mark.padEnd(4)} ${what}`);
  console.log(`orrery agent ${version}: first-boot check`);
  let config: Config;
  try {
    config = load();
  } catch (err) {
    say('FAIL', `config: ${(err as Error).message}`);
    return false;
  }
  const { hub, server } = config;
  say('ok', `config: agent ${config.id}, hub ${hub.host}:${hub.port}, server ${server.id} (${server.unit}), mounts ${config.mounts.join(' ')}`);
  let ok = true;

  try {
    const sampler = new HostSampler(config.mounts, o.read ?? procReaders);
    await sampler.sample();
    await sleep(o.cpuMs ?? 1000);
    const s = (await sampler.sample())!;
    const disks = s.disks.map((d) => `${d.mount} ${gb(d.free)} of ${gb(d.total)} GB free`).join(', ');
    say('ok', `host: cpu ${Math.round(s.cpu * 100)}%, load ${s.load.join(' ')}, memory ${gb(s.memory.used)} of ${gb(s.memory.total)} GB used; ${disks}`);
    if (s.disks.length !== config.mounts.length) {
      say('FAIL', 'host: a mount in "mounts" can\'t be read');
      ok = false;
    }
  } catch (err) {
    say('FAIL', `host: ${(err as Error).message}`);
    ok = false;
  }

  const status = await rconStatus(config, o.rconWaitMs ?? 300_000, o.retryMs ?? 5000);
  if (typeof status === 'string') {
    say('FAIL', `rcon: 127.0.0.1:${server.rconPort}: ${status}`);
    ok = false;
  } else {
    const mods = Object.entries(status.mods).map(([name, v]) => `${name} ${v}`).join(', ');
    say('ok', `rcon: Factorio ${status.version}, tick ${status.tick}, ${status.players.length} online; mods: ${mods}`);
  }

  const why = await reach(hub.host, hub.port, o.hubWaitMs ?? 5000);
  if (why === null) say('ok', `hub: ${hub.host}:${hub.port} answers`);
  else say('warn', `hub: can't reach ${hub.host}:${hub.port} (${why}); fine before the hub listens`);
  return ok;
}

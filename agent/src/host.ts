import { readFile, statfs } from 'node:fs/promises';
import type { HostSample } from '../../hub/src/types.ts';

/** Where host numbers come from, passed in so tests need no real machine. */
export type HostReaders = {
  /** A file under /proc, as text. */
  proc: (name: 'stat' | 'loadavg' | 'meminfo') => Promise<string>;
  /** A mount's bytes: free to unprivileged users, and total; null if it can't be read. */
  disk: (mount: string) => Promise<{ free: number; total: number } | null>;
};

/** This machine: the whole VM, the friend's other software included. */
export const procReaders: HostReaders = {
  proc: (name) => readFile(`/proc/${name}`, 'utf8'),
  disk: async (mount) => {
    try {
      const s = await statfs(mount);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      return null;
    }
  },
};

const finite = (values: number[], what: string): number[] => {
  if (values.some((n) => !Number.isFinite(n))) throw new Error(`can't read ${what}`);
  return values;
};

/**
 * CPU time since boot from `/proc/stat`'s first line, all cores together, in clock ticks: idle (iowait counted as
 * idle) and total (user to steal; guest time is already in user).
 */
export function cpuTimes(stat: string): { idle: number; total: number } {
  const line = /^cpu\s+(.*)$/m.exec(stat)?.[1];
  const fields = line?.trim().split(/\s+/).map(Number) ?? [];
  if (fields.length < 4) throw new Error("can't read /proc/stat");
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = finite(fields, '/proc/stat');
  return { idle: idle! + iowait, total: user! + nice! + system! + idle! + iowait + irq + softirq + steal };
}

/** The 1, 5 and 15-minute load averages from `/proc/loadavg`. */
export function loadAverages(loadavg: string): number[] {
  const load = finite(loadavg.trim().split(/\s+/).slice(0, 3).map(Number), '/proc/loadavg');
  if (load.length !== 3) throw new Error("can't read /proc/loadavg");
  return load;
}

/** Bytes of memory from `/proc/meminfo`: in use (total less available) and total. */
export function memoryUse(meminfo: string): { used: number; total: number } {
  const kB = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(meminfo)?.[1] ?? NaN) * 1024;
  const [total, available] = finite([kB('MemTotal'), kB('MemAvailable')], '/proc/meminfo');
  return { used: total! - available!, total: total! };
}

/**
 * Host samples of this machine, in the hub's `HostSample` shape: CPU use between two readings of `/proc/stat`,
 * the load averages, memory, and each configured mount's disk (a mount that can't be read is left out, and logged).
 */
export class HostSampler {
  #mounts: string[];
  #read: HostReaders;
  #cpu: { idle: number; total: number } | null = null;

  constructor(mounts: string[], read: HostReaders = procReaders) {
    this.#mounts = mounts;
    this.#read = read;
  }

  /** A sample since the previous call; the first call only takes the CPU reading and returns null. */
  async sample(now = Date.now()): Promise<HostSample | null> {
    const cpu = cpuTimes(await this.#read.proc('stat'));
    const before = this.#cpu;
    this.#cpu = cpu;
    if (!before) return null;
    const elapsed = cpu.total - before.total;
    const busy = elapsed - (cpu.idle - before.idle);
    const load = loadAverages(await this.#read.proc('loadavg'));
    const memory = memoryUse(await this.#read.proc('meminfo'));
    const disks: HostSample['disks'] = [];
    for (const mount of this.#mounts) {
      const space = await this.#read.disk(mount);
      if (space) disks.push({ mount, ...space });
      else console.error(`[host] can't read the disk of ${mount}`);
    }
    return { ts: now, cpu: elapsed > 0 ? Math.min(1, Math.max(0, busy / elapsed)) : 0, load, memory, disks };
  }
}

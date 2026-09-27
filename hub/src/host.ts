import { readFile, statfs } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import type { HostIntegration } from './config.ts';
import type { Db } from './db.ts';
import type { HostSample, ServerHub } from './servers.ts';

const GB = 1024 ** 3;

/** Where host numbers come from, passed in so tests need no real machine. */
export type HostReaders = {
  /** CPU time since boot, all cores together: idle and total, in any one unit. */
  cpu: () => { idle: number; total: number };
  /** The 1, 5 and 15-minute load averages. */
  load: () => number[];
  /** Bytes of memory: total, and available to start new work without swapping. */
  memory: () => Promise<{ total: number; available: number }>;
  /** A mount's bytes: free to unprivileged users, and total. */
  disk: (mount: string) => Promise<{ free: number; total: number }>;
};

/** The machine the hub runs on, from Node built-ins and `/proc`. */
export const localHost: HostReaders = {
  cpu: () =>
    cpus().reduce(
      (sum, { times: t }) => ({ idle: sum.idle + t.idle, total: sum.total + t.user + t.nice + t.sys + t.idle + t.irq }),
      { idle: 0, total: 0 },
    ),
  load: loadavg,
  memory: async () => {
    const info = await readFile('/proc/meminfo', 'utf8');
    const kB = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(info)?.[1] ?? 0) * 1024;
    return { total: kB('MemTotal'), available: kB('MemAvailable') };
  },
  disk: async (mount) => {
    const s = await statfs(mount);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  },
};

/**
 * Samples the host once a minute into the database and onto the event stream. Warns (once, then once when it
 * clears) when memory use stays at or over the limit for `memoryMinutes` samples, and when a mount runs low on
 * disk. Hub core.
 */
export class HostMonitor {
  #hub: Pick<ServerHub, 'publishTarget'>;
  #db: Db;
  #cfg: HostIntegration;
  #read: HostReaders;
  #cpu: { idle: number; total: number } | undefined;
  #latest: HostSample | null = null;
  #highMemory = 0; // consecutive samples at or over the limit
  #memoryWarned = false;
  #lowDisks = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(hub: Pick<ServerHub, 'publishTarget'>, db: Db, cfg: HostIntegration, read: HostReaders) {
    this.#hub = hub;
    this.#db = db;
    this.#cfg = cfg;
    this.#read = read;
  }

  /** The first sample comes after `intervalMs`: CPU use is measured between two readings. */
  start(intervalMs = 60_000): void {
    this.#cpu = this.#read.cpu();
    this.#timer = setInterval(() => void this.#sample().catch((err) => console.error('[host] sample failed:', err)), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  latest(): HostSample | null {
    return this.#latest;
  }

  async #sample(): Promise<void> {
    const cpu = this.#read.cpu();
    const busy = cpu.total - this.#cpu!.total - (cpu.idle - this.#cpu!.idle);
    const elapsed = cpu.total - this.#cpu!.total;
    this.#cpu = cpu;
    const memory = await this.#read.memory();
    const disks: HostSample['disks'] = [];
    for (const mount of this.#cfg.mounts) {
      try {
        disks.push({ mount, ...(await this.#read.disk(mount)) });
      } catch (err) {
        console.error(`[host] reading disk ${mount} failed:`, (err as Error).message);
      }
    }
    const sample: HostSample = {
      ts: Date.now(),
      cpu: elapsed > 0 ? busy / elapsed : 0,
      load: this.#read.load(),
      memory: { used: memory.total - memory.available, total: memory.total },
      disks,
    };
    this.#latest = sample;
    this.#db.recordHostSample(this.#cfg.id, sample);
    const at = { target: 'host', id: this.#cfg.id, type: 'notice' } as const;
    this.#hub.publishTarget({ target: 'host', id: this.#cfg.id, type: 'sample', sample });

    const percent = Math.round((sample.memory.used / sample.memory.total) * 100);
    this.#highMemory = percent >= this.#cfg.memoryMaxPercent ? this.#highMemory + 1 : 0;
    if (this.#highMemory >= this.#cfg.memoryMinutes && !this.#memoryWarned) {
      this.#memoryWarned = true;
      this.#hub.publishTarget({ ...at, severity: 'warning', kind: 'memoryHigh', percent, minutes: this.#cfg.memoryMinutes });
    } else if (this.#highMemory === 0 && this.#memoryWarned) {
      this.#memoryWarned = false;
      this.#hub.publishTarget({ ...at, severity: 'good', kind: 'memoryOk', percent });
    }
    for (const { mount, free } of disks) {
      if (free < this.#cfg.diskMinFreeGB * GB) {
        if (this.#lowDisks.has(mount)) continue;
        this.#lowDisks.add(mount);
        this.#hub.publishTarget({ ...at, severity: 'warning', kind: 'diskLow', mount, free, minFreeGB: this.#cfg.diskMinFreeGB });
      } else if (this.#lowDisks.delete(mount)) {
        this.#hub.publishTarget({ ...at, severity: 'good', kind: 'diskOk', mount, free });
      }
    }
  }
}

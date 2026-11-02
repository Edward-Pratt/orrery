// `Hosts`: every Host the hub knows, a `HostMonitor` each in the order added (`add(cfg)` with that host's limits, ids
// unique; `get(id)`, `list()`), the hub's own first. `HostMonitor.record(sample)` stores a sample (`host_samples`,
// keyed by host id; `history(hours)` reads it back: the raw minutes up to 25 hours, else averaged into at most
// `HISTORY_POINTS` (1500) time buckets of `bucketMs(hours)`), puts it on the stream as a `sample` target event, and
// warns once / recovers once on memory high for `memoryMinutes` and on a low mount (a Host with no mounts in config,
// an Agent's, watches the first `LIMITS.disks` (32) mounts its samples name, and tells each one's change at most once
// per `DISK_NOTICE_MS` (10 min), a change meanwhile told at the first sample after the wait if it still holds). Only
// the hub's own host samples itself (`start(read)`): once a minute CPU (between two readings), load, memory and each
// mount's disk through `HostReaders` (`localHost`: `node:os`, `/proc/meminfo`, and `diskSpace` from `backups.ts`);
// other hosts' samples are reported to it through `record` (an Agent's by `Agents`, at most one per 10 s, stamped
// with the hub's clock, which is then the only clock any stored sample has). Hub core.

import { readFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { diskSpace } from './backups.ts';
import type { HostIntegration } from './config.ts';
import type { Db } from './db.ts';
import { LIMITS } from './protocol.ts';
import type { HostSample, ServerHub } from './servers.ts';

const GB = 1024 ** 3;
/**
 * How long a mount of a Host with no mounts in config (an Agent's: its samples name them) waits after a disk notice
 * before its next: a change meanwhile is told at the first sample after the wait, if it still holds.
 */
export const DISK_NOTICE_MS = 10 * 60_000;
/** The most samples `history` returns: a longer period (over 25 hours of minutes) is averaged into this many buckets. */
export const HISTORY_POINTS = 1500;

/** The width of a history bucket for a period of `hours`, in whole minutes; one minute means the raw samples fit. */
export const bucketMs = (hours: number) => Math.ceil((hours * 60) / HISTORY_POINTS) * 60_000;

/** Where host numbers come from, passed in so tests need no real machine. */
export type HostReaders = {
  /** CPU time since boot, all cores together: idle and total, in any one unit. */
  cpu: () => { idle: number; total: number };
  /** The 1, 5 and 15-minute load averages. */
  load: () => number[];
  /** Bytes of memory: total, and available to start new work without swapping. */
  memory: () => Promise<{ total: number; available: number }>;
  /** A mount's bytes: free to unprivileged users, and total; null if it can't be read. */
  disk: (mount: string) => Promise<{ free: number; total: number } | null>;
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
  disk: diskSpace, // the backup watcher's low-disk reading
};

/**
 * One host's samples: each is stored into the database and put on the event stream (`record`). Warns (once, then once
 * when it clears) when memory use stays at or over the limit for `memoryMinutes` samples, and when a mount runs low
 * on disk. Only the hub's own host samples itself, once a minute (`start`); other hosts' samples are reported to the
 * hub. A Host with no mounts in config (an Agent's) watches the first `LIMITS.disks` (32) mounts its samples name, and
 * tells each one's changes at most once per `DISK_NOTICE_MS` (10 min), so what a sample names can't flood the alerts.
 * Hub core.
 */
export class HostMonitor {
  #hub: Pick<ServerHub, 'publishTarget'>;
  #db: Db;
  #cfg: HostIntegration;
  #cpu: { idle: number; total: number } | undefined;
  #latest: HostSample | null = null;
  #highMemory = 0; // consecutive samples at or over the limit
  #memoryWarned = false;
  /** Each watched mount: whether it was last told as low, and when (the hub's clock). */
  #disks = new Map<string, { low: boolean; at: number }>();
  #timer: NodeJS.Timeout | undefined;

  constructor(hub: Pick<ServerHub, 'publishTarget'>, db: Db, cfg: HostIntegration) {
    this.#hub = hub;
    this.#db = db;
    this.#cfg = cfg;
  }

  get id(): string {
    return this.#cfg.id;
  }

  /** Samples the hub's own host through `read`. The first sample comes after `intervalMs`: CPU use is measured between two readings. */
  start(read: HostReaders, intervalMs = 60_000): void {
    this.#cpu = read.cpu();
    this.#timer = setInterval(
      () => void this.#sample(read).then((sample) => this.record(sample)).catch((err) => console.error('[host] sample failed:', err)),
      intervalMs,
    );
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  latest(): HostSample | null {
    return this.#latest;
  }

  /** The samples of the last `hours`, oldest first. */
  history(hours: number): HostSample[] {
    const since = Date.now() - hours * 3600_000;
    // ponytail: reads and parses every sample, up to 129,600 for 90 days; aggregate in SQL if that gets slow.
    const samples = this.#db.hostSamples(this.#cfg.id, since);
    const width = bucketMs(hours);
    if (width <= 60_000) return samples; // one a minute already fits
    const buckets = new Map<number, HostSample[]>();
    for (const s of samples) {
      const i = Math.min(Math.floor((s.ts - since) / width), HISTORY_POINTS - 1);
      if (buckets.has(i)) buckets.get(i)!.push(s);
      else buckets.set(i, [s]);
    }
    return [...buckets.values()].map(average);
  }

  /** A new sample of this host: stored, streamed, then checked against the memory and disk limits. */
  record(sample: HostSample): void {
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
    const reported = this.#cfg.mounts.length === 0; // an Agent's Host: its samples name its mounts
    for (const { mount, free } of sample.disks) {
      const low = free < this.#cfg.diskMinFreeGB * GB;
      let disk = this.#disks.get(mount);
      if (!disk) {
        if (reported && this.#disks.size >= LIMITS.disks) continue; // the first 32 it named only
        this.#disks.set(mount, (disk = { low: false, at: -Infinity }));
      }
      if (low === disk.low) continue;
      const now = Date.now();
      if (reported && now - disk.at < DISK_NOTICE_MS) continue;
      Object.assign(disk, { low, at: now });
      if (low) this.#hub.publishTarget({ ...at, severity: 'warning', kind: 'diskLow', mount, free, minFreeGB: this.#cfg.diskMinFreeGB });
      else this.#hub.publishTarget({ ...at, severity: 'good', kind: 'diskOk', mount, free });
    }
  }

  /** A sample of the hub's own host: CPU use since the last one, its configured mounts. */
  async #sample(read: HostReaders): Promise<HostSample> {
    const cpu = read.cpu();
    const busy = cpu.total - this.#cpu!.total - (cpu.idle - this.#cpu!.idle);
    const elapsed = cpu.total - this.#cpu!.total;
    this.#cpu = cpu;
    const memory = await read.memory();
    const disks: HostSample['disks'] = [];
    for (const mount of this.#cfg.mounts) {
      const space = await read.disk(mount);
      if (space) disks.push({ mount, ...space });
      else console.error(`[host] reading disk ${mount} failed`);
    }
    return {
      ts: Date.now(),
      cpu: elapsed > 0 ? busy / elapsed : 0,
      load: read.load(),
      memory: { used: memory.total - memory.available, total: memory.total },
      disks,
    };
  }
}

/** Every Host the hub knows, a `HostMonitor` each, in the order added (the hub's own first). Hub core. */
export class Hosts {
  #hub: Pick<ServerHub, 'publishTarget'>;
  #db: Db;
  #monitors = new Map<string, HostMonitor>();

  constructor(hub: Pick<ServerHub, 'publishTarget'>, db: Db) {
    this.#hub = hub;
    this.#db = db;
  }

  /** A monitor for a host with its own limits; ids are unique. */
  add(cfg: HostIntegration): HostMonitor {
    if (this.#monitors.has(cfg.id)) throw new Error(`host ${cfg.id} is already known`);
    const monitor = new HostMonitor(this.#hub, this.#db, cfg);
    this.#monitors.set(cfg.id, monitor);
    return monitor;
  }

  get(id: string): HostMonitor | undefined {
    return this.#monitors.get(id);
  }

  list(): HostMonitor[] {
    return [...this.#monitors.values()];
  }
}

const mean = <T>(of: T[], f: (x: T) => number) => of.reduce((sum, x) => sum + f(x), 0) / of.length;

/** One sample from several: every number averaged, each mount's over the samples that have it. */
function average(bucket: HostSample[]): HostSample {
  const mounts = [...new Set(bucket.flatMap((s) => s.disks.map((d) => d.mount)))];
  return {
    ts: Math.round(mean(bucket, (s) => s.ts)),
    cpu: mean(bucket, (s) => s.cpu),
    load: bucket[0].load.map((_, i) => mean(bucket, (s) => s.load[i])),
    memory: { used: mean(bucket, (s) => s.memory.used), total: mean(bucket, (s) => s.memory.total) },
    disks: mounts.map((mount) => {
      const of = bucket.flatMap((s) => s.disks.filter((d) => d.mount === mount));
      return { mount, free: mean(of, (d) => d.free), total: mean(of, (d) => d.total) };
    }),
  };
}

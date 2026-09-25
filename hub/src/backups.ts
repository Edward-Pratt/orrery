import { lstat, readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { formatBytes } from './units.ts';

export type Backup = { name: string; size: number; mtimeMs: number };

/** ServerUtilities' backup names: "<YYYY-MM-DD-HH-MM-SS>.zip", moved into place atomically when finished. */
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}.*\.zip$/;
const WATCHDOG_MS = 10 * 60_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;

/** Finished backups in a folder, newest first. Skips staging files, folders and symlinks; never throws. */
export async function listBackups(dir: string): Promise<Backup[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found: Backup[] = [];
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue;
    try {
      const st = await lstat(join(dir, name));
      if (st.isFile()) found.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // deleted between readdir and lstat (e.g. old backups being pruned)
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Bytes per day from the oldest backup to the newest (negative if shrinking); null if under a day apart. */
export function growthPerDay(backups: Backup[]): number | null {
  const newest = backups[0];
  const oldest = backups.at(-1);
  if (!newest || !oldest) return null;
  const days = (newest.mtimeMs - oldest.mtimeMs) / DAY;
  return days < 1 ? null : (newest.size - oldest.size) / days;
}

/** Free bytes (for non-root users) on the filesystem holding `dir`; null if it can't be read. Never throws. */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export type BackupStats = { count: number; total: number; free: number | null; growth: number | null };

/** Count, total size, free space and growth; null if `dir` isn't a folder (no backups line at all). Never throws. */
export async function backupStats(dir: string): Promise<BackupStats | null> {
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) return null;
  const backups = await listBackups(dir);
  return {
    count: backups.length,
    total: backups.reduce((sum, b) => sum + b.size, 0),
    free: await freeBytes(dir),
    growth: growthPerDay(backups),
  };
}

/** The notice for a backup event from the mod (ServerUtilities' own "done"/"failed" log lines). */
export function backupNotice(ok: boolean, detail: string): string {
  return ok ? `✅ Backup finished (${detail})` : `❌ Backup failed: ${detail}`;
}

/**
 * Warns when backups stop appearing in a backup folder, and when its disk runs low. (Finish and failure notices
 * come from the mod's backup events.) Hub core (plain-text notices); `list` and `free` are injected so tests
 * needn't touch disk.
 */
export class BackupWatcher {
  #list: (serverId: string) => Promise<Backup[]>;
  #free: (serverId: string) => Promise<number | null>;
  #notify: (serverId: string, text: string) => void;
  #watchdogs = new Map<string, NodeJS.Timeout>();
  #overdue = new Set<string>();
  #lowDisk = new Set<string>();

  constructor(
    list: (serverId: string) => Promise<Backup[]>,
    free: (serverId: string) => Promise<number | null>,
    notify: (serverId: string, text: string) => void,
  ) {
    this.#list = list;
    this.#free = free;
    this.#notify = notify;
  }

  /**
   * Every 10 minutes: warn once if the newest backup is older than `maxAgeHours` (when set), and once if free
   * space is under `minFreeGB`. Each re-arms when the problem clears.
   */
  watchdog(serverId: string, limits: { maxAgeHours?: number; minFreeGB: number }): void {
    clearInterval(this.#watchdogs.get(serverId));
    const check = async () => {
      if (limits.maxAgeHours !== undefined) {
        const newest = (await this.#list(serverId))[0];
        const age = newest ? Date.now() - newest.mtimeMs : Infinity;
        if (age <= limits.maxAgeHours * HOUR) {
          this.#overdue.delete(serverId);
        } else if (!this.#overdue.has(serverId)) {
          this.#overdue.add(serverId);
          this.#notify(
            serverId,
            newest ? `⚠️ No new backup for ${Math.floor(age / HOUR)} h (newest: ${newest.name})` : '⚠️ No backups found',
          );
        }
      }
      const free = await this.#free(serverId);
      if (free === null) return;
      if (free >= limits.minFreeGB * GB) {
        this.#lowDisk.delete(serverId);
      } else if (!this.#lowDisk.has(serverId)) {
        this.#lowDisk.add(serverId);
        this.#notify(serverId, `⚠️ Low disk space for backups: ${formatBytes(free)} free (limit ${limits.minFreeGB} GB)`);
      }
    };
    this.#watchdogs.set(serverId, setInterval(() => void check(), WATCHDOG_MS));
  }

  /** Clears every timer (hub shutdown). */
  stop(): void {
    for (const timer of this.#watchdogs.values()) clearInterval(timer);
    this.#watchdogs.clear();
  }
}

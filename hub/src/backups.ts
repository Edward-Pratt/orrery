import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type Backup = { name: string; size: number; mtimeMs: number };

/** ServerUtilities' backup names: "<YYYY-MM-DD-HH-MM-SS>.zip", moved into place atomically when finished. */
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}.*\.zip$/;
const WATCHDOG_MS = 10 * 60_000;
const HOUR = 60 * 60_000;

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

/** The notice for a backup event from the mod (ServerUtilities' own "done"/"failed" log lines). */
export function backupNotice(ok: boolean, detail: string): string {
  return ok ? `✅ Backup finished (${detail})` : `❌ Backup failed: ${detail}`;
}

/**
 * Warns when backups stop appearing in a backup folder. (Finish and failure notices come from the mod's backup
 * events.) Hub core (plain-text notices); `list` is injected so tests needn't touch disk.
 */
export class BackupWatcher {
  #list: (serverId: string) => Promise<Backup[]>;
  #notify: (serverId: string, text: string) => void;
  #watchdogs = new Map<string, NodeJS.Timeout>();
  #overdue = new Set<string>();

  constructor(list: (serverId: string) => Promise<Backup[]>, notify: (serverId: string, text: string) => void) {
    this.#list = list;
    this.#notify = notify;
  }

  /** Every 10 minutes, warn once if the newest backup is older than `maxAgeHours`; re-arms after a new one. */
  watchdog(serverId: string, maxAgeHours: number): void {
    clearInterval(this.#watchdogs.get(serverId));
    const check = async () => {
      const newest = (await this.#list(serverId))[0];
      const age = newest ? Date.now() - newest.mtimeMs : Infinity;
      if (age <= maxAgeHours * HOUR) {
        this.#overdue.delete(serverId);
      } else if (!this.#overdue.has(serverId)) {
        this.#overdue.add(serverId);
        this.#notify(
          serverId,
          newest ? `⚠️ No new backup for ${Math.floor(age / HOUR)} h (newest: ${newest.name})` : '⚠️ No backups found',
        );
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

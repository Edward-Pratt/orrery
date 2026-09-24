import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Discord's upload limit is 10 MB; stay under it. */
const MAX_BYTES = 8 * 1024 * 1024;

async function newest(dir: string, match: (name: string) => boolean, sinceMs: number): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null; // no such folder (e.g. no crash has ever happened)
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!match(name)) continue;
    const path = join(dir, name);
    try {
      const st = await lstat(path); // lstat: a symlink (e.g. to the hub's .env) is not a file and is skipped
      if (!st.isFile() || st.size > MAX_BYTES || st.mtimeMs < sinceMs) continue;
      if (!best || st.mtimeMs > best.mtime) best = { path, mtime: st.mtimeMs };
    } catch {
      // deleted between readdir and stat
    }
  }
  return best?.path ?? null;
}

/**
 * The newest Minecraft crash report and the newest JVM crash log (hs_err_pid*.log) in a server folder,
 * each only if written at or after `sinceMs` and small enough to upload. Returns 0–2 paths; never throws.
 */
export async function findCrashLogs(serverDir: string, sinceMs: number): Promise<string[]> {
  const found = await Promise.all([
    newest(join(serverDir, 'crash-reports'), (n) => n.endsWith('.txt'), sinceMs),
    newest(serverDir, (n) => /^hs_err_pid\d+\.log$/.test(n), sinceMs),
  ]);
  return found.filter((p): p is string => p !== null);
}

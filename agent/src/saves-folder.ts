// Factorio's `saves/` folder as `Saves` reads and writes it: listing, pruning, the sweep at `start`, and a save made
// and waited for. Every operation goes through the folder opened once (`within`: `O_DIRECTORY`, `O_NOFOLLOW`) as
// `/proc/self/fd/<fd>/<name>`, since the container could swap `saves/` for a symlink; a file counts only if `lstat`
// finds a regular file on that folder's filesystem. `listSaves`: every `*.zip` but a name with a control character
// (not `printable`: a newline in one would forge a log line), newest first, 500 at most, its `kind` (`kindOf`) and
// `current` on the file whose path the last `Loading map` engine line in `factorio-current.log` (its first 1 MiB)
// names (`loadedMap`), with the bytes free there. `pruneSaves` (after each save and restore): the newest 20 named and 3
// world files stay, never the current world nor a name `hold` keeps for a running update (`release`); autosaves are
// Factorio's. `sweepPartials` (`start`, before the first listing) removes every partial file (a restore's, a `keep`'s
// or an upload's: `PARTIAL`) (a regular one, its name printable) left by a copy the agent's exit cut short
// (`process.exit` skips that `finally`), since neither the list nor pruning sees one; no restore of this agent runs
// yet. `makeSave`: `/orrery-save <name>.zip` (the `.zip` in the command, as Factorio makes whatever follows a name's
// last `.` its extension: `orrery-pre-update-2.1.24-<time>` alone is written as `orrery-pre-update-2.1.zip`), then
// `waitWritten` until the file is a regular file whose size and time held 5 s, 5 minutes at most (an `RconNoAnswer`
// from a big map's save still waits for the file: it was sent; a command never sent fails at once).
import { constants, lstat, open, readdir, statfs, unlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Save } from '../../hub/src/types.ts';
import { head } from './files.ts';
import { RconNoAnswer } from './rcon.ts';
import { HEAD_MAX, KEEP_NAMED, KEEP_WORLD, PARTIAL, kindOf, loadedMap, past, saved, span, type SavesMsg, type SavesOptions } from './saves-rules.ts';
import { LIMITS, printable } from './wire.ts';

/** `fn` on the saves folder opened once: `base` names it whatever its path points at later, `dev` is its filesystem. */
export async function within<T>(path: string, fn: (base: string, dev: number) => Promise<T>): Promise<T> {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return await fn(`/proc/self/fd/${dir.fd}`, (await dir.stat()).dev);
  } finally {
    await dir.close();
  }
}

/** The folder now: every `*.zip` that is a regular file, newest first, and the bytes free there. */
export async function listSaves(dir: string, log: string): Promise<SavesMsg> {
  const loaded = loadedMap((await head(log, HEAD_MAX)) ?? '');
  const current = loaded !== null && posix.dirname(posix.normalize(loaded)) === dir ? posix.basename(loaded) : null;
  return within(dir, async (base, dev) => {
    const saves: Save[] = [];
    for (const name of await readdir(base)) {
      // A name with a control character (a newline: a forged log line) is no save: Factorio and the agent make none.
      if (!name.endsWith('.zip') || name.length > LIMITS.text || printable(name) !== name) continue;
      const st = await lstat(`${base}/${name}`).catch(() => null); // lstat: a symlink is not a file
      if (!st?.isFile() || st.dev !== dev) continue;
      saves.push({ name, size: st.size, mtime: Math.round(st.mtimeMs), kind: kindOf(name), current: name === current });
    }
    saves.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : 1));
    const fs = await statfs(base);
    return { saves: saves.slice(0, LIMITS.saves), free: fs.bavail * fs.bsize };
  });
}

/** Keeps the newest 20 named saves and 3 world files, and every current or held one. */
export async function pruneSaves(dir: string, list: () => Promise<SavesMsg>, held: ReadonlySet<string>): Promise<void> {
  let saves: Save[];
  try {
    saves = (await list()).saves;
  } catch (err) {
    return console.error(`[saves] can't prune: ${(err as Error).message}`);
  }
  const doomed = [...past(saves, 'named', KEEP_NAMED), ...past(saves, 'world', KEEP_WORLD)].filter((s) => !s.current && !held.has(s.name));
  if (doomed.length === 0) return;
  await within(dir, async (base) => {
    for (const s of doomed) {
      try {
        await unlink(`${base}/${s.name}`);
        console.log(`[saves] pruned ${printable(s.name)}`);
      } catch (err) {
        console.error(`[saves] can't prune ${printable(s.name)}: ${printable((err as Error).message)}`);
      }
    }
  }).catch((err: Error) => console.error(`[saves] can't prune: ${err.message}`));
}

/**
 * Removes every partial copy a restore (or a `keep`) left when the agent exited during it (a restart or a crash: `process.exit`
 * skips its `finally`). No restore of this agent runs yet, and one started later takes a new name. Such a file is
 * no save, so neither the list nor pruning would ever see it.
 */
export async function sweepPartials(dir: string): Promise<void> {
  await within(dir, async (base, dev) => {
    for (const name of await readdir(base)) {
      if (!PARTIAL.test(name) || printable(name) !== name) continue;
      const st = await lstat(`${base}/${name}`).catch(() => null);
      if (!st?.isFile() || st.dev !== dev) continue;
      try {
        await unlink(`${base}/${name}`);
        console.log(`[saves] removed ${name}, left by a copy the agent's exit cut short`);
      } catch (err) {
        console.error(`[saves] can't remove ${name}: ${printable((err as Error).message)}`);
      }
    }
  }).catch((err: Error) => console.error(`[saves] can't look for partial restores: ${printable(err.message)}`));
}

/**
 * `/orrery-save <name>.zip`, then the wait for its file; resolves with the file's size. The `.zip` goes in the
 * command: Factorio makes whatever follows a name's last `.` its extension (`game.server_save`, seen on 2.1.24), so
 * `orrery-pre-update-2.1.24-<time>` alone would be written as `orrery-pre-update-2.1.zip`.
 */
export async function makeSave(o: Required<SavesOptions>, name: string): Promise<number> {
  const file = `${name}.zip`;
  try {
    const reply = await o.run(`/orrery-save ${file}`);
    if (!saved(reply, file)) throw new Error(`/orrery-save answered ${printable(JSON.stringify(reply.slice(0, 200)))}`);
  } catch (err) {
    // The save runs within the command's tick, so on a big map RCON's answer can come after its timeout: the command
    // was sent, so the file tells. One never sent (RCON not reached, or no auth answer) did not run: it fails now.
    if (!(err instanceof RconNoAnswer)) throw err;
  }
  return waitWritten(o, file);
}

/** Waits until `file` is a regular file whose size and time held for `stableMs`, for `waitMs` at most. */
export async function waitWritten(o: Required<SavesOptions>, file: string): Promise<number> {
  const { pollMs, stableMs, waitMs } = o;
  const until = performance.now() + waitMs;
  let seen: { size: number; mtime: number; at: number } | null = null;
  for (;;) {
    const st = await within(o.dir, (base, dev) => lstat(`${base}/${file}`).then((s) => (s.isFile() && s.dev === dev ? s : null), () => null));
    const t = performance.now();
    if (!st) seen = null;
    else if (!seen || st.size !== seen.size || st.mtimeMs !== seen.mtime) seen = { size: st.size, mtime: st.mtimeMs, at: t };
    else if (t - seen.at >= stableMs) return st.size;
    if (t >= until) throw new Error(seen ? `still being written after ${span(waitMs)}` : `did not appear within ${span(waitMs)}`);
    await sleep(pollMs);
  }
}

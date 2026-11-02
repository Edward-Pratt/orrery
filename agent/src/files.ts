// Files under the server's `data` folder, which the container writes (and may swap): opened without following a
// symlink or blocking on a FIFO, and read only from the open handle, only if it is a regular file on its folder's
// filesystem (agent/CLAUDE.md, "Trust boundaries").
//
// Files the container writes (and `deploy.ts`'s two files): `openPlain` (`O_NOFOLLOW`, `O_NONBLOCK`; only a regular
// file on its folder's device, read from the handle), `head` (its first bytes; none if last written before
// `freshAfter`, an earlier run's log), `tail` (its last lines, read back from the end, 4 MiB at most), `within(dir,
// fn)` (`fn` on the folder opened once, `O_DIRECTORY`/`O_NOFOLLOW`, as `/proc/self/fd/<fd>`) and `readIn(base, name)`
// (a plain file's text there, null when missing or not one, throwing over 1 MiB).
import type { Stats } from 'node:fs';
import { constants, open, stat, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

/** How far back from a file's end a tail reads at most, so one giant line can't fill the memory. */
const TAIL_BYTES = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;
/** The most a small config file read whole (`readIn`) may hold: far over any real one (a few KiB). */
const FILE_MAX = 1024 * 1024;

export type Plain = { fh: FileHandle; st: Stats };

/**
 * `path` opened for reading if it is a regular file (`O_NOFOLLOW`: not a symlink, even one swapped in since a listing;
 * `O_NONBLOCK`: a FIFO never blocks) on the same device as its folder; null if it is missing or not one. The caller
 * closes `fh`.
 */
export async function openPlain(path: string): Promise<Plain | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw err;
  }
  try {
    const [st, folder] = await Promise.all([fh.stat(), stat(dirname(path))]);
    if (st.isFile() && st.dev === folder.dev) return { fh, st };
  } catch (err) {
    await fh.close();
    throw err;
  }
  await fh.close();
  return null;
}

/**
 * The first `max` bytes of a plain file as text; null if it isn't one (or can't be read), or if it was last written
 * before `freshAfter` (epoch ms): a log of an earlier run.
 */
export async function head(path: string, max: number, freshAfter = -Infinity): Promise<string | null> {
  const file = await openPlain(path).catch(() => null);
  if (!file) return null;
  try {
    if (file.st.mtimeMs < freshAfter) return null;
    const buf = Buffer.alloc(Math.min(file.st.size, max));
    const { bytesRead } = await file.fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await file.fh.close();
  }
}

/**
 * The last `count` lines of a plain file, oldest first, read back from the end in chunks (at most 4 MiB): without
 * the whole file its first, cut-off line is dropped; a trailing `\r` is stripped. Null if it isn't a plain file.
 */
export async function tail(path: string, count: number): Promise<string[] | null> {
  const file = await openPlain(path);
  if (!file) return null;
  const { fh, st } = file;
  try {
    const chunks: Buffer[] = [];
    let pos = st.size;
    let newlines = 0;
    while (pos > 0 && st.size - pos < TAIL_BYTES && newlines <= count) {
      const length = Math.min(CHUNK, pos, TAIL_BYTES - (st.size - pos));
      pos -= length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await fh.read(chunk, 0, length, pos);
      const got = chunk.subarray(0, bytesRead);
      chunks.unshift(got);
      for (const byte of got) if (byte === 0x0a) newlines++;
    }
    const lines = Buffer.concat(chunks).toString('utf8').split('\n');
    if (pos > 0) lines.shift();
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-count).map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  } finally {
    await fh.close();
  }
}

/** `fn` on `dir` opened once (`O_DIRECTORY`, `O_NOFOLLOW`): a folder the container swapped for a link is refused. */
export async function within<T>(dir: string, fn: (base: string) => Promise<T>): Promise<T> {
  const fh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return await fn(`/proc/self/fd/${fh.fd}`);
  } finally {
    await fh.close();
  }
}

/** A plain file's text in an opened folder (`files.ts`'s `openPlain`): null when missing or not a regular file; throws over 1 MiB. */
export async function readIn(base: string, name: string): Promise<string | null> {
  const file = await openPlain(`${base}/${name}`);
  if (!file) return null;
  try {
    if (file.st.size > FILE_MAX) throw new Error(`${name} is over 1 MiB`);
    const buf = Buffer.alloc(file.st.size);
    const { bytesRead } = await file.fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.fh.close();
  }
}

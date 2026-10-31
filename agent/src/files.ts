// Files under the server's `data` folder, which the container writes (and may swap): opened without following a
// symlink or blocking on a FIFO, and read only from the open handle, only if it is a regular file on its folder's
// filesystem (agent/CLAUDE.md, "Trust boundaries").
import type { Stats } from 'node:fs';
import { constants, open, stat, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

/** How far back from a file's end a tail reads at most, so one giant line can't fill the memory. */
const TAIL_BYTES = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;

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

/** The first `max` bytes of a plain file as text; null if it isn't one (or can't be read). */
export async function head(path: string, max: number): Promise<string | null> {
  const file = await openPlain(path).catch(() => null);
  if (!file) return null;
  try {
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

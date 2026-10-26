import { constants } from 'node:fs';
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { CRASH_LOCATIONS } from './crashlogs.ts';
import type { LogFile } from './types.ts';
export type { LogFile } from './types.ts';

/** How many lines a tail answers. */
export const TAIL_LINES = 1000;
/** The most of a file's end (decompressed, for `.gz`) a tail holds: one giant line can't fill the memory. */
const TAIL_BYTES = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;

/** The server's own logs, directly in `logs/`: `latest.log`, `fml-server-latest.log` and the rotated `*.log.gz`. */
const SOURCES: readonly { folder: string; match: (name: string) => boolean }[] = [
  { folder: 'logs', match: (n) => /\.log(\.gz)?$/.test(n) },
  ...CRASH_LOCATIONS,
];

type Found = LogFile & { path: string };

/** The plain files in one folder whose names match; symlinks and folders are skipped. Never throws. */
async function scan(dir: string, match: (name: string) => boolean): Promise<Found[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no such folder (e.g. no crash has ever happened)
  }
  const found: Found[] = [];
  for (const name of names) {
    if (!match(name)) continue;
    const path = join(dir, name);
    try {
      const st = await lstat(path); // lstat: a symlink (e.g. to the hub's config.json) is not a file and is skipped
      if (st.isFile()) found.push({ name, size: st.size, modified: st.mtimeMs, path });
    } catch {
      // deleted between readdir and lstat (e.g. a log being rotated)
    }
  }
  return found;
}

/** Every listed file with its path, newest first; a name in two folders is the first source's (`logs/` first). */
async function found(serverDir: string): Promise<Found[]> {
  const all = (await Promise.all(SOURCES.map((s) => scan(join(serverDir, s.folder), s.match)))).flat();
  const seen = new Set<string>();
  return all.filter((f) => !seen.has(f.name) && seen.add(f.name)).sort((a, b) => b.modified - a.modified);
}

/**
 * A server folder's readable logs, newest first: the files directly in `logs/` (`*.log`, `*.log.gz`) and its crash
 * reports (`crash-reports/*.txt`, `hs_err_pid*.log`). Never throws. Hub core.
 */
export async function listLogs(serverDir: string): Promise<LogFile[]> {
  return (await found(serverDir)).map(({ name, size, modified }) => ({ name, size, modified }));
}

/**
 * The last `TAIL_LINES` lines of a listed log, oldest first, a `.gz` decompressed. `name` is only looked up in the
 * folder's current listing, never joined into a path, so `..`, slashes and symlinks never reach the disk: undefined
 * for a name not listed (or gone since). Rejects if the file can't be read (e.g. a broken `.gz`).
 */
export async function tailLog(serverDir: string, name: string): Promise<string[] | undefined> {
  const file = (await found(serverDir)).find((f) => f.name === name);
  if (!file) return undefined;
  let fh: FileHandle;
  try {
    // O_NOFOLLOW: a symlink swapped in since the listing is refused, not followed.
    fh = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return undefined;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    const { bytes, whole } = name.endsWith('.gz') ? await tailGzip(fh) : await tailPlain(fh, st.size);
    return lastLines(bytes, whole);
  } finally {
    await fh.close();
  }
}

/** Reads back from the end in chunks until it holds more than `TAIL_LINES` line ends, the start, or `TAIL_BYTES`. */
async function tailPlain(fh: FileHandle, size: number): Promise<{ bytes: Buffer; whole: boolean }> {
  const chunks: Buffer[] = [];
  let pos = size;
  let newlines = 0;
  while (pos > 0 && size - pos < TAIL_BYTES && newlines <= TAIL_LINES) {
    const length = Math.min(CHUNK, pos, TAIL_BYTES - (size - pos));
    pos -= length;
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await fh.read(chunk, 0, length, pos);
    const got = chunk.subarray(0, bytesRead);
    chunks.unshift(got);
    for (const byte of got) if (byte === 0x0a) newlines++;
  }
  return { bytes: Buffer.concat(chunks), whole: pos === 0 };
}

/** Streams the whole file through gunzip, keeping only its last `TAIL_BYTES`. */
async function tailGzip(fh: FileHandle): Promise<{ bytes: Buffer; whole: boolean }> {
  const chunks: Buffer[] = [];
  let held = 0;
  let total = 0;
  await pipeline(fh.createReadStream({ autoClose: false }), createGunzip(), async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      chunks.push(chunk);
      held += chunk.length;
      total += chunk.length;
      while (held - chunks[0]!.length >= TAIL_BYTES) held -= chunks.shift()!.length;
    }
  });
  const bytes = Buffer.concat(chunks);
  return { bytes: bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)), whole: total <= TAIL_BYTES };
}

/** The last `TAIL_LINES` lines of a file's end; without the whole file its first, cut-off line is dropped. */
function lastLines(bytes: Buffer, whole: boolean): string[] {
  const lines = bytes.toString('utf8').split('\n');
  if (!whole) lines.shift();
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-TAIL_LINES).map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

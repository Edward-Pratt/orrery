// An uploaded file as a Factorio save, checked before it is stored: a zip whose entries all sit in one top folder with
// safe names, holding `level.dat0`, whose zlib stream starts with the Factorio version that wrote it.
import type { FileHandle } from 'node:fs/promises';
import { constants, inflateRawSync, inflateSync } from 'node:zlib';

/** The zip's end record is in its last 64 KiB plus its own 22 bytes (a comment is at most 65535 bytes). */
const EOCD_SEARCH = 65_535 + 22;
/** A central directory larger than this, or more entries, is no save of ours. */
const MAX_CD = 8 * 1024 * 1024;
export const MAX_ENTRIES = 20_000;
/** How much of `level.dat0` is read: its version is in the first 8 bytes once inflated. */
const HEAD = 64 * 1024;

export type SaveCheck = { ok: true; version: string } | { ok: false; reason: string };

const refuse = (reason: string): SaveCheck => ({ ok: false, reason });

async function read(fh: FileHandle, pos: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, pos + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return buf.subarray(0, done);
}

/** Whether a zip entry's name is a safe path: relative, `/`-separated, no empty, `.` or `..` part (a folder's trailing `/` aside). */
function safeName(name: string): boolean {
  if (name.length === 0 || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return false;
  const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

/**
 * Inflates the start of a stream: only its first `INPUT` bytes, so the output stays bounded (deflate expands at most
 * about 1032 to 1: 1 MiB here) without `maxOutputLength`, which throws rather than stopping; a cut stream is fine.
 */
const INPUT = 1024;
const partial = (inflate: typeof inflateSync, data: Buffer) => inflate(data.subarray(0, INPUT), { finishFlush: constants.Z_SYNC_FLUSH });

/**
 * Checks the open file of `size` bytes as a Factorio save: never trusting it, every read capped. The answer is the
 * version that wrote it, `X.Y.Z`, or why it isn't a save.
 */
export async function checkSave(fh: FileHandle, size: number): Promise<SaveCheck> {
  if (size < 22) return refuse('it is too small to be a zip');
  const tailLength = Math.min(size, EOCD_SEARCH);
  const tail = await read(fh, size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return refuse('it is not a zip');
  const disk = tail.readUInt16LE(eocd + 4);
  const entries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (disk !== 0) return refuse('it is a zip split over several files');
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return refuse('it is a ZIP64 zip, which Factorio does not write');
  if (entries === 0 || entries > MAX_ENTRIES) return refuse(`it has ${entries} entries`);
  if (cdSize > MAX_CD || cdOffset + cdSize > size) return refuse('its central directory is out of bounds');
  const cd = await read(fh, cdOffset, cdSize);

  let top: string | null = null;
  let level: { method: number; compSize: number; local: number } | null = null;
  for (let p = 0, n = 0; n < entries; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) return refuse('its central directory is malformed');
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    const mode = cd.readUInt32LE(p + 38) >>> 16;
    const local = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLength > cd.length) return refuse('its central directory is malformed');
    const name = cd.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    if (!safeName(name)) return refuse(`it holds an unsafe name: ${JSON.stringify(name.slice(0, 100))}`);
    if ((mode & 0o170000) === 0o120000) return refuse(`it holds a symbolic link: ${JSON.stringify(name.slice(0, 100))}`);
    const slash = name.indexOf('/');
    if (slash < 0) return refuse(`it holds a file outside a folder: ${JSON.stringify(name.slice(0, 100))}`);
    const folder = name.slice(0, slash);
    if (top === null) top = folder;
    else if (folder !== top) return refuse('its files are in more than one folder');
    if (name === `${folder}/level.dat0`) level = { method, compSize, local };
  }
  if (top === null || level === null) return refuse('it has no level.dat0: it is not a Factorio save');
  if (level.method !== 0 && level.method !== 8) return refuse('its level.dat0 is compressed in a way Factorio does not use');

  const header = await read(fh, level.local, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== 0x04034b50) return refuse('its level.dat0 entry is malformed');
  const start = level.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + level.compSize > size) return refuse('its level.dat0 entry is out of bounds');
  const raw = await read(fh, start, Math.min(level.compSize, HEAD));
  let data: Buffer;
  try {
    const stored = level.method === 0 ? raw : partial(inflateRawSync, raw);
    // Factorio writes level.dat0 as a zlib stream (78 01 …); an older save may hold it plain.
    data = stored[0] === 0x78 ? partial(inflateSync, stored) : stored;
  } catch {
    return refuse('its level.dat0 does not inflate');
  }
  if (data.length < 8) return refuse('its level.dat0 is too short');
  const [major, minor, patch] = [data.readUInt16LE(0), data.readUInt16LE(2), data.readUInt16LE(4)];
  if (major < 1 || major > 9) return refuse("its level.dat0 holds no Factorio version this agent can read");
  return { ok: true, version: `${major}.${minor}.${patch}` };
}

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b` (both `X.Y.Z`). */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

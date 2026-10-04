import { createHash, randomBytes, type Hash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const UPLOAD_MAX = 4 * 1024 ** 3;
export const CHUNK_MAX = 64 * 1024 ** 2;
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const NAME_MAX = 200;

/** A finished upload: its file, now the taker's. */
export type Upload = { path: string; fileName: string; size: number; sha256: string };

/** A refused upload request: its status, and `received` (for a 409) so the client can resume. */
export class UploadRefused extends Error {
  readonly status: 400 | 404 | 409 | 413;
  readonly received: number | undefined;
  constructor(status: 400 | 404 | 409 | 413, message: string, received?: number) {
    super(message);
    this.status = status;
    this.received = received;
  }
}

/** `hash` holds the bytes received so far: each chunk hashes into a copy, kept only when the chunk is. */
type Entry = { path: string; fileName: string; size: number; received: number; hash: Hash; sha256?: string; writing: boolean; timer?: NodeJS.Timeout };

/**
 * Chunked uploads to `<dir>`: created with a name and size (≤ 4 GiB), filled by chunks (≤ 64 MiB) appended in order,
 * hashed as they arrive, then taken once as a source or an Extra. Dropped `idleMs` after their last chunk; wiped at start.
 */
export class Uploads {
  #dir: string;
  #idleMs: number;
  #all = new Map<string, Entry>();

  constructor(dir: string, idleMs = 60 * 60_000) {
    this.#dir = dir;
    this.#idleMs = idleMs;
  }

  async start(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true });
  }

  stop(): void {
    for (const e of this.#all.values()) clearTimeout(e.timer);
  }

  async create(fileName: unknown, size: unknown): Promise<string> {
    if (!Number.isInteger(size) || (size as number) < 0 || (size as number) > UPLOAD_MAX) throw new UploadRefused(400, 'Give the size in bytes, at most 4 GiB.');
    await mkdir(this.#dir, { recursive: true });
    const id = randomBytes(16).toString('hex');
    const path = join(this.#dir, id);
    await writeFile(path, '');
    const name = basename(typeof fileName === 'string' ? fileName : '').slice(0, NAME_MAX) || 'upload';
    const e: Entry = { path, fileName: name, size: size as number, received: 0, hash: createHash('sha256'), writing: false };
    this.#all.set(id, e);
    this.#touch(id, e);
    if (e.size === 0) e.sha256 = e.hash.digest('hex');
    return id;
  }

  /** How much has arrived; at `size` the upload is ready. */
  received(id: string): number {
    return this.#get(id).received;
  }

  /** Appends `body` at `offset`, which must be the bytes received so far; a failed chunk leaves nothing behind. */
  async append(id: string, offset: number, body: ReadableStream<Uint8Array> | null): Promise<number> {
    const e = this.#get(id);
    if (e.writing || offset !== e.received || e.sha256) throw new UploadRefused(409, `The upload has ${e.received} bytes.`, e.received);
    const max = Math.min(CHUNK_MAX, e.size - offset);
    e.writing = true;
    const hash = e.hash.copy();
    let n = 0;
    const count = new Transform({
      transform(chunk: Buffer, _, done) {
        n += chunk.length;
        if (n > max) return done(new UploadRefused(413, `A chunk is at most ${max} bytes here.`));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(body ? Readable.fromWeb(body as never) : Readable.from([]), count, createWriteStream(e.path, { flags: 'r+', start: offset }));
      e.hash = hash;
      e.received = offset + n;
      if (e.received === e.size) e.sha256 = hash.digest('hex');
    } catch (err) {
      await truncate(e.path, offset).catch(() => {});
      throw err instanceof UploadRefused ? err : new UploadRefused(400, `The chunk failed: ${(err as Error).message}`);
    } finally {
      e.writing = false;
      this.#touch(id, e);
    }
    return e.received;
  }

  /** A complete upload, still held; undefined otherwise. */
  get(id: unknown): Upload | undefined {
    const e = typeof id === 'string' ? this.#all.get(id) : undefined;
    return e?.sha256 ? { path: e.path, fileName: e.fileName, size: e.size, sha256: e.sha256 } : undefined;
  }

  /** Takes a complete upload for use: it is gone from the list (its file is the caller's). */
  take(id: unknown): Upload | undefined {
    const up = this.get(id);
    if (up) {
      clearTimeout(this.#all.get(id as string)!.timer);
      this.#all.delete(id as string);
    }
    return up;
  }

  #get(id: string): Entry {
    const e = UPLOAD_ID.test(id) ? this.#all.get(id) : undefined;
    if (!e) throw new UploadRefused(404, 'No such upload: start it again.');
    return e;
  }

  #touch(id: string, e: Entry): void {
    clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      if (e.writing) return this.#touch(id, e);
      this.#all.delete(id);
      void rm(e.path, { force: true });
    }, this.#idleMs).unref();
  }
}

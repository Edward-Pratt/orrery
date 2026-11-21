// A save uploaded from the dashboard into `saves/` (`uploadStart`, `uploadChunk`, `uploadEnd`, `uploadCancel`; one at a
// time), each run by `Saves` through `UploadCtx`, the uploads map staying the class's. Into `.upload-<id>.zip.partial`
// (`O_RDWR`/`O_CREAT`/`O_EXCL`/`O_NOFOLLOW` through the folder opened once, `within`; refused with less than its size
// and `UPLOAD_SPARE` (512 MiB) free), each piece only at the bytes received so far and never past the size, hashed as
// it lands; at the end every byte in, the sha256 the hub announced, `checkSave`, no newer than the installed Factorio
// (`HubClient.latestInstalled`), synced, timed 2 s before the newest save (so no start loads it unasked) and linked as
// `uploadedName` (`uploaded-<time>-<the file's name in [A-Za-z0-9_-], 40 at most, or save>.zip`), a `world` save; the
// partial file removed whatever happens, and by `start` after an exit (`sweepPartials`).
import { createHash, type Hash } from 'node:crypto';
import { constants, link, lstat, open, readdir, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { checkSave, compareVersions } from './save-check.ts';
import { within } from './saves-folder.ts';
import { NEWER_MS, UPLOAD_SPARE, mb, uploadedName, type SavesOptions } from './saves-rules.ts';
import { printable } from './wire.ts';

/** A save being uploaded: its partial file kept open while chunks arrive in order, hashed as they land. */
export type Upload = { fh: FileHandle; partial: string; name: string; size: number; sha256: string; written: number; hash: Hash };

/** What an upload takes from `Saves`: its options, its uploads (by id), and its `refresh`. */
export type UploadCtx = { o: Required<SavesOptions>; uploads: Map<string, Upload>; refresh(): Promise<void> };

/**
 * Starts receiving an uploaded save (`saveUploadStart`): only with room for it and `UPLOAD_SPARE` more, into
 * `.upload-<id>.zip.partial` (`O_EXCL`, no link followed), which neither the list nor a start takes for a save.
 */
export async function uploadStart(ctx: UploadCtx, id: string, name: string, size: number, sha256: string): Promise<void> {
  if (ctx.uploads.size > 0) throw new Error('another save is being uploaded');
  const partial = `.upload-${id}.zip.partial`;
  const fh = await within(ctx.o.dir, async (base) => {
    const fs = await statfs(base);
    const free = fs.bavail * fs.bsize;
    if (free < size + UPLOAD_SPARE) throw new Error(`not enough space: ${mb(free)} free, the save needs ${mb(size)} and ${mb(UPLOAD_SPARE)} to spare`);
    // Read and write: `uploadEnd` checks the file through this same handle.
    return open(`${base}/${partial}`, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  });
  ctx.uploads.set(id, { fh, partial, name, size, sha256, written: 0, hash: createHash('sha256') });
  console.log(`[saves] receiving ${printable(name)} (${mb(size)})`);
}

/** The next piece of an upload (`saveChunk`): only at the bytes received so far, never past its size. */
export async function uploadChunk(ctx: UploadCtx, id: string, offset: number, data: Buffer): Promise<void> {
  const up = ctx.uploads.get(id);
  if (!up) throw new Error('no such upload: send saveUploadStart first');
  if (offset !== up.written) throw new Error(`expected the piece at ${up.written}, not ${offset}`);
  if (up.written + data.length > up.size) throw new Error('more bytes than the upload said');
  for (let done = 0; done < data.length; ) done += (await up.fh.write(data, done, data.length - done, offset + done)).bytesWritten;
  up.written += data.length;
  up.hash.update(data);
}

/**
 * Ends an upload (`saveUploadEnd`): every byte in, its sha256 the one announced, a Factorio save (`checkSave`) no newer
 * than `installed`, then synced, timed 2 s before the newest save (so no start loads it unasked: loading it is a
 * restore) and linked to `uploadedName`. The partial file is removed whatever happens.
 */
export async function uploadEnd(ctx: UploadCtx, id: string, installed: string | undefined): Promise<string> {
  const up = ctx.uploads.get(id);
  if (!up) throw new Error('no such upload: send saveUploadStart first');
  ctx.uploads.delete(id);
  try {
    if (up.written !== up.size) throw new Error(`only ${up.written} of ${up.size} bytes arrived`);
    if (up.hash.digest('hex') !== up.sha256) throw new Error('the file arrived damaged: its sha256 differs');
    const check = await checkSave(up.fh, up.size);
    if (!check.ok) throw new Error(`this isn't a Factorio save: ${check.reason}`);
    if (installed && compareVersions(check.version, installed) > 0) {
      throw new Error(`it was made with Factorio ${check.version}, newer than this server's ${installed}: update the game first`);
    }
    await up.fh.sync();
    const name = await within(ctx.o.dir, async (base) => {
      let newest = 0;
      for (const n of await readdir(base)) {
        if (!n.endsWith('.zip')) continue;
        const st = await lstat(`${base}/${n}`).catch(() => null);
        if (st?.isFile()) newest = Math.max(newest, st.mtimeMs);
      }
      const at = new Date((newest || ctx.o.now()) - NEWER_MS);
      await up.fh.utimes(at, at);
      let ms = ctx.o.now();
      let name = uploadedName(up.name, ms);
      const taken = new Set(await readdir(base));
      while (taken.has(name)) name = uploadedName(up.name, (ms += 1000));
      await link(`${base}/${up.partial}`, `${base}/${name}`);
      return name;
    });
    console.log(`[saves] stored the upload ${printable(up.name)} as ${name} (Factorio ${check.version})`);
    await ctx.refresh();
    return name;
  } finally {
    await dropUpload(ctx.o.dir, up);
  }
}

/** Drops an upload (`saveUploadCancel`, or the hub giving up): its partial file removed. Nothing to drop is fine. */
export async function uploadCancel(ctx: UploadCtx, id: string): Promise<void> {
  const up = ctx.uploads.get(id);
  if (!up) return;
  ctx.uploads.delete(id);
  await dropUpload(ctx.o.dir, up);
  console.log(`[saves] dropped the upload ${printable(up.name)}`);
}

async function dropUpload(dir: string, up: Upload): Promise<void> {
  await up.fh.close().catch(() => {});
  await within(dir, (base) => unlink(`${base}/${up.partial}`)).catch(() => {});
}

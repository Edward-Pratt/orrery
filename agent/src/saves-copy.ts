// A save copied within `saves/`: a restore, and a game update's copy for its rollback (`keep`); `Saves` runs both
// through `CopyCtx`, which reads its state live. `restoreSave(name)`: only a listed name, only while a fresh
// `systemctl show` says inactive or failed; copies from the source opened `O_NOFOLLOW`/`O_NONBLOCK` (the copy named
// `restored-<time>-<name>`, `name` without the `restored-<time>-` prefixes of earlier restores, so chained ones never
// outgrow a file name) into `.restored-<time>-<name>.partial` (`O_CREAT`/`O_EXCL`; no `.zip`, so neither the list nor
// a start meanwhile takes half a file for a save), synced and its time set 2 s past every other file's (or now if
// later), so `--start-server-load-latest` loads it next; then `systemctl show` again, refused ("the server started
// during the restore") unless still inactive or failed, since that start loaded the old world; then linked to
// `restored-<time>-<name>` (never over a file: `link` fails if it exists) and the partial file removed, as it is on
// any failure; then pruned and listed. `keepSave(name, from)`: a game update's copy of a listed save for its
// rollback, `orrery-pre-update-<from>-<time>.zip` (the next second while that name is taken), written and linked the
// same way through `.<copy>.partial`, byte for byte, its time 2 s before `name`'s (so `--start-server-load-latest`
// loads `name` itself and never the copy), held until `release`. Both go through the folder opened once (`within`).
import { constants, link, lstat, open, readdir, unlink, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { openPlain } from './files.ts';
import { within } from './saves-folder.ts';
import { NEWER_MS, RESTORED, isStopped, stamp, type SavesMsg, type SavesOptions } from './saves-rules.ts';
import { printable } from './wire.ts';

/** What a restore and a `keep` take from `Saves`: its options, its holds, and its own methods. */
export type CopyCtx = {
  o: Required<SavesOptions>;
  held: ReadonlySet<string>;
  list(): Promise<SavesMsg>;
  prune(): Promise<void>;
  refresh(): Promise<void>;
  hold(name: string): void;
  release(name: string): void;
};

/**
 * Copies the listed save `name` to `restored-<time>-<name>` (`name` without the `restored-<time>-` prefixes of
 * earlier restores, so chained ones never outgrow a file name), newer than every other file by 2 s, which the next
 * start loads. Refused unless the unit is stopped now (inactive or failed), for a name not listed, a file that is not
 * a regular one (a symlink swapped in), or an existing copy's name: nothing is ever overwritten. The copy is written
 * as `.restored-<time>-<name>.partial` (no `.zip`: not a save, so a start meanwhile never loads half a file), then
 * linked to its name (which fails if that exists) and that name removed. Just before, the unit is read again: if
 * it started meanwhile, that start loaded the old world, whose next save would be newer than the copy, so the
 * restore is refused and the partial file removed.
 */
export async function restoreSave(ctx: CopyCtx, name: string): Promise<void> {
  const unit = await ctx.o.unit();
  if (!isStopped(unit)) throw new Error(`the server is ${unit.active || 'in an unknown state'}: stop it first`);
  if (!(await ctx.list()).saves.some((s) => s.name === name)) throw new Error(`${name} is not a listed save`);
  const copy = `restored-${stamp(ctx.o.now())}-${name.replace(RESTORED, '')}`;
  await within(ctx.o.dir, async (base) => {
    const newest = async () => {
      let newest = 0;
      for (const other of await readdir(base)) {
        if (other === `.${copy}.partial`) continue;
        const st = await lstat(`${base}/${other}`).catch(() => null);
        if (st) newest = Math.max(newest, st.mtimeMs);
      }
      return new Date(Math.max(ctx.o.now(), newest + NEWER_MS));
    };
    await copyIn(base, name, copy, newest, async () => {
      const now = await ctx.o.unit();
      if (!isStopped(now)) throw new Error(`the server started during the restore (it is ${now.active || 'in an unknown state'}): nothing was restored`);
    });
  });
  console.log(`[saves] restored ${printable(name)} as ${printable(copy)}: the next start loads it`);
  await ctx.prune();
  await ctx.refresh();
}

/**
 * A game update's copy of the listed save `name` (the newest, as the stop left it) for its rollback:
 * `orrery-pre-update-<from>-<time>.zip` (a later second if that name is taken), held from pruning until `release`,
 * byte for byte, its time 2 s before `name`'s. So `--start-server-load-latest` loads `name` itself, which the new
 * release may write as it stops, and never the copy: a rollback restores what the old release saved. Written as
 * `.<copy>.partial` and linked to its name like a restore's copy (never over a file); resolves with its name.
 */
export async function keepSave(ctx: CopyCtx, name: string, from: string): Promise<string> {
  if (!/^\d+\.\d+\.\d+$/.test(from)) throw new Error(`${JSON.stringify(from)} is not a version`);
  if (!(await ctx.list()).saves.some((s) => s.name === name)) throw new Error(`${name} is not a listed save`);
  const copy = await within(ctx.o.dir, async (base) => {
    const taken = new Set(await readdir(base));
    let at = ctx.o.now();
    let copy = `orrery-pre-update-${from}-${stamp(at)}.zip`;
    while (taken.has(copy) || taken.has(`.${copy}.partial`) || ctx.held.has(copy)) copy = `orrery-pre-update-${from}-${stamp((at += 1000))}.zip`;
    ctx.hold(copy);
    try {
      await copyIn(base, name, copy, (src) => new Date(src.mtimeMs - NEWER_MS));
    } catch (err) {
      ctx.release(copy);
      throw err;
    }
    return copy;
  });
  console.log(`[saves] kept ${printable(name)} as ${copy} for a rollback`);
  await ctx.refresh();
  return copy;
}

/**
 * Copies `name` in the folder `base` to `copy` through `.<copy>.partial` (created `O_EXCL`, synced, its time
 * `mtime`, then `ready` checked and linked to `copy`, which fails if that exists); the partial file is always removed.
 */
async function copyIn(base: string, name: string, copy: string, mtime: (src: Stats) => Date | Promise<Date>, ready?: () => Promise<void>): Promise<void> {
  const partial = `.${copy}.partial`;
  const src = await openPlain(`${base}/${name}`);
  if (!src) throw new Error(`${name} is not a regular file`);
  let out: FileHandle | undefined;
  try {
    out = await open(`${base}/${partial}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644).catch((err: NodeJS.ErrnoException) => {
      throw err.code === 'EEXIST' ? new Error(`${partial} exists already: another copy is writing it`) : err;
    });
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (let pos = 0; ; ) {
      const { bytesRead } = await src.fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      for (let done = 0; done < bytesRead; ) done += (await out.write(buf, done, bytesRead - done, pos + done)).bytesWritten;
      pos += bytesRead;
    }
    await out.sync();
    const at = await mtime(src.st);
    await out.utimes(at, at); // kept through the link: the same file
    await ready?.();
    await link(`${base}/${partial}`, `${base}/${copy}`).catch((err: NodeJS.ErrnoException) => {
      throw err.code === 'EEXIST' ? new Error(`${copy} exists already: nothing was overwritten`) : err;
    });
  } finally {
    await out?.close();
    await src.fh.close();
    if (out) await unlink(`${base}/${partial}`).catch(() => {}); // only the partial file this call created
  }
}

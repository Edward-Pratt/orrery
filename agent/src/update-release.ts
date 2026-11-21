// A game update's releases and staging folders (`update.ts` and its modules): `current` read (`current`: only ever a
// validated `releases/X.Y.Z`, the only form the agent and setup write) and flipped (`flip`: relative `releases/<ver>`,
// validated, a symlink and a rename, as setup does); every end keeps the newest 3 releases (`KEEP_RELEASES`), the
// running one and the one the update came from (`prune`), and empties both `.incoming` folders and removes
// `mods.next` (`clean`).
import { lstat, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdatesCtx } from './update-ctx.ts';
import { RELEASE, VERSION } from './update-checks.ts';
import { within } from './update-files.ts';
import { reason } from './update-job.ts';

/** The releases kept besides the running one: the newest three. */
export const KEEP_RELEASES = 3;

const newestFirst = (a: string, b: string) => {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
};

/** `current`'s target, `releases/X.Y.Z`, checked: the only form the agent (and setup) write. */
export async function current(c: UpdatesCtx): Promise<string> {
  const target = await readlink(join(c.o.install, 'current')).catch(() => null);
  if (target === null || !RELEASE.test(target)) throw new Error(`${c.o.install}/current does not point at a release (releases/X.Y.Z)`);
  if (!(await lstat(join(c.o.install, target)).catch(() => null))?.isDirectory()) throw new Error(`${c.o.install}/${target} is not there`);
  return target;
}

/** Points `current` at `target` in one rename, as setup does (relative, `releases/X.Y.Z`), checked first. */
export async function flip(c: UpdatesCtx, target: string): Promise<void> {
  if (!RELEASE.test(target)) throw new Error(`${JSON.stringify(target)} is not a release`);
  const current = join(c.o.install, 'current');
  if ((await readlink(current).catch(() => null)) === target) return;
  const tmp = join(c.o.install, '.current.new');
  await rm(tmp, { force: true });
  await symlink(target, tmp);
  await rename(tmp, current);
}

/**
 * Keeps the newest three releases, the running one and `previous` (`releases/X.Y.Z`, what ran before the update: a
 * rollback that failed before flipping back leaves it needed for a recovery).
 */
export async function prune(c: UpdatesCtx, previous: string): Promise<void> {
  const dir = join(c.o.install, 'releases');
  const versions = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && VERSION.test(d.name))
    .map((d) => d.name)
    .sort(newestFirst);
  const running = (await current(c).catch(() => null))?.slice('releases/'.length);
  const keep = new Set([...versions.slice(0, KEEP_RELEASES), running, previous.slice('releases/'.length)]);
  for (const v of versions) {
    if (keep.has(v)) continue;
    await rm(join(dir, v), { recursive: true, force: true });
    console.log(`[update] removed Factorio ${v} from ${dir}`);
  }
}

/** Empties both `.incoming` folders, and removes `mods.next`. */
export async function clean(c: UpdatesCtx): Promise<void> {
  const { install, data } = c.o;
  for (const dir of [join(install, '.incoming'), join(data, '.incoming')]) {
    await within(dir, async (base) => {
      for (const name of await readdir(base)) await rm(`${base}/${name}`, { recursive: true, force: true });
    }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') console.error(`[update] can't clean ${dir}: ${reason(err)}`);
    });
  }
  await rm(join(data, 'mods.next'), { recursive: true, force: true }).catch((err: Error) => console.error(`[update] can't remove mods.next: ${reason(err)}`));
}

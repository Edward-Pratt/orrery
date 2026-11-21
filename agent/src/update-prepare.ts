// A game update's prepare step (`Updates` in `update.ts`): the game's sha256 from
// `https://www.factorio.com/download/sha256sums/` (its line for `factorio-headless_linux-arm64_<ver>.tar.xz`, or
// `_linux_` on x64) and each mod's sha1 from `https://mods.factorio.com/api/mods/<name>/full` must equal the hub's,
// before any download; then, only if `<install>/releases/<ver>` is missing, the tarball into `<install>/.incoming/`
// (its sha256 checked again), unpacked by `unpack` into `.incoming/<ver>`, its `bin/<arch>/factorio`'s highest glibc
// need (`glibcNeed`) at most `image.json`'s `glibc` (else "Factorio X needs glibc 2.x; the friend must re-run setup
// with a newer image"), then renamed into `releases/`; the mods into `<data>/.incoming/` (sha1 checked) and staged in
// `<data>/mods.next/` with a `mod-list.json` (the release's own mods from its `data/*/info.json`, `core` aside, each
// enabled or disabled as the server's current `mods/mod-list.json` has it, one not listed there (new in the release,
// or no list at all) enabled, then the update's, all enabled; that current list read through the folder opened
// `O_NOFOLLOW`, a regular file of 1 MiB at most, and one that isn't Factorio's `{ mods: [{ name, enabled }] }` fails
// prepare) and `mods/mod-settings.dat` copied (`copySettings`, again at the swap); the last update's `mods.prev` removed.
// A `mod-settings.dat` copy that fails leaves no part file in `mods.next`. Downloads in `update-download.ts`.
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openPlain } from './files.ts';
import { compareGlibc, glibcNeed, unpack } from './unpack.ts';
import type { UpdatesCtx } from './update-ctx.ts';
import { BUILDS, MOD_NAME, VERSION } from './update-checks.ts';
import { download, GAME_MAX, MOD_API, MOD_MAX, parseSums, SHA256SUMS, text } from './update-download.ts';
import { create, there, within, writeAll } from './update-files.ts';
import { Cancelled, check, Fail, isObject, mb, plural, reason, save, type Running } from './update-job.ts';
import { clean } from './update-release.ts';
import { step } from './update-steps.ts';
import type { Request } from './wire.ts';

const SETTINGS_MAX = 64 * 1024 ** 2;
const MOD_LIST_MAX = 1024 ** 2;

/** The mods a release comes with (`data/<name>/info.json`, `core` aside), by name: a sha256-checked release, so trusted. */
async function ownMods(release: string): Promise<Record<string, string>> {
  const mods: Record<string, string> = {};
  for (const d of await readdir(join(release, 'data'), { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || d.name === 'core' || !MOD_NAME.test(d.name)) continue;
    let info: unknown;
    try {
      info = JSON.parse(await readFile(join(release, 'data', d.name, 'info.json'), 'utf8'));
    } catch {
      continue;
    }
    if (isObject(info) && info.name === d.name && typeof info.version === 'string' && VERSION.test(info.version)) mods[d.name] = info.version;
  }
  if (!mods.base) throw new Fail(`${release} has no data/base/info.json`);
  return mods;
}

export async function prepare(c: UpdatesCtx, r: Running, req: Request<'update'>): Promise<void> {
  const { job } = r;
  const { install, data } = c.o;
  const build = BUILDS[c.o.arch]!;
  const v = job.factorio;
  const release = join(install, 'releases', v);
  const have = await there(release);
  step(c, r, 'prepare', 'running', 'Checking the hashes with factorio.com and the mod portal');
  // The hashes come from factorio.com and the portal: a mismatch with the hub's fails before any download.
  const tarball = build.tarball(v);
  let gameSha: string | null = null;
  if (!have) {
    gameSha = parseSums(await text(c, r, SHA256SUMS)).get(tarball) ?? null;
    if (gameSha === null) throw new Fail(`factorio.com's sha256 list has no ${tarball}`);
    if (gameSha !== req.factorio.sha256) throw new Fail(`The hub's sha256 for ${tarball} is not factorio.com's: nothing downloaded`);
  }
  for (const mod of req.mods) {
    check(r);
    let info: unknown;
    try {
      info = JSON.parse(await text(c, r, `${MOD_API}${encodeURIComponent(mod.name)}/full`));
    } catch (err) {
      if (err instanceof Fail || err instanceof Cancelled) throw err;
      throw new Fail(`The mod portal's answer for ${mod.name} is not JSON`);
    }
    const releases = isObject(info) && Array.isArray(info.releases) ? info.releases : [];
    const found = releases.find((x: unknown) => isObject(x) && x.version === mod.version) as Record<string, unknown> | undefined;
    if (!found || typeof found.sha1 !== 'string') throw new Fail(`The mod portal has no ${mod.name} ${mod.version}`);
    if (found.sha1 !== mod.sha1) throw new Fail(`The hub's sha1 for ${mod.name} ${mod.version} is not the mod portal's: nothing downloaded`);
  }

  await clean(c);
  if (!have) {
    await mkdir(join(install, '.incoming'), { recursive: true });
    const file = join(install, '.incoming', tarball);
    const sha = await download(c, r, req.factorio.url, join(install, '.incoming'), tarball, 'sha256', GAME_MAX, (got) => `Downloading Factorio ${v}: ${mb(got)}`);
    if (sha !== gameSha) throw new Fail(`The download of ${tarball} doesn't match factorio.com's sha256`);
    check(r);
    step(c, r, 'prepare', 'running', `Unpacking Factorio ${v}`);
    const unpacked = join(install, '.incoming', v);
    await mkdir(unpacked);
    try {
      await unpack(c.o.decompress(file), unpacked);
    } catch (err) {
      throw new Fail(`Factorio ${v}'s tarball is refused: ${reason(err)}`);
    }
    await rm(file, { force: true });
    await glibc(c, unpacked, v);
    await rename(unpacked, release);
    console.log(`[update] installed Factorio ${v} in ${release}`);
  } else await glibc(c, release, v);
  const own = await ownMods(release);
  // The game's own mods stay as the server has them (docs/protocol.md, "Game updates"); one new in this release is on.
  const listed = await modList(c);
  const on = Object.keys(own)
    .sort()
    .map((name) => ({ name, enabled: listed.get(name) ?? true }));
  job.expect = {
    ...Object.fromEntries(on.filter((m) => m.enabled).map((m) => [m.name, own[m.name]!])),
    ...Object.fromEntries(job.mods.map((m) => [m.name, m.version])),
  };

  // The mods, staged in mods.next. mods.prev is the last update's: removed, so one during this update is this one's.
  await rm(join(data, 'mods.prev'), { recursive: true, force: true });
  await rm(join(data, 'mods.next'), { recursive: true, force: true });
  await mkdir(join(data, 'mods.next'));
  await mkdir(join(data, '.incoming')).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });
  await within(join(data, '.incoming'), (incoming) =>
    within(join(data, 'mods.next'), async (next) => {
      for (const [i, mod] of req.mods.entries()) {
        check(r);
        const file = `${mod.name}_${mod.version}.zip`;
        const what = `${mod.name} ${mod.version} (${i + 1} of ${req.mods.length})`;
        const sha1 = await download(c, r, mod.url, incoming, file, 'sha1', MOD_MAX, (got) => `Downloading ${what}: ${mb(got)}`);
        if (sha1 !== mod.sha1) throw new Fail(`The download of ${mod.name} ${mod.version} doesn't match the mod portal's sha1`);
        await rename(`${incoming}/${file}`, `${next}/${file}`);
      }
      const list = [...on, ...job.mods.map((m) => ({ name: m.name, enabled: true }))];
      const fh = await create(`${next}/mod-list.json`);
      try {
        await writeAll(fh, Buffer.from(JSON.stringify({ mods: list }, null, 2) + '\n'));
      } finally {
        await fh.close();
      }
    }),
  );
  const settings = await copySettings(c);
  await save(c, job);
  step(c, r, 'prepare', 'done', `Staged Factorio ${v} and ${plural(job.mods.length, 'mod')}${settings ? ', mod-settings.dat carried over' : ''}`);
}

/**
 * Which mods the server's current `mods/mod-list.json` enables or disables, by name (a container-written file, read
 * through the folder opened `O_NOFOLLOW`, a regular file of 1 MiB at most; it only says which of the release's own
 * mods are on). No file: an empty map (Factorio's default, every mod on). One that isn't Factorio's list fails prepare.
 */
async function modList(c: UpdatesCtx): Promise<Map<string, boolean>> {
  const { data } = c.o;
  const text = await within(join(data, 'mods'), async (mods) => {
    const file = await openPlain(`${mods}/mod-list.json`);
    if (!file) {
      if (await there(`${mods}/mod-list.json`)) throw new Fail('mods/mod-list.json is not a regular file');
      return null;
    }
    try {
      if (file.st.size > MOD_LIST_MAX) throw new Fail(`mods/mod-list.json is over ${mb(MOD_LIST_MAX)}`);
      const buf = Buffer.alloc(file.st.size);
      const { bytesRead } = await file.fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.fh.close();
    }
  }).catch((err: NodeJS.ErrnoException) => {
    if (err instanceof Fail) throw err;
    if (err.code === 'ENOENT') return null; // no mods folder yet
    throw new Fail(`Can't read mods/mod-list.json: ${reason(err)}`);
  });
  const listed = new Map<string, boolean>();
  if (text === null) return listed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const entries = isObject(parsed) && Array.isArray(parsed.mods) ? parsed.mods : null;
  if (!entries || !entries.every((m: unknown) => isObject(m) && typeof m.name === 'string' && typeof m.enabled === 'boolean')) {
    throw new Fail("mods/mod-list.json is not Factorio's mod list ({ mods: [{ name, enabled }] }): nothing was changed");
  }
  for (const m of entries as { name: string; enabled: boolean }[]) if (!listed.has(m.name)) listed.set(m.name, m.enabled);
  return listed;
}

/** The binary's highest glibc need against the image's, from setup's `image.json`. */
async function glibc(c: UpdatesCtx, release: string, v: string): Promise<void> {
  const bin = join(release, 'bin', BUILDS[c.o.arch]!.bin, 'factorio');
  let need: string | null;
  try {
    need = await glibcNeed(bin);
  } catch (err) {
    throw new Fail(`Can't read Factorio ${v}'s binary: ${reason(err)}`);
  }
  if (need === null) throw new Fail(`Can't tell which glibc Factorio ${v} needs: its binary names none`);
  let have: unknown;
  try {
    have = (JSON.parse(await readFile(c.o.image, 'utf8')) as Record<string, unknown>).glibc;
  } catch {
    have = null;
  }
  if (typeof have !== 'string' || !/^\d+\.\d+$/.test(have)) throw new Fail(`Can't read the image's glibc from ${c.o.image}`);
  if (compareGlibc(need, have) > 0) throw new Fail(`Factorio ${v} needs glibc ${need}; the friend must re-run setup with a newer image (it has glibc ${have})`);
}

/** `mods/mod-settings.dat` copied into `mods.next` (replacing one there): true if there was one. */
export async function copySettings(c: UpdatesCtx): Promise<boolean> {
  const { data } = c.o;
  const src = await within(join(data, 'mods'), (mods) => openPlain(`${mods}/mod-settings.dat`)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw new Fail(`Can't read mods/mod-settings.dat: ${reason(err)}`);
  });
  if (!src) return false;
  try {
    if (src.st.size > SETTINGS_MAX) throw new Fail(`mods/mod-settings.dat is over ${mb(SETTINGS_MAX)}`);
    await within(join(data, 'mods.next'), async (next) => {
      const out = await create(`${next}/mod-settings.dat`);
      try {
        const buf = Buffer.allocUnsafe(1024 * 1024);
        for (let pos = 0; ; ) {
          const { bytesRead } = await src.fh.read(buf, 0, buf.length, pos);
          if (bytesRead === 0) break;
          await writeAll(out, buf.subarray(0, bytesRead));
          pos += bytesRead;
        }
      } catch (err) {
        // A part copy (a full disk) is no settings file, and it holds the space a rollback needs.
        await out.close();
        await rm(`${next}/mod-settings.dat`, { force: true }).catch(() => {});
        throw err;
      }
      await out.close();
    });
  } finally {
    await src.fh.close();
  }
  return true;
}

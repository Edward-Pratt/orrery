// The library's pack versions, for `Library`: stored at `<root>/library/<sha256>.zip` (the root holds `hub.db`), named
// in the `library` table (name, version, Minecraft version, loader, sha256, size, source, by, at; name, version and
// Minecraft version trimmed, 1–100 characters, loader only `forge`). At start, `moveOver` moves each
// `packs/<server>.zip` from before the library in under its pack row's name and version as 1.7.10 Forge, or reuses
// the entry with its sha256, and points the row at it; a name and version taken by another file joins as
// "<version> (<server>)", a file with no row is deleted, one still clashing is logged and left; `packs/` goes once
// empty; then, and after every stored add, `relink` links each pack row with no (or a deleted) library entry to the
// entry holding its sha256, as an older hub after a Rollback leaves it. `startPack` (`addPack(source, by)`: an
// `https:` URL fetched by `download` (`library-download.ts`); a GitHub Actions artifact link, refused (400) without
// `HubDeps.githubToken`; or a finished upload taken from `Uploads`) returns its number at once and runs (`runPack`) in
// the background into `library/.add-<random>`, cleared at start: adds are lost on a restart; one at a time (409). The
// zip is checked with `Packs`' entry checks (`zipEntries`, `contentRoot`); a blank Minecraft version or loader is read
// from a Forge universal jar (`forge-<mc>-…jar`) at the content root, else `minecraft_server.<mc>.jar` (version only),
// and the add fails if still missing. Duplicates: the same file under the same name and version finishes ok as
// "already in the library"; another file under that name and version, or the file under another name or version
// (naming it), fails; an upload's (sha256 known at once) are refused (409) before it is taken. Hub core.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { formatBytes } from '../units.ts';
import { type Add, cancelled, finish, LibraryRefused, type LibraryCtx, progress, TICK_MS } from './library-ctx.ts';
import { ARTIFACT, download, GITHUB_API } from './library-download.ts';
import { contentRoot, sha256File, zipEntries } from './packs.ts';

const TEXT_MAX = 100;
const LOADERS = ['forge'];
/** The prefix of an add's file in `library/`, cleared at start. */
export const TEMP = '.add-';

type Fields = { name: string; version: string; mc: string; loader: string };

const text = (raw: unknown, what: string, required: boolean): string => {
  if ((raw === undefined || (typeof raw === 'string' && !raw.trim())) && !required) return '';
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > TEXT_MAX) throw new LibraryRefused(400, `Give ${what} (at most ${TEXT_MAX} characters).`);
  return raw.trim();
};

/**
 * What a pack zip says about itself, from the files at its content root: a Forge universal jar
 * (`forge-<mc>-<forge>…jar`) gives the Minecraft version and the loader, else `minecraft_server.<mc>.jar` the version.
 */
export function detect(entries: string[], root: string): { mc: string; loader: string } {
  const prefix = root ? `${root}/` : '';
  const top = entries.filter((e) => e.startsWith(prefix) && !e.slice(prefix.length).includes('/')).map((e) => e.slice(prefix.length));
  for (const f of top) {
    const m = /^forge-(\d+\.\d+(?:\.\d+)?)-.*\.jar$/.exec(f);
    if (m) return { mc: m[1]!, loader: 'forge' };
  }
  for (const f of top) {
    const m = /^minecraft_server\.(\d+\.\d+(?:\.\d+)?)\.jar$/.exec(f);
    if (m) return { mc: m[1]!, loader: '' };
  }
  return { mc: '', loader: '' };
}

/**
 * Links each pack row with no library entry to the entry holding its zip (by sha256): a row an older hub wrote after
 * a Rollback, or one whose zip is added to the library later.
 */
export function relink(c: LibraryCtx): void {
  const bySha = new Map(c.d.db.library().map((e) => [e.sha256, e]));
  for (const { serverId, sha256 } of c.d.db.unlinkedPacks()) {
    const entry = bySha.get(sha256);
    if (!entry) continue;
    c.d.db.setPackLibrary(serverId, entry.id);
    console.log(`[library] ${serverId}'s pack linked to ${entry.name} ${entry.version}`);
  }
}

/**
 * Each `packs/<server>.zip` with a pack row joins the library under that row's name and version (as 1.7.10 Forge,
 * all such packs were), or is the entry with its sha256 already there; the row points at it and the file goes. When
 * another file has that name and version, it joins as "<version> (<server>)". A file with no row is deleted; one that
 * still clashes is logged and left, so nothing is lost; `packs/` goes once empty.
 */
export async function moveOver(c: LibraryCtx): Promise<void> {
  const old = join(c.d.root, 'packs');
  const files = await readdir(old).catch(() => undefined);
  if (!files) return;
  await mkdir(c.dir, { recursive: true });
  for (const f of files) {
    const file = join(old, f);
    const serverId = f.endsWith('.zip') ? f.slice(0, -4) : '';
    const row = serverId ? c.d.db.pack(serverId) : undefined;
    if (!row) {
      await rm(file, { recursive: true, force: true });
      continue;
    }
    const sha256 = await sha256File(file);
    const rows = c.d.db.library();
    let entry = rows.find((r) => r.sha256 === sha256);
    if (!entry) {
      const taken = (version: string) => rows.some((r) => r.name === row.name && r.version === version);
      const version = taken(row.version) ? `${row.version} (${serverId})` : row.version;
      if (taken(version)) {
        console.error(`[library] ${file}: ${row.name} ${version} is in the library with a different file; left in place`);
        continue;
      }
      const zip = join(c.dir, `${sha256}.zip`);
      const size = (await stat(file)).size;
      await rename(file, zip);
      const id = c.d.db.addLibraryEntry({ name: row.name, version, mc: '1.7.10', loader: 'forge', sha256, size, source: row.source, by: row.by, at: row.at });
      entry = { id, ...row, version, mc: '1.7.10', loader: 'forge', sha256, size };
    } else await rm(file, { force: true });
    c.d.db.setPackLibrary(serverId, entry.id);
    console.log(`[library] moved packs/${f} in as ${entry.name} ${entry.version}`);
  }
  await rmdir(old).catch(() => {}); // not empty: a clash was left
}

/** Starts adding a pack version from a URL or a finished upload; returns its add number at once. */
export function startPack(c: LibraryCtx, body: unknown, by: string, byName: string): number {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const fields: Fields = {
    name: text(b.name, 'the pack name', true),
    version: text(b.version, 'the pack version', true),
    mc: text(b.mc, 'the Minecraft version', false),
    loader: text(b.loader, 'the loader', false),
  };
  if (fields.loader && !LOADERS.includes(fields.loader)) throw new LibraryRefused(400, `Only ${LOADERS.join(', ')} is a known loader.`);
  let from: { url: string } | { upload: string };
  if (typeof b.url === 'string') {
    b.url = b.url.trim();
    if (URL.parse(b.url as string)?.protocol !== 'https:') throw new LibraryRefused(400, 'The pack URL must be https.');
    if (ARTIFACT.test(b.url as string) && !c.d.githubToken) {
      throw new LibraryRefused(400, 'An Actions artifact needs a GitHub token: set GITHUB_TOKEN (Actions: read) for the hub, or paste a release link.');
    }
    from = { url: b.url as string };
  } else if (typeof b.upload === 'string' && c.d.uploads.get(b.upload)) from = { upload: b.upload };
  else throw new LibraryRefused(400, 'Give a pack URL, or upload the zip again.');
  if (c.add) throw new LibraryRefused(409, `${c.add.name} ${c.add.version} is being added: one add at a time.`);
  if (c.d.installRunning()) throw new LibraryRefused(409, 'A New server install is running: add once it is done.');
  if ('upload' in from) {
    // An upload's sha256 is known now: a duplicate is refused before the upload is used up.
    const known = duplicate(c, fields, c.d.uploads.get(from.upload)!.sha256);
    if (known) throw new LibraryRefused(409, known.why);
  }
  const upload = 'upload' in from ? c.d.uploads.take(from.upload)! : undefined;
  const source = 'url' in from ? from.url : upload!.fileName;
  const add: Add = {
    add: c.next++,
    kind: 'pack',
    name: fields.name,
    version: fields.version,
    by: byName,
    started: Date.now(),
    detail: '',
    actor: by,
    source,
    abort: new AbortController(),
    cancelled: false,
    storing: false,
  };
  c.add = add;
  c.d.hub.audit(by, 'library add', 'library', `${add.name} ${add.version} from ${source}`);
  void runPack(c, add, fields, 'url' in from ? from.url : upload!);
  return add.add;
}

async function runPack(c: LibraryCtx, add: Add, fields: Fields, src: string | { path: string; sha256: string }): Promise<void> {
  const temp = join(c.dir, `${TEMP}${randomBytes(16).toString('hex')}`);
  try {
    await mkdir(c.dir, { recursive: true });
    let sha256: string;
    if (typeof src === 'string') {
      progress(c, add, 'Downloading');
      let last = 0;
      const artifact = ARTIFACT.exec(src);
      const url = artifact ? `${GITHUB_API}/repos/${artifact[1]}/${artifact[2]}/actions/artifacts/${artifact[3]}/zip` : src;
      try {
        await download(
          c.d.download,
          url,
          temp,
          (bytes, total) => {
            if (Date.now() - last < TICK_MS) return;
            last = Date.now();
            progress(c, add, `Downloading ${formatBytes(bytes)}${total ? ` of ${formatBytes(total)}` : ''}`);
          },
          add.abort.signal,
          artifact ? c.d.githubToken : undefined, // only the API link the hub built: a pasted api.github.com URL gets no token
        );
      } catch (err) {
        throw add.cancelled ? err : new Error(`Downloading the pack failed: ${(err as Error).message}`);
      }
      cancelled(add);
      progress(c, add, 'Checking the zip');
      sha256 = await sha256File(temp);
    } else {
      await rename(src.path, temp).catch(async (err) => {
        await rm(src.path, { force: true }); // taken from Uploads: nothing else would remove it
        throw err;
      });
      progress(c, add, 'Checking the zip');
      sha256 = src.sha256;
    }
    const entries = await zipEntries(temp);
    const found = detect(entries, contentRoot(entries));
    const mc = fields.mc || found.mc;
    const loader = fields.loader || found.loader;
    if (!mc || !loader) throw new Error(`The zip doesn't say its ${!mc ? 'Minecraft version' : 'loader'}: type the Minecraft version and loader, then add it again.`);
    cancelled(add);
    const known = duplicate(c, fields, sha256);
    if (known?.same) return await finish(c, add, 'ok', known.why, temp);
    if (known) throw new Error(known.why);
    add.storing = true;
    progress(c, add, 'Storing');
    const size = (await stat(temp)).size;
    const zip = join(c.dir, `${sha256}.zip`);
    await rename(temp, zip);
    try {
      c.d.db.addLibraryEntry({ name: fields.name, version: fields.version, mc, loader, sha256, size, source: add.source, by: add.by, at: Date.now() });
    } catch (err) {
      await rm(zip, { force: true });
      throw err;
    }
    relink(c); // a server's installed zip, added back
    await finish(c, add, 'ok', '', temp);
  } catch (err) {
    await finish(c, add, add.cancelled ? 'cancelled' : 'failed', add.cancelled ? '' : (err as Error).message, temp);
  }
}

/** Why `fields` with a file of `sha256` can't be added; `same` when it is in the library already, as is. */
function duplicate(c: LibraryCtx, f: Fields, sha256: string): { why: string; same: boolean } | undefined {
  const rows = c.d.db.library();
  const named = rows.find((r) => r.name === f.name && r.version === f.version);
  if (named?.sha256 === sha256) return { why: `${f.name} ${f.version} is already in the library.`, same: true };
  if (named) return { why: `${f.name} ${f.version} is in the library already, with a different file.`, same: false };
  const file = rows.find((r) => r.sha256 === sha256);
  if (file) return { why: `This file is in the library already, as ${file.name} ${file.version}.`, same: false };
  return undefined;
}

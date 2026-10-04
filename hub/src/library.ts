import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, readdirSync, readlinkSync } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { LibraryPack, LibraryRuntime, LibraryState, RunningLibraryAdd } from './api.ts';
import type { Db, LibraryRow, RuntimeRow } from './db.ts';
import { contentRoot, sha256File, zipEntries } from './packs.ts';
import type { ServerHub } from './servers.ts';
import type { LibraryAdd, TargetEvent } from './types.ts';
import { formatBytes } from './units.ts';
import type { Uploads } from './uploads.ts';

/** One HTTP request, redirects not followed (`redirect: 'manual'`): what downloads go through. The real one is `fetch`. */
export type Fetch = (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal?: AbortSignal }) => Promise<Response>;

const GITHUB_API = 'https://api.github.com';
const ADOPTIUM = 'https://api.adoptium.net/v3/assets/latest';
/** The Java versions Add runtime offers. */
export const FEATURES = [8, 17, 21, 25];
/** A runtime's name, from Adoptium's build name: safe as a folder name. */
export const RUNTIME = /^temurin-[0-9][0-9A-Za-z.+_-]*$/;
/** Adoptium's names for the architectures Node reports. */
const ARCH: Record<string, string> = { x64: 'x64', arm64: 'aarch64' };
const JAVA_CHECK_MS = 30_000;
const REDIRECTS = 5;
const RESUMES = 3;
/** A GitHub Actions artifact's page, which the API serves as a zip. */
const ARTIFACT = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/\d+\/artifacts\/(\d+)\/?$/;

/** Runs a program (no shell); rejects with its error output. */
const run = (file: string, args: string[], signal: AbortSignal, timeout = 0) =>
  new Promise<void>((done, fail) =>
    execFile(file, args, { signal, timeout }, (err, _out, stderr) => (err ? fail(new Error(stderr.trim().split('\n').at(-1) || err.message)) : done())),
  );

/** An answer that isn't a drop: an HTTP error or a refused redirect fails the download at once. */
class Refused extends Error {}

/** `url` requested with up to 5 redirects followed here: every hop `https:`, the token sent only to api.github.com. */
async function request(fetcher: Fetch, url: string, headers: Record<string, string>, token: string | undefined, signal?: AbortSignal): Promise<Response> {
  for (let hop = 0; ; hop++) {
    if (URL.parse(url)?.protocol !== 'https:') throw new Refused(`a redirect to ${url} isn't https: refused`);
    const auth: Record<string, string> = token && new URL(url).origin === GITHUB_API ? { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' } : {};
    const res = await fetcher(url, { headers: { ...headers, ...auth }, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    await res.body?.cancel();
    const to = res.headers.get('location');
    if (!to) throw new Refused(`HTTP ${res.status} without a Location`);
    if (hop === REDIRECTS) throw new Refused(`more than ${REDIRECTS} redirects`);
    url = new URL(to, url).href;
  }
}

/**
 * Fetches `url` into the file `dest`, reporting bytes so far and the total (null: unknown); `signal` aborts it. A drop
 * (a network error, or a body cut short) is resumed from `url` again (an artifact's API link gives a fresh blob link)
 * with `Range` from the bytes on disk and `If-Range` with the first answer's ETag; a `200` instead of a `206` starts
 * the file over, as does an answer without an ETag. After three resumes it fails.
 */
export async function download(
  fetcher: Fetch,
  url: string,
  dest: string,
  onProgress: (bytes: number, total: number | null) => void,
  signal?: AbortSignal,
  token?: string,
): Promise<void> {
  let etag: string | null = null;
  let have = 0;
  for (let resumes = 0; ; resumes++) {
    try {
      const res = await request(fetcher, url, have && etag ? { range: `bytes=${have}-`, 'if-range': etag } : {}, token, signal);
      if (res.status === 206 && have) {
        // appended
      } else if (res.status === 200) {
        have = 0;
        etag = res.headers.get('etag');
      } else throw new Refused(`HTTP ${res.status}`);
      if (!res.body) throw new Refused(`HTTP ${res.status} without a body`);
      const total = Number(res.status === 206 ? /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] : res.headers.get('content-length')) || null;
      let bytes = have;
      const count = new Transform({
        transform(chunk: Buffer, _, done) {
          bytes += chunk.length;
          onProgress(bytes, total);
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(dest, { flags: have ? 'a' : 'w' }), { signal });
      if (total === null || bytes >= total) return;
      throw new Error(`the download stopped at ${bytes} of ${total} bytes`);
    } catch (err) {
      if (err instanceof Refused || signal?.aborted) throw err;
      if (resumes === RESUMES) throw new Error(`${(err as Error).message} (after ${RESUMES} resumes)`);
      have = (await stat(dest).catch(() => undefined))?.size ?? 0;
    }
  }
}

/** Why a library action wasn't done: 400 (bad input), 404 (no such entry) or 409 (not now). */
export class LibraryRefused extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export type LibraryDeps = {
  hub: Pick<ServerHub, 'publishTarget' | 'audit'>;
  db: Db;
  /** Finished uploads, taken as a source. */
  uploads: Pick<Uploads, 'get' | 'take'>;
  /** The Environment's root (the folder holding `hub.db`): zips live in `<root>/library/<sha256>.zip`. */
  root: string;
  /** Downloads' HTTP requests. */
  download: Fetch;
  /** `GITHUB_TOKEN`, for Actions artifacts; sent only to api.github.com. */
  githubToken?: string;
  /** The servers whose running pack update installs an entry. */
  installing: (id: number) => string[];
  /** Node's name for this host's architecture (default `process.arch`), for tests. */
  arch?: string;
};

const TEXT_MAX = 100;
const LOADERS = ['forge'];
/** How often a download's byte count goes on the stream. */
const TICK_MS = 1_000;
const TEMP = '.add-';

type Add = RunningLibraryAdd & { actor: string; source: string; abort: AbortController; cancelled: boolean; storing: boolean };
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
 * The Environment's Pack library: pack versions stored by sha256 under `<root>/library/`, named and versioned in the
 * `library` table. One add at a time, in the background, announced as `libraryAdd` events; adds are lost on a hub
 * restart. Hub core.
 */
export class Library {
  #d: LibraryDeps;
  #dir: string;
  #add: Add | undefined;
  #next = 1;
  #closed = false;

  constructor(deps: LibraryDeps) {
    this.#d = deps;
    this.#dir = join(deps.root, 'library');
  }

  /** Clears what adds left when the last hub stopped, and moves the zips of `packs/` (from before the library) in. */
  async start(): Promise<void> {
    for (const f of await readdir(this.#dir).catch(() => [])) if (f.startsWith(TEMP)) await rm(join(this.#dir, f), { force: true });
    const work = join(this.#d.root, 'work');
    for (const f of await readdir(work).catch(() => [])) if (f.startsWith('runtime-')) await rm(join(work, f), { recursive: true, force: true });
    await this.#moveOver();
  }

  /**
   * Each `packs/<server>.zip` with a pack row joins the library under that row's name and version (as 1.7.10 Forge,
   * all such packs were), or is the entry with its sha256 already there; the row points at it and the file goes. A
   * file with no row is deleted. One whose name and version are taken by another file is logged and left, so nothing
   * is lost; `packs/` goes once empty.
   */
  async #moveOver(): Promise<void> {
    const old = join(this.#d.root, 'packs');
    const files = await readdir(old).catch(() => undefined);
    if (!files) return;
    await mkdir(this.#dir, { recursive: true });
    for (const f of files) {
      const file = join(old, f);
      const serverId = f.endsWith('.zip') ? f.slice(0, -4) : '';
      const row = serverId ? this.#d.db.pack(serverId) : undefined;
      if (!row) {
        await rm(file, { recursive: true, force: true });
        continue;
      }
      const sha256 = await sha256File(file);
      const rows = this.#d.db.library();
      let entry = rows.find((r) => r.sha256 === sha256);
      if (!entry) {
        if (rows.some((r) => r.name === row.name && r.version === row.version)) {
          console.error(`[library] ${file}: ${row.name} ${row.version} is in the library with a different file; left in place`);
          continue;
        }
        const zip = join(this.#dir, `${sha256}.zip`);
        const size = (await stat(file)).size;
        await rename(file, zip);
        const id = this.#d.db.addLibraryEntry({ name: row.name, version: row.version, mc: '1.7.10', loader: 'forge', sha256, size, source: row.source, by: row.by, at: row.at });
        entry = { id, ...row, mc: '1.7.10', loader: 'forge', sha256, size };
      } else await rm(file, { force: true });
      this.#d.db.setPackLibrary(serverId, entry.id);
      console.log(`[library] moved packs/${f} in as ${entry.name} ${entry.version}`);
    }
    await rmdir(old).catch(() => {}); // not empty: a clash was left
  }

  stop(): void {
    this.#closed = true;
    this.#add?.abort.abort();
  }

  /** Whether an add runs (a hub deploy waits for it). */
  busy(): boolean {
    return this.#add !== undefined;
  }

  state(): LibraryState {
    const a = this.#add;
    return {
      packs: this.#d.db.library().map((r): LibraryPack => ({ ...r, usedBy: this.#usedBy(r.id) })),
      runtimes: this.#d.db.runtimes().map((r): LibraryRuntime => ({ ...r, label: `Temurin ${r.name.slice('temurin-'.length)}`, usedBy: this.#linkedTo(r.name) })),
      running: a ? { add: a.add, kind: a.kind, name: a.name, version: a.version, by: a.by, started: a.started, detail: a.detail } : null,
    };
  }

  /** An entry, or undefined for an unknown id. */
  entry(id: number): LibraryRow | undefined {
    return this.#d.db.library().find((r) => r.id === id);
  }

  /** An entry's zip; 404 for an unknown id. */
  zip(id: number): string {
    return join(this.#dir, `${this.#entry(id).sha256}.zip`);
  }

  /** Starts adding a pack version from a URL or a finished upload; returns its add number at once. */
  addPack(body: unknown, by: string, byName: string): number {
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
      if (URL.parse(b.url)?.protocol !== 'https:') throw new LibraryRefused(400, 'The pack URL must be https.');
      if (ARTIFACT.test(b.url) && !this.#d.githubToken) {
        throw new LibraryRefused(400, 'An Actions artifact needs a GitHub token: set GITHUB_TOKEN (Actions: read) for the hub, or paste a release link.');
      }
      from = { url: b.url.trim() };
    } else if (typeof b.upload === 'string' && this.#d.uploads.get(b.upload)) from = { upload: b.upload };
    else throw new LibraryRefused(400, 'Give a pack URL, or upload the zip again.');
    if (this.#add) throw new LibraryRefused(409, `${this.#add.name} ${this.#add.version} is being added: one add at a time.`);
    if ('upload' in from) {
      // An upload's sha256 is known now: a duplicate is refused before the upload is used up.
      const known = this.#duplicate(fields, this.#d.uploads.get(from.upload)!.sha256);
      if (known) throw new LibraryRefused(409, known.why);
    }
    const upload = 'upload' in from ? this.#d.uploads.take(from.upload)! : undefined;
    const source = 'url' in from ? from.url : upload!.fileName;
    const add: Add = {
      add: this.#next++,
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
    this.#add = add;
    this.#d.hub.audit(by, 'library add', 'library', `${add.name} ${add.version} from ${source}`);
    void this.#run(add, fields, 'url' in from ? from.url : upload!);
    return add.add;
  }

  /** A runtime, or undefined. */
  runtime(name: string): RuntimeRow | undefined {
    return this.#d.db.runtimes().find((r) => r.name === name);
  }

  /** Starts adding the latest GA Temurin JDK of a Java version for this host; returns its add number at once. */
  addRuntime(body: unknown, by: string, byName: string): number {
    const feature = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}).feature;
    if (typeof feature !== 'number' || !FEATURES.includes(feature)) throw new LibraryRefused(400, `Pick a Java version: ${FEATURES.join(', ')}.`);
    const arch = ARCH[this.#d.arch ?? process.arch];
    if (!arch) throw new LibraryRefused(400, `Temurin has no build for this host's architecture (${this.#d.arch ?? process.arch}).`);
    if (this.#add) throw new LibraryRefused(409, `${this.#add.name} ${this.#add.version} is being added: one add at a time.`);
    const add: Add = {
      add: this.#next++,
      kind: 'runtime',
      name: 'Temurin',
      version: String(feature),
      by: byName,
      started: Date.now(),
      detail: '',
      actor: by,
      source: 'Adoptium',
      abort: new AbortController(),
      cancelled: false,
      storing: false,
    };
    this.#add = add;
    this.#d.hub.audit(by, 'library runtime add', 'library', `Temurin ${feature}`);
    void this.#runRuntime(add, feature, arch);
    return add.add;
  }

  /** Deletes a runtime; refused (409, naming them) while a server's Java link points at it. */
  async deleteRuntime(name: string, by: string): Promise<void> {
    if (!RUNTIME.test(name) || !this.runtime(name)) throw new LibraryRefused(404, 'No such runtime in the library.');
    const users = this.#linkedTo(name);
    if (users.length) throw new LibraryRefused(409, `${name} is what ${users.join(', ')} run${users.length === 1 ? 's' : ''} on.`);
    this.#d.db.deleteRuntime(name);
    await rm(join(this.#d.root, 'runtimes', name), { recursive: true, force: true });
    this.#d.hub.audit(by, 'library runtime delete', 'library', name);
  }

  /** The servers whose Java link (`<root>/java/<server>`) points at a runtime. */
  #linkedTo(name: string): string[] {
    const links = join(this.#d.root, 'java');
    const runtime = join(this.#d.root, 'runtimes', name);
    let ids: string[];
    try {
      ids = readdirSync(links);
    } catch {
      return [];
    }
    return ids.filter((id) => {
      try {
        return resolve(links, readlinkSync(join(links, id))) === runtime;
      } catch {
        return false; // not a link (a swap's leftover)
      }
    }).sort();
  }

  /**
   * Asks Adoptium for the build, downloads its tarball into `work/runtime-<random>/`, checks its sha256, unpacks it with
   * the system `tar`, runs `bin/java -version` (30 s), and only then moves it to `runtimes/<name>/`.
   */
  async #runRuntime(add: Add, feature: number, arch: string): Promise<void> {
    const work = join(this.#d.root, 'work', `runtime-${randomBytes(16).toString('hex')}`);
    const signal = add.abort.signal;
    try {
      await mkdir(join(work, 'jdk'), { recursive: true });
      this.#progress(add, 'Asking Adoptium');
      // musl's Node reports no glibc.
      const os = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ? 'linux' : 'alpine-linux';
      const asked = await request(this.#d.download, `${ADOPTIUM}/${feature}/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`, {}, undefined, signal);
      if (!asked.ok) throw new Error(`Adoptium answered HTTP ${asked.status}.`);
      const answer = (await asked.json().catch(() => [])) as { release_name?: unknown; binary?: { package?: { link?: unknown; checksum?: unknown } } }[];
      const build = answer[0];
      const pkg = build?.binary?.package;
      if (typeof build?.release_name !== 'string' || typeof pkg?.link !== 'string' || typeof pkg.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(pkg.checksum)) {
        throw new Error(`Adoptium has no Temurin ${feature} JDK for ${os} ${arch}.`);
      }
      const name = `temurin-${build.release_name.replace(/^jdk-?/, '')}`;
      if (!RUNTIME.test(name)) throw new Error(`Adoptium named the build "${build.release_name}": refused.`);
      add.version = name.slice('temurin-'.length);
      if (this.runtime(name)) return await this.#finish(add, 'ok', `Temurin ${add.version} is already installed.`, work);
      this.#cancelled(add);
      const tarball = join(work, 'jdk.tar.gz');
      let last = 0;
      this.#progress(add, 'Downloading');
      try {
        await download(
          this.#d.download,
          pkg.link,
          tarball,
          (bytes, total) => {
            if (Date.now() - last < TICK_MS) return;
            last = Date.now();
            this.#progress(add, `Downloading ${formatBytes(bytes)}${total ? ` of ${formatBytes(total)}` : ''}`);
          },
          signal,
        );
      } catch (err) {
        throw add.cancelled ? err : new Error(`Downloading the JDK failed: ${(err as Error).message}`);
      }
      this.#progress(add, 'Checking the download');
      const sha256 = await sha256File(tarball);
      if (sha256 !== pkg.checksum) throw new Error("The download's sha256 doesn't match Adoptium's: not installed.");
      this.#progress(add, 'Unpacking');
      await run('tar', ['-xzf', tarball, '-C', join(work, 'jdk'), '--no-same-owner'], signal);
      const top = await readdir(join(work, 'jdk'));
      const home = top.length === 1 ? join(work, 'jdk', top[0]!) : join(work, 'jdk');
      this.#progress(add, 'Running java -version');
      await run(join(home, 'bin', 'java'), ['-version'], signal, JAVA_CHECK_MS).catch((err: Error) => {
        throw new Error(`java -version failed on this host, so it isn't installed: ${err.message}`);
      });
      this.#cancelled(add);
      add.storing = true;
      this.#progress(add, 'Storing');
      await mkdir(join(this.#d.root, 'runtimes'), { recursive: true });
      const size = (await stat(tarball)).size;
      await rename(home, join(this.#d.root, 'runtimes', name));
      this.#d.db.addRuntime({ name, feature, size, sha256, by: add.by, at: Date.now() });
      await this.#finish(add, 'ok', '', work);
    } catch (err) {
      await this.#finish(add, add.cancelled ? 'cancelled' : 'failed', add.cancelled ? '' : (err as Error).message, work);
    }
  }

  /** Stops the running add, leaving nothing behind; too late once it is being stored. */
  cancel(by: string): void {
    const a = this.#add;
    if (!a) throw new LibraryRefused(409, 'No add is running.');
    if (a.storing) throw new LibraryRefused(409, 'Too late to cancel: it is being stored.');
    this.#d.hub.audit(by, 'library cancel', 'library', `${a.name} ${a.version}`);
    a.cancelled = true;
    a.abort.abort();
  }

  /** Deletes an entry and its zip; refused (409, naming them) while a server's pack is it or an update installs it. */
  async deletePack(id: number, by: string): Promise<void> {
    const e = this.#entry(id);
    const users = this.#usedBy(id);
    if (users.length) throw new LibraryRefused(409, `${e.name} ${e.version} is used by ${users.join(', ')}.`);
    this.#d.db.deleteLibraryEntry(id);
    await rm(join(this.#dir, `${e.sha256}.zip`), { force: true });
    this.#d.hub.audit(by, 'library delete', 'library', `${e.name} ${e.version}`);
  }

  async #run(add: Add, fields: Fields, src: string | { path: string; sha256: string }): Promise<void> {
    const temp = join(this.#dir, `${TEMP}${randomBytes(16).toString('hex')}`);
    try {
      await mkdir(this.#dir, { recursive: true });
      let sha256: string;
      if (typeof src === 'string') {
        this.#progress(add, 'Downloading');
        let last = 0;
        const artifact = ARTIFACT.exec(src);
        const url = artifact ? `${GITHUB_API}/repos/${artifact[1]}/${artifact[2]}/actions/artifacts/${artifact[3]}/zip` : src;
        try {
          await download(
            this.#d.download,
            url,
            temp,
            (bytes, total) => {
              if (Date.now() - last < TICK_MS) return;
              last = Date.now();
              this.#progress(add, `Downloading ${formatBytes(bytes)}${total ? ` of ${formatBytes(total)}` : ''}`);
            },
            add.abort.signal,
            artifact ? this.#d.githubToken : undefined, // only the API link the hub built: a pasted api.github.com URL gets no token
          );
        } catch (err) {
          throw add.cancelled ? err : new Error(`Downloading the pack failed: ${(err as Error).message}`);
        }
        this.#cancelled(add);
        this.#progress(add, 'Checking the zip');
        sha256 = await sha256File(temp);
      } else {
        await rename(src.path, temp).catch(async (err) => {
          await rm(src.path, { force: true }); // taken from Uploads: nothing else would remove it
          throw err;
        });
        this.#progress(add, 'Checking the zip');
        sha256 = src.sha256;
      }
      const entries = await zipEntries(temp);
      const found = detect(entries, contentRoot(entries));
      const mc = fields.mc || found.mc;
      const loader = fields.loader || found.loader;
      if (!mc || !loader) throw new Error(`The zip doesn't say its ${!mc ? 'Minecraft version' : 'loader'}: type the Minecraft version and loader, then add it again.`);
      this.#cancelled(add);
      const known = this.#duplicate(fields, sha256);
      if (known?.same) return await this.#finish(add, 'ok', known.why, temp);
      if (known) throw new Error(known.why);
      add.storing = true;
      this.#progress(add, 'Storing');
      const size = (await stat(temp)).size;
      const zip = join(this.#dir, `${sha256}.zip`);
      await rename(temp, zip);
      try {
        this.#d.db.addLibraryEntry({ name: fields.name, version: fields.version, mc, loader, sha256, size, source: add.source, by: add.by, at: Date.now() });
      } catch (err) {
        await rm(zip, { force: true });
        throw err;
      }
      await this.#finish(add, 'ok', '', temp);
    } catch (err) {
      await this.#finish(add, add.cancelled ? 'cancelled' : 'failed', add.cancelled ? '' : (err as Error).message, temp);
    }
  }

  /** Why `fields` with a file of `sha256` can't be added; `same` when it is in the library already, as is. */
  #duplicate(f: Fields, sha256: string): { why: string; same: boolean } | undefined {
    const rows = this.#d.db.library();
    const named = rows.find((r) => r.name === f.name && r.version === f.version);
    if (named?.sha256 === sha256) return { why: `${f.name} ${f.version} is already in the library.`, same: true };
    if (named) return { why: `${f.name} ${f.version} is in the library already, with a different file.`, same: false };
    const file = rows.find((r) => r.sha256 === sha256);
    if (file) return { why: `This file is in the library already, as ${file.name} ${file.version}.`, same: false };
    return undefined;
  }

  #cancelled(add: Add): void {
    if (add.cancelled) throw new Error('Cancelled.');
  }

  #progress(add: Add, detail: string): void {
    if (this.#closed) throw new Error('The hub is closing.');
    add.detail = detail;
    this.#publish(add, { phase: 'progress', detail });
  }

  async #finish(add: Add, outcome: 'ok' | 'cancelled' | 'failed', reason: string, temp: string): Promise<void> {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    this.#add = undefined;
    if (this.#closed) return;
    this.#d.hub.audit(add.actor, add.kind === 'pack' ? 'library add' : 'library runtime add', 'library', `${add.name} ${add.version}: ${outcome}${reason ? `: ${reason}` : ''}`);
    this.#publish(add, { phase: 'finished', outcome, reason });
  }

  #publish(add: Add, e: Pick<Extract<LibraryAdd, { phase: 'progress' }>, 'phase' | 'detail'> | Pick<Extract<LibraryAdd, { phase: 'finished' }>, 'phase' | 'outcome' | 'reason'>): void {
    this.#d.hub.publishTarget({ target: 'library', id: add.kind === 'pack' ? 'packs' : 'runtimes', type: 'libraryAdd', add: add.add, name: add.name, version: add.version, by: add.by, ...e } as TargetEvent);
  }

  /** The servers using an entry: their pack is it, or their running update installs it. */
  #usedBy(id: number): string[] {
    return [...new Set([...this.#d.db.packsOf(id), ...this.#d.installing(id)])].sort();
  }

  #entry(id: number): LibraryRow {
    const e = this.entry(id);
    if (!e) throw new LibraryRefused(404, 'No such pack in the library.');
    return e;
  }
}

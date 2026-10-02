import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  CompareReport,
  EditPreview,
  Extra,
  InstalledPack,
  PackChange,
  PackRollback,
  PackSource,
  PackState,
  PendingChange,
  ReportFile,
  UploadAnswer,
} from './api.ts';
import { listBackups } from './backups.ts';
import type { ServerSettings } from './config.ts';
import type { Db, EditRow, PackRow } from './db.ts';
import type { RestartScheduler } from './restarts.ts';
import type { HubEvent, ServerHub } from './servers.ts';
import type { Services } from './services.ts';
import type { PackFinished, PackStep, PackStepState, Severity } from './types.ts';
import { formatDuration } from './units.ts';

/** Fetches `url` into the file `dest`, reporting bytes so far and the total (null: unknown); `signal` aborts it. Rejects on failure. */
export type Download = (url: string, dest: string, onProgress: (bytes: number, total: number | null) => void, signal?: AbortSignal) => Promise<void>;

/** The real download: `fetch` (following redirects, as GitHub release assets need) streamed to the file. */
export const fetchDownload: Download = async (url, dest, onProgress, signal) => {
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || null;
  let bytes = 0;
  const count = new Transform({
    transform(chunk: Buffer, _, done) {
      bytes += chunk.length;
      onProgress(bytes, total);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(dest), { signal });
};

/** Why a pack action wasn't done: 400 (bad input), 404 (no such thing) or 409 (not now). */
export class PackRefused extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** A pack URL couldn't be downloaded (the web API's 502). */
export class DownloadFailed extends Error {}

/** Shortened in tests. */
export type PacksOptions = {
  /** How long the health gate waits for the Mod's hello (10 min). */
  gateMs?: number;
  /** How long the backup may take (30 min). */
  backupMs?: number;
  /** How often a stopping unit is read again (2 s). */
  pollMs?: number;
  /** How long a stop (countdown included) may take (15 min). */
  stopMs?: number;
  /** How long a Compare is held for Adopt (1 h). */
  compareMs?: number;
};

export type PacksDeps = {
  hub: Pick<ServerHub, 'get' | 'on' | 'off' | 'publish' | 'audit' | 'runCommand'>;
  db: Db;
  services: Pick<Services, 'ofServer' | 'act' | 'read'>;
  restarts: Pick<RestartScheduler, 'cancel' | 'pending'>;
  servers: ServerSettings[];
  hasMod: (serverId: string) => boolean;
  /** The folder holding `hub.db`: uploads, the Extras and the installed packs' zips live under it. */
  dataDir: string;
  download: Download;
  /** Whether a restore runs on a server. */
  restoring: (serverId: string) => boolean;
  /** What deploy runs that a pack update on a server must wait for: a hub deploy, or a Mod deploy onto it. */
  deploying: (serverId: string) => 'hub' | 'mod' | null;
};

const STAGING = '.orrery-staging';
const PRE = '.pre-update-';
/** The Mod's jar: put back by every update, never an Extra. The only thing the hub knows about the pack's contents. */
const MOD_JAR = /^mods\/gtnhdiscord-[^/]*\.jar$/;
const UPLOAD_MAX = 4 * 1024 ** 3;
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const HISTORY = 50;
const LOG_LINES = 40;
const TEXT_MAX = 200;
/** How often live detail (download progress, countdown, gate) goes on the stream. */
const TICK_MS = 1_000;
const STEPS: PackStep[] = ['prepare', 'backup', 'stop', 'swap', 'gate'];

/** What the last apply laid over the pack: each Extra's sha256 by target, and each edited file's edits as JSON. */
type Snapshot = { extras: Record<string, string>; edits: Record<string, string> };
type Upload = { path: string; fileName: string; size: number; sha256: string };
type Source = { url: string; name: string; version: string } | { upload: string; name: string; version: string };
type Compared = { report: CompareReport; source: string; sha256: string; zip: string; manifest: string[]; own: Set<string>; timer: NodeJS.Timeout };
type Job = {
  id: number;
  serverId: string;
  name: string;
  version: string;
  from: string;
  actor: string;
  byName: string;
  started: number;
  steps: PackStepState[];
  /** Set by `cancel`; Prepare checks it between its parts, and it aborts the download. */
  cancelled: boolean;
  abort: AbortController;
  /** Where Cancel is accepted now. */
  window: 'prepare' | 'countdown' | null;
  stopped: boolean;
  touched: boolean;
  log: string[];
  backup: string | null;
  pre: string | null;
};

/** `unzip` (no shell): resolves with its output. */
const unzip = (args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile('unzip', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(`unzip: ${stderr.trim() || err.message}`)) : resolve(stdout))),
  );

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function isFile(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined))?.isFile() ?? false;
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined;
}

/** Every file (not folder or symlink) under `base`, as posix paths relative to it; none if it doesn't exist. */
async function walk(base: string, rel = ''): Promise<string[]> {
  const entries = await readdir(join(base, rel), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) files.push(...(await walk(base, p)));
    else if (e.isFile()) files.push(p);
  }
  return files;
}

/** The Mod's jars in a server folder's `mods/`. */
async function modJars(dir: string): Promise<string[]> {
  return (await readdir(join(dir, 'mods')).catch(() => [])).map((f) => `mods/${f}`).filter((p) => MOD_JAR.test(p));
}

/** Whether `rel` in `dir` resolves (symlinks followed, as far as it exists) inside `dir`. */
async function inside(dir: string, rel: string): Promise<boolean> {
  const root = await realpath(dir);
  for (let at = join(dir, rel); ; at = dirname(at)) {
    try {
      const real = await realpath(at);
      return real === root || real.startsWith(root + sep);
    } catch {
      if (dirname(at) === at) return false;
    }
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `path` is, or is inside, a Kept path (`*` matches within one name; a trailing `/` marks a folder). */
const keptBy = (path: string, kept: string[]) =>
  kept.find((k) => new RegExp(`^${k.replace(/\/+$/, '').split('*').map(escapeRe).join('[^/]*')}(/|$)`).test(path));

/** A request's path in the server folder, normalised; refused if empty, absolute or with a `..`. */
function relPath(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new PackRefused(400, `Give ${what}.`);
  const p = posix.normalize(raw.trim()).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (posix.isAbsolute(raw.trim()) || raw.split(/[/\\]/).includes('..') || raw.includes('\0') || p === '.' || p === '') {
    throw new PackRefused(400, `${what[0]!.toUpperCase()}${what.slice(1)} must be a path inside the server folder, without "..".`);
  }
  return p;
}

const text = (raw: unknown, what: string, required = false): string => {
  if (raw === undefined && !required) return '';
  if (typeof raw !== 'string' || (required && !raw.trim()) || raw.length > TEXT_MAX) throw new PackRefused(400, `Give ${what} (at most ${TEXT_MAX} characters).`);
  return raw.trim();
};

function regex(find: unknown): RegExp {
  if (typeof find !== 'string' || !find) throw new PackRefused(400, 'Give a Find regex.');
  try {
    return new RegExp(find, 'gm');
  } catch (err) {
    throw new PackRefused(400, `Find isn't a valid regex: ${(err as Error).message}`);
  }
}

/**
 * The entries of a pack zip, checked before anything is extracted: refused (400) with a symlink, an absolute path or
 * a `..` segment. Read from `unzip -Z`, whose count must match the zip's own, so no entry can slip past.
 */
async function zipEntries(zip: string): Promise<string[]> {
  const out = await unzip(['-Z', zip]).catch((err: Error) => {
    throw new PackRefused(400, `Not a readable zip: ${err.message}`);
  });
  const count = Number(/number of entries: (\d+)/.exec(out)?.[1]);
  const entries: string[] = [];
  for (const line of out.split('\n')) {
    const m = /^([-a-zA-Z?]{7,12}) +\S+ +\S+ +\d+ +\S+ +\S+ +\S+ +\S+ (.*)$/.exec(line);
    if (!m) continue;
    const [, mode, name] = m as unknown as [string, string, string];
    if (mode.startsWith('l')) throw new PackRefused(400, `The zip has a symlink (${name}): refused.`);
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split(/[/\\]/).includes('..')) {
      throw new PackRefused(400, `The zip has a path outside its folder (${name}): refused.`);
    }
    entries.push(name);
  }
  if (!entries.length || entries.length !== count) throw new PackRefused(400, "Couldn't read the zip's list of files.");
  return entries;
}

/** The content root: the shallowest folder holding `mods/` or `config/` ('' for the zip's top). */
function contentRoot(entries: string[]): string {
  let best: string[] | undefined;
  for (const e of entries) {
    const parts = e.split('/');
    const i = parts.findIndex((p, n) => (p === 'mods' || p === 'config') && n < parts.length - 1);
    if (i !== -1 && (!best || i < best.length)) best = parts.slice(0, i);
  }
  if (!best) throw new PackRefused(400, 'The zip has no mods/ or config/ folder: is it a server pack?');
  return best.join('/');
}

/** Checks a pack zip, extracts it into `into` (made empty first) and returns its content root's files, relative to `<into>/<root>`. */
async function unpack(zip: string, into: string): Promise<{ root: string; files: string[] }> {
  const entries = await zipEntries(zip);
  const root = contentRoot(entries);
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  await unzip(['-qq', '-o', zip, '-d', into]);
  const prefix = root ? `${root}/` : '';
  return { root: join(into, root), files: entries.filter((e) => e.startsWith(prefix) && !e.endsWith('/')).map((e) => e.slice(prefix.length)) };
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;

/**
 * Server packs: the installed pack, its manifest, Extras, Config edits and changes pending; Adopt; pack updates (Prepare,
 * Backup, Stop, Swap, health gate, rollback), one per server, recorded in `pack_updates`, audited and announced as
 * `packUpdate*` notices. Only for a server with a folder, a linked service and a Mod token. Hub core.
 */
export class Packs {
  #d: PacksDeps;
  #o: Required<PacksOptions>;
  #uploadsDir: string;
  #uploads = new Map<string, Upload>();
  #compared = new Map<string, Compared>();
  #jobs = new Map<string, Job>();
  /** Stops each wait and ticker without resolving it: a closing hub leaves a running update as a crash would. */
  #halts = new Set<() => void>();
  #closed = false;

  constructor(deps: PacksDeps, o: PacksOptions = {}) {
    this.#d = deps;
    this.#o = { gateMs: 10 * 60_000, backupMs: 30 * 60_000, pollMs: 2_000, stopMs: 15 * 60_000, compareMs: 60 * 60_000, ...o };
    this.#uploadsDir = join(deps.dataDir, 'uploads');
  }

  /** Clears unused uploads and leftover staging, and closes updates the last hub left running as interrupted. */
  async start(): Promise<void> {
    await rm(this.#uploadsDir, { recursive: true, force: true });
    await rm(join(this.#d.dataDir, 'staging'), { recursive: true, force: true });
    for (const row of this.#d.db.packUpdates(undefined, 1000)) {
      const dir = this.#settings(row.serverId)?.dir;
      const swapped = ['swap', 'gate', 'rollback'].includes(row.step);
      const pre = swapped && dir ? (await readdir(dir).catch(() => [])).filter((f) => f.startsWith(PRE)).sort().at(-1) : undefined;
      if (dir && !swapped) await rm(join(dir, STAGING), { recursive: true, force: true });
      const why = `interrupted during ${row.step}: the hub restarted${pre ? `. The old files are in ${pre}/` : ''}`;
      this.#d.db.setPackUpdate(row.id, { outcome: 'failed', finished: Date.now(), log: [row.log, why].filter(Boolean).join('\n') });
    }
  }

  stop(): void {
    this.#closed = true;
    for (const halt of this.#halts) halt();
  }

  /** Whether a server can have a pack: a folder, a linked service and a Mod token. */
  has(serverId: string): boolean {
    return Boolean(this.#settings(serverId)?.dir && this.#d.services.ofServer(serverId) && this.#d.hasMod(serverId));
  }

  /** Whether a pack update runs on a server (`serverId` undefined: on any). */
  busy(serverId?: string): boolean {
    return serverId === undefined ? this.#jobs.size > 0 : this.#jobs.has(serverId);
  }

  /** The restore offer after the server's latest update rolled back; null otherwise. */
  rollback(serverId: string): PackRollback | null {
    if (!this.has(serverId) || this.#jobs.has(serverId)) return null;
    const last = this.#d.db.packUpdates(serverId, 1)[0];
    return last?.outcome === 'rolled back' && last.restored === null ? { to: last.to, backup: last.backup } : null;
  }

  /** A restore ran on the server: the rollback offer is done with. */
  restored(serverId: string): void {
    const last = this.#d.db.packUpdates(serverId, 1)[0];
    if (last?.outcome === 'rolled back' && last.restored === null) this.#d.db.setPackUpdate(last.id, { restored: Date.now() });
  }

  async state(serverId: string): Promise<PackState> {
    const s = this.#server(serverId);
    const pack = this.#d.db.pack(serverId);
    const own = new Set(this.#d.db.packFiles(serverId, true));
    const snap: Snapshot = pack ? JSON.parse(pack.snapshot) : { extras: {}, edits: {} };
    const job = this.#jobs.get(serverId);
    const extras: Extra[] = this.#d.db.extras(serverId).map((e) => {
      const was = snap.extras[e.target];
      const change: PackChange | null = e.removed ? (was ? 'removed' : null) : !was ? 'added' : was !== e.sha256 ? 'replaced' : null;
      return { ...e, replaces: own.has(e.target), change };
    });
    return {
      installed: pack ? installed(pack) : null,
      kept: { server: s.keep ?? [], builtIn: await this.#builtIn(s) },
      extras,
      edits: this.#d.db.configEdits(serverId),
      pending: pack ? this.#pending(serverId, snap) : [],
      history: this.#d.db.packUpdates(serverId, HISTORY).map(({ serverId: _, restored: __, ...row }) => row),
      running: job ? { id: job.id, name: job.name, version: job.version, by: job.byName, started: job.started, steps: job.steps, cancellable: job.window !== null } : null,
      mod: (await modJars(s.dir!))[0] ?? null,
      blocked: this.#blocked(serverId, s.name),
      rolledBack: this.rollback(serverId),
      packFiles: [...own],
    };
  }

  /** Streams an upload to `<data>/uploads`, hashing it on the way; at most 4 GiB. */
  async upload(body: ReadableStream<Uint8Array> | null, fileName: string): Promise<UploadAnswer> {
    await mkdir(this.#uploadsDir, { recursive: true });
    const upload = randomBytes(16).toString('hex');
    const path = join(this.#uploadsDir, upload);
    const hash = createHash('sha256');
    let size = 0;
    const count = new Transform({
      transform(chunk: Buffer, _, done) {
        size += chunk.length;
        if (size > UPLOAD_MAX) return done(new PackRefused(400, 'The file is larger than 4 GiB.'));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(body ? Readable.fromWeb(body as never) : Readable.from([]), count, createWriteStream(path));
    } catch (err) {
      await rm(path, { force: true });
      throw err instanceof PackRefused ? err : new PackRefused(400, `The upload failed: ${(err as Error).message}`);
    }
    const name = basename(fileName).slice(0, TEXT_MAX) || 'upload';
    this.#uploads.set(upload, { path, fileName: name, size, sha256: hash.digest('hex') });
    return { upload, fileName: name, size };
  }

  /** Compares a pack with the server folder; held for `adopt`. Refused once the server has a pack. */
  async compare(serverId: string, source: unknown, by: string): Promise<CompareReport> {
    const s = this.#server(serverId);
    if (this.#d.db.pack(serverId)) throw new PackRefused(409, `${s.name} has a pack already.`);
    const src = this.#source(source);
    const got = await this.#fetch(src);
    try {
      const into = join(this.#d.dataDir, 'staging', serverId);
      const kept = await this.#kept(s);
      try {
        const { root, files } = await unpack(got.zip, into);
        const manifest = files.filter((f) => !keptBy(f, kept)).sort();
        const own = new Set(manifest);
        const report: CompareReport = { name: src.name, version: src.version, matching: 0, mod: await modJars(s.dir!), notInPack: [], different: [] };
        const size = async (f: string) => (await lstat(join(s.dir!, f))).size;
        for (const f of manifest) {
          if (!(await isFile(join(s.dir!, f)))) continue;
          if ((await sha256File(join(root, f))) === (await sha256File(join(s.dir!, f)))) report.matching++;
          else report.different.push({ path: f, size: await size(f) });
        }
        const inPack = new Set(files);
        for (const top of ['mods', 'config']) {
          for (const f of await walk(s.dir!, top)) {
            if (!inPack.has(f) && !keptBy(f, kept)) report.notInPack.push({ path: f, size: await size(f) });
          }
        }
        report.notInPack.sort((a, b) => a.path.localeCompare(b.path));
        // Files the pack lacks count as the last apply's too: the next update drops them, unless kept as Extras.
        manifest.push(...report.notInPack.map((f) => f.path));
        manifest.sort();
        this.#forget(serverId);
        const timer = setTimeout(() => this.#forget(serverId), this.#o.compareMs);
        timer.unref();
        this.#compared.set(serverId, { report, source: got.source, sha256: got.sha256, zip: got.zip, manifest, own, timer });
        this.#d.hub.audit(by, 'pack compare', serverId, `${src.name} ${src.version}: ${report.matching} files match`);
        return report;
      } finally {
        await rm(into, { recursive: true, force: true });
      }
    } catch (err) {
      await rm(got.zip, { force: true });
      throw err;
    }
  }

  /** Records the compared pack as installed, keeping the given report paths as Extras. Changes nothing in the server folder. */
  async adopt(serverId: string, keep: unknown, by: string, byName: string): Promise<PackState> {
    const s = this.#server(serverId);
    if (this.#d.db.pack(serverId)) throw new PackRefused(409, `${s.name} has a pack already.`);
    const c = this.#compared.get(serverId);
    if (!c) throw new PackRefused(409, 'Compare with the server first (a comparison is kept for an hour).');
    if (!Array.isArray(keep) || !keep.every((k) => typeof k === 'string')) throw new PackRefused(400, 'Give the paths to keep.');
    const offered = new Set([...c.report.notInPack, ...c.report.different].map((f: ReportFile) => f.path));
    const bad = (keep as string[]).find((k) => !offered.has(k));
    if (bad !== undefined) throw new PackRefused(400, `${bad} isn't in the report.`);
    const at = Date.now();
    for (const target of new Set(keep as string[])) {
      const from = join(s.dir!, target);
      const sha256 = await sha256File(from);
      const id = this.#d.db.addExtra(serverId, { target, sha256, label: '', note: 'kept at adopt', by: byName, at });
      await mkdir(this.#extrasDir(serverId), { recursive: true });
      await copyFile(from, join(this.#extrasDir(serverId), String(id)));
    }
    await mkdir(join(this.#d.dataDir, 'packs'), { recursive: true });
    await rename(c.zip, this.#zipOf(serverId));
    const { name, version } = c.report;
    this.#d.db.setPack(serverId, { name, version, source: c.source, sha256: c.sha256, by: byName, at, how: 'adopted', snapshot: JSON.stringify(this.#snapshot(serverId)) }, c.manifest, c.own);
    clearTimeout(c.timer);
    this.#compared.delete(serverId);
    this.#d.hub.audit(by, 'pack adopt', serverId, `${name} ${version}, keeping ${(keep as string[]).length} files`);
    return this.state(serverId);
  }

  async addExtra(serverId: string, body: Record<string, unknown>, by: string, byName: string): Promise<PackState> {
    const s = this.#adopted(serverId);
    const target = await this.#target(s, body.target);
    const label = text(body.label, 'a label');
    const note = text(body.note, 'a note');
    const rows = this.#d.db.extras(serverId);
    if (rows.some((e) => e.target === target && !e.removed)) throw new PackRefused(409, `An Extra is at ${target} already: replace its file instead.`);
    const upload = this.#take(body.upload);
    for (const old of rows.filter((e) => e.target === target)) await this.#purge(serverId, old.id); // added back before an apply
    const id = this.#d.db.addExtra(serverId, { target, sha256: upload.sha256, label, note, by: byName, at: Date.now() });
    await this.#store(serverId, id, upload);
    this.#d.hub.audit(by, 'pack extra add', serverId, target);
    return this.state(serverId);
  }

  async updateExtra(serverId: string, extraId: number, body: Record<string, unknown>, by: string): Promise<PackState> {
    this.#adopted(serverId);
    const e = this.#d.db.extras(serverId).find((x) => x.id === extraId);
    if (!e) throw new PackRefused(404, 'No such Extra.');
    if (e.removed) throw new PackRefused(409, `The Extra at ${e.target} is removed.`);
    const label = body.label === undefined ? e.label : text(body.label, 'a label');
    const note = body.note === undefined ? e.note : text(body.note, 'a note');
    const upload = body.upload === undefined ? undefined : this.#take(body.upload);
    if (upload) await this.#store(serverId, e.id, upload);
    this.#d.db.updateExtra(e.id, { sha256: upload?.sha256 ?? e.sha256, label, note, removed: false });
    this.#d.hub.audit(by, 'pack extra change', serverId, `${e.target}${upload ? ': new file' : ''}`);
    return this.state(serverId);
  }

  /** Marks an Extra removed until the next apply; one never applied goes at once. */
  async removeExtra(serverId: string, extraId: number, by: string): Promise<PackState> {
    const pack = this.#d.db.pack(serverId);
    this.#adopted(serverId);
    const e = this.#d.db.extras(serverId).find((x) => x.id === extraId);
    if (!e) throw new PackRefused(404, 'No such Extra.');
    if ((JSON.parse(pack!.snapshot) as Snapshot).extras[e.target]) this.#d.db.updateExtra(e.id, { ...e, removed: true });
    else await this.#purge(serverId, e.id);
    this.#d.hub.audit(by, 'pack extra remove', serverId, e.target);
    return this.state(serverId);
  }

  async addEdit(serverId: string, body: Record<string, unknown>, by: string, byName: string): Promise<PackState> {
    const edit = await this.#edit(this.#adopted(serverId), body);
    this.#d.db.addEdit(serverId, { ...edit, by: byName, at: Date.now() });
    this.#d.hub.audit(by, 'pack edit add', serverId, `${edit.path}: ${edit.find} → ${edit.replace}`);
    return this.state(serverId);
  }

  async updateEdit(serverId: string, editId: number, body: Record<string, unknown>, by: string): Promise<PackState> {
    const s = this.#adopted(serverId);
    if (!this.#d.db.configEdits(serverId).some((e) => e.id === editId)) throw new PackRefused(404, 'No such Config edit.');
    const edit = await this.#edit(s, body);
    this.#d.db.updateEdit(editId, { ...edit, failedOn: null });
    this.#d.hub.audit(by, 'pack edit change', serverId, `${edit.path}: ${edit.find} → ${edit.replace}`);
    return this.state(serverId);
  }

  async removeEdit(serverId: string, editId: number, by: string): Promise<PackState> {
    this.#adopted(serverId);
    const e = this.#d.db.configEdits(serverId).find((x) => x.id === editId);
    if (!e) throw new PackRefused(404, 'No such Config edit.');
    this.#d.db.deleteEdit(editId);
    this.#d.hub.audit(by, 'pack edit remove', serverId, `${e.path}: ${e.find} → ${e.replace}`);
    return this.state(serverId);
  }

  /** How many lines of the file on the server now `find` matches in. */
  async previewEdit(serverId: string, path: unknown, find: unknown): Promise<EditPreview> {
    const s = this.#server(serverId);
    const p = relPath(path, 'a file');
    const re = regex(find);
    const file = join(s.dir!, p);
    if (!(await isFile(file)) || !(await inside(s.dir!, p))) throw new PackRefused(404, `No file ${p} on the server.`);
    const content = await readFile(file, 'utf8');
    const lines = new Set([...content.matchAll(re)].map((m) => content.slice(0, m.index).split('\n').length));
    return { matches: lines.size };
  }

  /**
   * Starts a pack update onto a new pack, or applies the changes pending onto the installed one, and resolves with its
   * history row's id at once; the steps run in the background. Refused (`PackRefused`) unless it can run now.
   */
  update(serverId: string, source: unknown, by: string, byName: string): number {
    const s = this.#server(serverId);
    if (this.#jobs.has(serverId)) throw new PackRefused(409, `A pack update is already running on ${s.name}.`);
    const pack = this.#d.db.pack(serverId);
    if (!pack) throw new PackRefused(409, `orrery doesn't know ${s.name}'s pack yet: adopt it first.`);
    const blocked = this.#blocked(serverId, s.name);
    if (blocked) throw new PackRefused(409, blocked);
    if (!this.#d.hub.get(serverId)?.online) throw new PackRefused(409, `${s.name} is offline: an update needs it running, for the backup.`);
    const pending = this.#pending(serverId, JSON.parse(pack.snapshot));
    let src: Source | undefined;
    if (source === 'pending') {
      if (!pending.length) throw new PackRefused(409, `Nothing is pending: ${pack.version} is installed as it is.`);
    } else {
      src = this.#source(source);
      const up = 'upload' in src ? this.#uploads.get(src.upload) : undefined;
      // An upload's sha256 is known now; a URL's only after the download, so the same URL stands in for it here.
      const same = up ? up.sha256 === pack.sha256 : 'url' in src && src.url === pack.source;
      if (same && src.version === pack.version && !pending.length) {
        throw new PackRefused(409, `${pack.name} ${pack.version} is installed already, with nothing pending.`);
      }
    }
    const upload = src && 'upload' in src ? this.#take(src.upload) : undefined;
    const changes = src ? null : pending.map((p) => `${p.path} ${p.change}`);
    const job: Job = {
      id: 0,
      serverId,
      name: src?.name ?? pack.name,
      version: src?.version ?? pack.version,
      from: pack.version,
      actor: by,
      byName,
      started: Date.now(),
      steps: STEPS.map((step) => ({ step, state: 'waiting', detail: '' })),
      cancelled: false,
      abort: new AbortController(),
      window: 'prepare',
      stopped: false,
      touched: false,
      log: [],
      backup: null,
      pre: null,
    };
    job.id = this.#d.db.startPackUpdate(serverId, { from: job.from, to: job.version, changes, by: byName, started: job.started });
    this.#jobs.set(serverId, job);
    this.#d.hub.audit(by, 'pack update', serverId, changes ? `changes applied to ${job.version}: ${changes.join(', ')}` : `${job.from} → ${job.version}`);
    this.#d.hub.publish(serverId, { severity: 'info', kind: 'packUpdateStarted', from: job.from, to: job.version, by: byName });
    void this.#run(job, s, pack, src && 'url' in src ? src : upload ? { upload, name: job.name, version: job.version } : undefined);
    return job.id;
  }

  /** Cancels a running update while nothing has been touched: in Prepare, or during the Stop countdown. */
  cancel(serverId: string, by: string, byName: string): void {
    const s = this.#server(serverId);
    const job = this.#jobs.get(serverId);
    if (!job) throw new PackRefused(409, `No pack update is running on ${s.name}.`);
    if (!job.window) throw new PackRefused(409, 'Too late to cancel: only while preparing or during the countdown.');
    this.#d.hub.audit(by, 'pack update cancel', serverId, `${job.from} → ${job.version}`);
    if (job.window === 'countdown') this.#d.restarts.cancel(serverId, by, byName); // the update sees the cancelled countdown
    else {
      job.cancelled = true;
      job.abort.abort();
    }
  }

  // The update itself.

  async #run(job: Job, s: ServerSettings, pack: PackRow, src: { url: string; name: string; version: string } | { upload: Upload; name: string; version: string } | undefined): Promise<void> {
    const dir = s.dir!;
    const staging = join(dir, STAGING);
    const service = this.#d.services.ofServer(s.id)!;
    const oldFiles = this.#d.db.packFiles(s.id);
    const oldOwn = new Set(this.#d.db.packFiles(s.id, true));
    let zip: string | undefined;
    let next: PackRow | undefined;
    let manifest: string[] = [];
    let own = new Set<string>();
    try {
      // 1. Prepare: the staged set, while the server runs.
      this.#step(job, 'prepare', 'running', src ? 'Getting the pack' : 'Building the staged set');
      let got: { zip: string; sha256: string; source: string };
      if (!src) got = { zip: this.#zipOf(s.id), sha256: pack.sha256, source: pack.source };
      else if ('url' in src) {
        let last = 0;
        got = await this.#fetch(src, job.abort.signal, (bytes, total) => {
          if (Date.now() - last < TICK_MS) return;
          last = Date.now();
          this.#step(job, 'prepare', 'running', `Downloading ${mb(bytes)}${total ? ` of ${mb(total)}` : ''}`);
        });
      } else got = { zip: src.upload.path, sha256: src.upload.sha256, source: src.upload.fileName };
      if (src) zip = got.zip;
      if (src && got.sha256 === pack.sha256 && job.version === pack.version && !this.#pending(s.id, JSON.parse(pack.snapshot)).length) {
        throw new Error(`${pack.name} ${pack.version} is installed already, with nothing pending.`);
      }
      this.#cancelled(job);
      this.#step(job, 'prepare', 'running', 'Unpacking');
      const { root, files } = await unpack(got.zip, join(staging, 'zip'));
      const kept = await this.#kept(s);
      for (const f of files) if (keptBy(f, kept)) await rm(join(root, f), { force: true });
      own = new Set(files.filter((f) => !keptBy(f, kept)));
      const snapshot = this.#snapshot(s.id);
      for (const e of this.#d.db.extras(s.id)) {
        if (e.removed || keptBy(e.target, kept)) continue;
        await mkdir(dirname(join(root, e.target)), { recursive: true });
        await copyFile(join(this.#extrasDir(s.id), String(e.id)), join(root, e.target));
      }
      for (const jar of await modJars(dir)) {
        await mkdir(join(root, 'mods'), { recursive: true });
        await copyFile(join(dir, jar), join(root, jar));
      }
      for (const e of this.#d.db.configEdits(s.id)) await this.#applyEdit(job, root, e);
      const staged = await walk(root);
      for (const f of staged) if (!(await inside(dir, f))) throw new Error(`${f} would be written outside the server folder.`);
      manifest = staged.filter((f) => !MOD_JAR.test(f)).sort();
      next = { name: job.name, version: job.version, source: got.source, sha256: got.sha256, by: job.byName, at: 0, how: 'updated', snapshot: JSON.stringify(snapshot) };
      this.#cancelled(job);
      job.window = null;
      this.#step(job, 'prepare', 'done', `Staged: ${manifest.length.toLocaleString('en')} files`);

      // 2. Backup: mandatory, through the Mod.
      this.#step(job, 'backup', 'running', 'Backing up');
      job.backup = await this.#backup(job, s);
      this.#d.db.setPackUpdate(job.id, { backup: job.backup });
      this.#step(job, 'backup', 'done', job.backup ?? 'Backed up');

      // 3. Stop, with the countdown when players are online.
      this.#step(job, 'stop', 'running', 'Stopping');
      const countdown = this.#wait(s.id, (e) =>
        e.type === 'notice' ? (e.kind === 'restartNow' ? 'fired' : e.kind === 'restartCancelled' || e.kind === 'restartCancelledDown' ? 'cancelled' : undefined) : undefined,
      this.#o.stopMs);
      let at: number | null;
      try {
        at = await this.#d.services.act(service.id, 'stop', job.actor, job.byName);
      } catch (err) {
        countdown.stop();
        throw err;
      }
      job.stopped = true;
      if (at === null) countdown.stop();
      else {
        job.window = 'countdown';
        const players = this.#d.hub.get(s.id)?.players.length ?? 0;
        const tick = this.#ticker(() => this.#step(job, 'stop', 'running', `${players} player${players === 1 ? '' : 's'} online: stopping in ${clock(at! - Date.now())}`));
        const how = await countdown.done;
        tick();
        job.window = null;
        if (how === 'cancelled') {
          job.stopped = false;
          return await this.#end(job, 'cancelled', staging, zip);
        }
        if (how === undefined) throw new Error("The countdown didn't end in time.");
      }
      await this.#inactive(service.id);
      this.#step(job, 'stop', 'done', at === null ? 'Stopped' : 'Stopped after the countdown');

      // 4. Swap: the old manifest's files out to .pre-update-<time>/, the staged set in.
      job.touched = true;
      const pre = `${PRE}${new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')}`;
      job.pre = pre;
      this.#step(job, 'swap', 'running', `Moving ${oldFiles.length.toLocaleString('en')} old files to ${pre}/`);
      for (const f of await readdir(dir)) if (f.startsWith(PRE)) await rm(join(dir, f), { recursive: true, force: true });
      const out = async (f: string) => {
        if (!(await exists(join(dir, f)))) return;
        await mkdir(dirname(join(dir, pre, f)), { recursive: true });
        await rename(join(dir, f), join(dir, pre, f));
      };
      for (const f of [...oldFiles, ...(await modJars(dir))]) await out(f);
      for (const f of staged) {
        await out(f); // a file the old manifest didn't list: kept with the old ones, not lost
        await mkdir(dirname(join(dir, f)), { recursive: true });
        await rename(join(root, f), join(dir, f));
      }
      this.#d.db.setPack(s.id, { ...next, at: Date.now() }, manifest, own);
      await rm(staging, { recursive: true, force: true });
      this.#log(job, `The old files are in ${pre}/`);
      this.#step(job, 'swap', 'done', `Swapped: ${staged.length.toLocaleString('en')} files in, old ones in ${pre}/`);

      // 5. Health gate: the Mod's hello.
      const waited = await this.#gate(job, service.id, 'gate');
      if (waited !== null) {
        if (zip) {
          await mkdir(join(this.#d.dataDir, 'packs'), { recursive: true });
          await rename(zip, this.#zipOf(s.id));
        }
        for (const e of this.#d.db.extras(s.id)) if (e.removed) await this.#purge(s.id, e.id);
        for (const e of this.#d.db.configEdits(s.id)) if (e.failedOn) this.#d.db.updateEdit(e.id, { ...e, failedOn: null });
        this.#step(job, 'gate', 'done', `Hello after ${clock(waited)}`);
        return await this.#end(job, 'ok', staging);
      }
      this.#step(job, 'gate', 'failed', `No hello within ${formatDuration(this.#o.gateMs)}`);
      return await this.#rollback(job, s, service.id, pack, { oldFiles, oldOwn, manifest }, zip);
    } catch (err) {
      if (this.#closed) return; // left running: the next hub closes it as interrupted
      const why = (err as Error).message;
      this.#log(job, why);
      const at = job.steps.find((x) => x.state === 'running');
      if (at) this.#step(job, at.step, 'failed', why);
      if (job.touched) return await this.#rollback(job, s, service.id, pack, { oldFiles, oldOwn, manifest }, zip);
      if (job.stopped) {
        await this.#d.services.act(service.id, 'start', job.actor, job.byName).catch(() => {});
        return await this.#end(job, 'failed', staging, zip);
      }
      return await this.#end(job, job.cancelled ? 'cancelled' : 'failed in staging', staging, zip);
    }
  }

  /** Puts the old files and records back after the health gate failed (or the swap broke), and starts the server again. */
  async #rollback(
    job: Job,
    s: ServerSettings,
    serviceId: string,
    pack: PackRow,
    { oldFiles, oldOwn, manifest }: { oldFiles: string[]; oldOwn: Set<string>; manifest: string[] },
    zip: string | undefined,
  ): Promise<void> {
    const dir = s.dir!;
    try {
      this.#step(job, 'rollback', 'running', 'Putting the old files back');
      await this.#d.services.act(serviceId, 'stop', job.actor, job.byName);
      await this.#inactive(serviceId);
      for (const f of [...manifest, ...(await modJars(dir))]) await rm(join(dir, f), { force: true });
      // Copied, not moved: the folder stays for recovery by hand until the next update that succeeds.
      await cp(join(dir, job.pre!), dir, { recursive: true, force: true, verbatimSymlinks: true });
      this.#d.db.setPack(s.id, pack, oldFiles, oldOwn);
      const waited = await this.#gate(job, serviceId, 'rollback');
      if (waited !== null) {
        this.#step(job, 'rollback', 'done', `${pack.version} is running again`);
        return await this.#end(job, 'rolled back', join(dir, STAGING), zip);
      }
      this.#log(job, `${s.name} didn't come back after the rollback either. The old files are in ${job.pre}/`);
      this.#step(job, 'rollback', 'failed', `No hello after the rollback either. The old files are in ${job.pre}/`);
    } catch (err) {
      if (this.#closed) return;
      this.#log(job, `The rollback failed: ${(err as Error).message}. The old files are in ${job.pre}/`);
      this.#step(job, 'rollback', 'failed', (err as Error).message);
    }
    return await this.#end(job, 'failed', join(dir, STAGING), zip);
  }

  /** Starts the service and waits for the Mod's hello; resolves with how long it took, or null without one. */
  async #gate(job: Job, serviceId: string, step: 'gate' | 'rollback'): Promise<number | null> {
    const from = Date.now();
    const hello = this.#wait(job.serverId, (e) => (e.type === 'connected' ? true : undefined), this.#o.gateMs);
    const tick = this.#ticker(() =>
      this.#step(job, step, 'running', `${step === 'rollback' ? 'Old files back. ' : ''}Waiting for the Mod's hello: ${clock(Date.now() - from)} of ${clock(this.#o.gateMs)}`),
    );
    try {
      await this.#d.services.act(serviceId, 'start', job.actor, job.byName);
      return (await hello.done) ? Date.now() - from : null;
    } finally {
      hello.stop();
      tick();
    }
  }

  async #backup(job: Job, s: ServerSettings): Promise<string | null> {
    const done = this.#wait(s.id, (e) => (e.type === 'backup' ? e : undefined), this.#o.backupMs);
    try {
      await this.#d.hub.runCommand(s.id, 'backup start', job.actor);
      const e = await done.done;
      if (!e) throw new Error(`No backup within ${formatDuration(this.#o.backupMs)}.`);
      if (!e.ok) throw new Error(`The backup failed: ${e.detail}`);
    } finally {
      done.stop();
    }
    return (await listBackups(s.backupDir ?? ''))[0]?.name ?? null;
  }

  async #applyEdit(job: Job, root: string, e: EditRow): Promise<void> {
    const file = join(root, e.path);
    const content = (await isFile(file)) ? await readFile(file, 'utf8') : undefined;
    const re = new RegExp(e.find, 'gm');
    if (!content?.match(re)) {
      this.#d.db.updateEdit(e.id, { ...e, failedOn: job.version });
      throw new Error(`The Config edit on ${e.path} (${e.find}) ${content === undefined ? 'has no file' : 'matched nothing'} in ${job.version}.`);
    }
    await writeFile(file, content.replace(re, e.replace));
  }

  /** Polls the unit until it is stopped. */
  async #inactive(serviceId: string): Promise<void> {
    const end = Date.now() + this.#o.stopMs;
    for (;;) {
      const state = (await this.#d.services.read(serviceId))?.state;
      if (state === 'inactive' || state === 'failed') return;
      if (Date.now() > end) throw new Error(`The service didn't stop within ${formatDuration(this.#o.stopMs)}.`);
      await new Promise((r) => setTimeout(r, this.#o.pollMs));
    }
  }

  #cancelled(job: Job): void {
    if (job.cancelled) throw new Error('Cancelled.');
  }

  async #end(job: Job, outcome: PackFinished, staging: string, zip?: string): Promise<void> {
    if (this.#closed) return;
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (zip && outcome !== 'ok') await rm(zip, { force: true }).catch(() => {});
    if (outcome === 'cancelled') this.#log(job, 'Cancelled: the server was not touched.');
    const finished = Date.now();
    this.#d.db.setPackUpdate(job.id, { outcome, finished, log: job.log.slice(-LOG_LINES).join('\n') });
    this.#jobs.delete(job.serverId);
    this.#d.hub.audit(job.actor, 'pack update', job.serverId, `${job.from} → ${job.version}: ${outcome}`);
    const severity: Severity = outcome === 'ok' ? 'good' : outcome === 'rolled back' || outcome === 'failed' ? 'problem' : 'info';
    this.#d.hub.publish(job.serverId, {
      severity,
      kind: 'packUpdateFinished',
      outcome,
      from: job.from,
      to: job.version,
      ms: finished - job.started,
      ...(outcome === 'rolled back' && job.backup && { backup: job.backup }),
    });
  }

  /** Sets a step's state and puts it on the stream; a step that starts is the row's current one. */
  #step(job: Job, step: PackStep, state: PackStepState['state'], detail: string): void {
    if (this.#closed) throw new Error('The hub is closing.');
    const i = job.steps.findIndex((x) => x.step === step);
    const was = job.steps[i];
    if (i === -1) job.steps.push({ step, state, detail });
    else job.steps[i] = { step, state, detail };
    if (state === 'running' && was?.state !== 'running') this.#d.db.setPackUpdate(job.id, { step });
    if (state !== 'running') this.#log(job, `${step}: ${state}${detail ? `: ${detail}` : ''}`);
    this.#d.hub.publish(job.serverId, { severity: 'info', kind: 'packUpdateStep', step, state, detail, cancellable: job.window !== null });
  }

  #log(job: Job, line: string): void {
    job.log.push(line);
    this.#d.db.setPackUpdate(job.id, { log: job.log.slice(-LOG_LINES).join('\n') });
  }

  /** Runs `fn` now and every second until the returned stop is called. */
  #ticker(fn: () => void): () => void {
    fn();
    const timer = setInterval(fn, TICK_MS);
    const stop = () => {
      clearInterval(timer);
      this.#halts.delete(stop);
    };
    this.#halts.add(stop);
    return stop;
  }

  /** Waits for a server event `pick` turns into a value; `done` resolves with it, or undefined after `ms` or `stop`. */
  #wait<T>(serverId: string, pick: (e: HubEvent) => T | undefined, ms: number): { done: Promise<T | undefined>; stop: () => void } {
    let stop!: () => void;
    const done = new Promise<T | undefined>((resolve) => {
      const listen = (e: HubEvent) => {
        if (e.serverId !== serverId) return;
        const v = pick(e);
        if (v !== undefined) {
          resolve(v); // first: stop resolves with undefined
          stop();
        }
      };
      const timer = setTimeout(() => stop(), ms);
      const halt = () => {
        clearTimeout(timer);
        this.#d.hub.off('event', listen);
        this.#halts.delete(halt);
      };
      stop = () => {
        halt();
        resolve(undefined);
      };
      this.#d.hub.on('event', listen);
      this.#halts.add(halt);
    });
    return { done, stop };
  }

  // Helpers.

  #settings(serverId: string): ServerSettings | undefined {
    return this.#d.servers.find((s) => s.id === serverId);
  }

  /** A server that can have a pack, else 404. */
  #server(serverId: string): ServerSettings {
    if (!this.has(serverId)) throw new PackRefused(404, 'No such server, or it has no pack.');
    return this.#settings(serverId)!;
  }

  #adopted(serverId: string): ServerSettings {
    const s = this.#server(serverId);
    if (!this.#d.db.pack(serverId)) throw new PackRefused(409, `orrery doesn't know ${s.name}'s pack yet: adopt it first.`);
    return s;
  }

  #blocked(serverId: string, name: string): string | null {
    if (this.#jobs.has(serverId)) return `A pack update is running on ${name}.`;
    if (this.#d.restoring(serverId)) return `A restore is running on ${name}.`;
    const deploy = this.#d.deploying(serverId);
    if (deploy === 'mod') return `A Mod deploy onto ${name} is running.`;
    if (deploy === 'hub') return 'A hub deploy is running.';
    return null;
  }

  #extrasDir(serverId: string): string {
    return join(this.#d.dataDir, 'extras', serverId);
  }

  #zipOf(serverId: string): string {
    return join(this.#d.dataDir, 'packs', `${serverId}.zip`);
  }

  async #builtIn(s: ServerSettings): Promise<string[]> {
    const props = await readFile(join(s.dir!, 'server.properties'), 'utf8').catch(() => '');
    const world = /^level-name=(.*)$/m.exec(props)?.[1]?.trim() || 'world';
    const backups = s.backupDir ? relative(s.dir!, s.backupDir) : '';
    return [
      `${world}/`,
      'server.properties',
      'ops.json',
      'whitelist.json',
      'banned-players.json',
      'banned-ips.json',
      'usercache.json',
      'eula.txt',
      'server-icon.png',
      'logs/',
      'crash-reports/',
      ...(backups && !backups.startsWith('..') && !isAbsolute(backups) ? [`${backups}/`] : []),
      `${PRE}*/`,
      `${STAGING}/`,
      'mods/gtnhdiscord-*.jar',
    ];
  }

  async #kept(s: ServerSettings): Promise<string[]> {
    return [...(s.keep ?? []), ...(await this.#builtIn(s))];
  }

  /** An Extra's target: normalised, inside the folder, and not a Kept path (the Mod's jar among them). */
  async #target(s: ServerSettings, raw: unknown): Promise<string> {
    const target = relPath(raw, 'a path to put it at');
    if (MOD_JAR.test(target)) throw new PackRefused(400, `${target} is the Mod's jar: deploy the Mod from Host.`);
    const kept = keptBy(target, await this.#kept(s));
    if (kept) throw new PackRefused(400, `${target} is a Kept path (${kept}): an update never writes there.`);
    if (!(await inside(s.dir!, target))) throw new PackRefused(400, `${target} leads outside the server folder.`);
    return target;
  }

  async #edit(s: ServerSettings, body: Record<string, unknown>): Promise<Pick<EditRow, 'path' | 'find' | 'replace' | 'note'>> {
    const path = await this.#target(s, body.path);
    regex(body.find);
    if (typeof body.replace !== 'string') throw new PackRefused(400, 'Give a Replace string.');
    return { path, find: body.find as string, replace: body.replace, note: text(body.note, 'a note') };
  }

  #source(raw: unknown): Source {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = text(b.name, 'the pack name', true);
    const version = text(b.version, 'the pack version', true);
    if (typeof b.url === 'string') {
      if (URL.parse(b.url)?.protocol !== 'https:') throw new PackRefused(400, 'The pack URL must be https.');
      return { url: b.url, name, version };
    }
    if (typeof b.upload === 'string' && this.#uploads.has(b.upload)) return { upload: b.upload, name, version };
    throw new PackRefused(400, 'Give a pack URL, or upload the zip again.');
  }

  /** Takes an upload for use: it is gone from the list (its file is the caller's). */
  #take(id: unknown): Upload {
    const up = typeof id === 'string' && UPLOAD_ID.test(id) ? this.#uploads.get(id) : undefined;
    if (!up) throw new PackRefused(400, 'Upload the file (again).');
    this.#uploads.delete(id as string);
    return up;
  }

  /** A source's zip in `<data>/uploads`, with its sha256 and what to record as its source. */
  async #fetch(
    src: PackSource,
    signal?: AbortSignal,
    onProgress: (bytes: number, total: number | null) => void = () => {},
  ): Promise<{ zip: string; sha256: string; source: string }> {
    if ('upload' in src) {
      const up = this.#take(src.upload);
      return { zip: up.path, sha256: up.sha256, source: up.fileName };
    }
    await mkdir(this.#uploadsDir, { recursive: true });
    const zip = join(this.#uploadsDir, randomBytes(16).toString('hex'));
    try {
      await this.#d.download(src.url, zip, onProgress, signal);
    } catch (err) {
      await rm(zip, { force: true });
      throw new DownloadFailed(`Downloading the pack failed: ${(err as Error).message}`);
    }
    return { zip, sha256: await sha256File(zip), source: src.url };
  }

  async #store(serverId: string, id: number, upload: Upload): Promise<void> {
    await mkdir(this.#extrasDir(serverId), { recursive: true });
    await rename(upload.path, join(this.#extrasDir(serverId), String(id)));
  }

  async #purge(serverId: string, id: number): Promise<void> {
    this.#d.db.deleteExtra(id);
    await rm(join(this.#extrasDir(serverId), String(id)), { force: true });
  }

  #forget(serverId: string): void {
    const c = this.#compared.get(serverId);
    if (!c) return;
    clearTimeout(c.timer);
    this.#compared.delete(serverId);
    void rm(c.zip, { force: true });
  }

  #snapshot(serverId: string): Snapshot {
    const extras = Object.fromEntries(this.#d.db.extras(serverId).filter((e) => !e.removed).map((e) => [e.target, e.sha256]));
    const byPath = new Map<string, [string, string][]>();
    for (const e of this.#d.db.configEdits(serverId)) byPath.set(e.path, [...(byPath.get(e.path) ?? []), [e.find, e.replace]]);
    return { extras, edits: Object.fromEntries([...byPath].map(([p, list]) => [p, JSON.stringify(list)])) };
  }

  /** What the next apply changes, per file, against what the last one applied. */
  #pending(serverId: string, applied: Snapshot): PendingChange[] {
    const now = this.#snapshot(serverId);
    const diff = (kind: 'extra' | 'edit', was: Record<string, string>, is: Record<string, string>): PendingChange[] =>
      [...new Set([...Object.keys(was), ...Object.keys(is)])].sort().flatMap((path) => {
        const change: PackChange | null = !was[path] ? 'added' : !is[path] ? 'removed' : was[path] !== is[path] ? 'replaced' : null;
        return change ? [{ path, kind, change }] : [];
      });
    return [...diff('extra', applied.extras, now.extras), ...diff('edit', applied.edits, now.edits)];
  }
}

const installed = ({ name, version, source, sha256, by, at, how }: PackRow): InstalledPack => ({ name, version, source, sha256, by, at, how });

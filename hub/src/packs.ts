import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import type {
  CompareReport,
  EditPreview,
  Extra,
  InstalledPack,
  PackChange,
  PackRollback,
  PackRuntime,
  PackState,
  PendingChange,
  PendingServers,
  ReportFile,
  StartScript,
} from './api.ts';
import { listBackups } from './backups.ts';
import type { ServerSettings } from './config.ts';
import type { Db, EditRow, LibraryRow, PackRow, PendingRow } from './db.ts';
import type { Deploys } from './deploys.ts';
import { RUNTIME, type Library } from './library.ts';
import type { RestartScheduler } from './restarts.ts';
import type { HubEvent, ServerHub } from './servers.ts';
import type { Services } from './services.ts';
import type { InstallStep, PackFinished, PackStep, PackStepState, Severity } from './types.ts';
import { formatDuration } from './units.ts';
import type { Upload, Uploads } from './uploads.ts';

/** Why a pack action wasn't done: 400 (bad input), 404 (no such thing) or 409 (not now). */
export class PackRefused extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

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
  hub: Pick<ServerHub, 'get' | 'on' | 'off' | 'publish' | 'publishTarget' | 'audit' | 'runCommand'>;
  db: Db;
  services: Pick<Services, 'ofServer' | 'act' | 'read' | 'environment'>;
  restarts: Pick<RestartScheduler, 'cancel' | 'pending'>;
  servers: ServerSettings[];
  hasMod: (serverId: string) => boolean;
  /** The Environment's root (the folder holding `hub.db`): Compare's scratch (`work/<server>/`) and the Extras live under it. */
  dataDir: string;
  /** Finished uploads, taken as an Extra. */
  uploads: Pick<Uploads, 'get' | 'take'>;
  /** Where every pack comes from: Compare, Adopt and updates install a library entry's zip. */
  library: Pick<Library, 'entry' | 'zip' | 'runtime' | 'busy'>;
  /** Whether a restore runs on a server. */
  restoring: (serverId: string) => boolean;
  /** What deploy runs that a pack update on a server must wait for: a hub deploy, or a Mod deploy onto it. */
  deploying: (serverId: string) => 'hub' | 'mod' | null;
  /** New server, only with GitHub on: the Mod's releases, the hub's own unit (for the setup command) and its Mod port. */
  install?: {
    mods: Pick<Deploys, 'modBuild' | 'download'>;
    hubUnit: string;
    hubPort: number;
    /** Whether systemd knows a unit, loaded or not. */
    unitExists: (unit: string) => Promise<boolean>;
  };
};

/** A new server's id: also its unit's, folder's and polkit file's name (`add-server.sh` checks the same). */
export const SERVER_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** A start script `add-server.sh` accepts: a plain `.sh` file at the content root. */
const SCRIPT = /^[A-Za-z0-9._-]+\.sh$/;
/** The Config edit that takes a start script's `while true` loop out, keeping its `java` line. */
export const LOOP = '^while true.*\\n(?:.*\\n)*?(.*\\bjava\\b.*)\\n(?:.*\\n)*?done\\b.*$';
/** The heap flags the memory Config edit sets. */
const MEMORY_FLAG = /-Xm([sx])\S+/;
/** What `add-server.sh` reads: the name, start script and Mod token. */
const PENDING_FILE = '.orrery-pending.json';
/** The root copy `add-server.sh` runs from, and the checked-in one it is installed from. */
const ROOT_SCRIPT = '/usr/local/lib/orrery/add-server.sh';
const REPO_SCRIPT = fileURLToPath(new URL('../../deploy/add-server.sh', import.meta.url));

type Install = { id: string; name: string; by: string; byName: string; started: number; step: string; detail: string; libraryId: number };

/** Where Prepare builds the staged set, in the server folder. */
const UPDATE = '.orrery-update';
/** Its name before the rename: Kept, and deleted by the next update. */
const LEGACY_STAGING = '.orrery-staging';
const PRE = '.pre-update-';
/** The Mod's jar, from before the rename and after: put back by every update, never an Extra. The only thing the hub knows about the pack's contents. */
const MOD_JAR = /^mods\/(gtnhdiscord|orrery)-[^/]*\.jar$/;
const HISTORY = 50;
const LOG_LINES = 40;
const TEXT_MAX = 200;
/** How often live detail (countdown, gate) goes on the stream. */
const TICK_MS = 1_000;
const STEPS: PackStep[] = ['prepare', 'backup', 'stop', 'swap', 'gate'];

/** What the last apply laid over the pack: each Extra's sha256 by target, and each edited file's edits as JSON. */
type Snapshot = { extras: Record<string, string>; edits: Record<string, string> };
type Compared = { report: CompareReport; entry: LibraryRow; manifest: string[]; own: Set<string>; timer: NodeJS.Timeout };
type Job = {
  id: number;
  serverId: string;
  name: string;
  version: string;
  /** The library entry it installs. */
  libraryId: number;
  from: string;
  actor: string;
  byName: string;
  started: number;
  steps: PackStepState[];
  /** Set by `cancel`; Prepare checks it between its parts. */
  cancelled: boolean;
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

export async function sha256File(path: string): Promise<string> {
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
export async function zipEntries(zip: string): Promise<string[]> {
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
export function contentRoot(entries: string[]): string {
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

/**
 * Server packs: the installed pack, its manifest, Extras, Config edits and changes pending; Adopt; pack updates (Prepare,
 * Backup, Stop, Swap, health gate, rollback), one per server, recorded in `pack_updates`, audited and announced as
 * `packUpdate*` notices. Only for a server with a folder, a linked service and a Mod token. Hub core.
 */
export class Packs {
  #d: PacksDeps;
  #o: Required<PacksOptions>;
  #compared = new Map<string, Compared>();
  #install: Install | undefined;
  #jobs = new Map<string, Job>();
  /** Stops each wait and ticker without resolving it: a closing hub leaves a running update as a crash would. */
  #halts = new Set<() => void>();
  #closed = false;
  /** Servers whose Java runtime changed since their last start. ponytail: in memory, so a hub restart forgets it; a table if that matters. */
  #runtimeChanged = new Set<string>();
  #started = (e: HubEvent) => {
    if (e.type === 'connected') this.#runtimeChanged.delete(e.serverId);
  };

  constructor(deps: PacksDeps, o: PacksOptions = {}) {
    this.#d = deps;
    this.#o = { gateMs: 10 * 60_000, backupMs: 30 * 60_000, pollMs: 2_000, stopMs: 15 * 60_000, compareMs: 60 * 60_000, ...o };
  }

  /** Clears Compare's leftover scratch, and closes updates the last hub left running as interrupted. */
  async start(): Promise<void> {
    this.#d.hub.on('event', this.#started);
    // A Pending server whose id is in config now: the setup script ran, so it is a server.
    for (const p of this.#d.db.pendingServers()) {
      const s = this.#settings(p.id);
      if (!s) continue;
      if (s.dir && resolve(s.dir) === resolve(p.dir)) {
        this.#d.db.deletePendingServer(p.id);
        await rm(join(p.dir, PENDING_FILE), { force: true });
        console.log(`[packs] ${p.id} is a server now`);
      } else console.warn(`[packs] ${p.id} is in config with another folder (${s.dir ?? 'none'}) than its Pending server's (${p.dir}): left as it is`);
    }
    // An install the last hub left running (it stopped or crashed): what it wrote goes, unless it got as far as a server.
    const marker = await readFile(this.#installMarker(), 'utf8').catch(() => undefined);
    const left = marker === undefined ? undefined : (JSON.parse(marker) as { id?: unknown }).id;
    if (typeof left === 'string' && SERVER_ID.test(left) && !this.#settings(left) && !this.#d.db.pendingServers().some((p) => p.id === left)) {
      await this.#removeInstall(left);
      console.log(`[packs] removed ${left}'s install, interrupted by the hub's restart`);
    }
    await rm(this.#installMarker(), { force: true });
    await rm(join(this.#d.dataDir, 'work', 'install'), { recursive: true, force: true });
    // `downloads/` and `staging/` are from before the library (#139).
    for (const old of ['downloads', 'staging']) await rm(join(this.#d.dataDir, old), { recursive: true, force: true });
    for (const s of this.#d.servers) await rm(this.#work(s.id), { recursive: true, force: true });
    for (const row of this.#d.db.packUpdates(undefined, 1000)) {
      const dir = this.#settings(row.serverId)?.dir;
      const swapped = ['swap', 'gate', 'rollback'].includes(row.step);
      const pre = swapped && dir ? (await readdir(dir).catch(() => [])).filter((f) => f.startsWith(PRE)).sort().at(-1) : undefined;
      if (dir && !swapped) await rm(join(dir, UPDATE), { recursive: true, force: true });
      const why = `interrupted during ${row.step}: the hub restarted${pre ? `. The old files are in ${pre}/` : ''}`;
      this.#d.db.setPackUpdate(row.id, { outcome: 'failed', finished: Date.now(), log: [row.log, why].filter(Boolean).join('\n') });
    }
  }

  stop(): void {
    this.#closed = true;
    this.#d.hub.off('event', this.#started);
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

  /** The servers whose running update or install installs a library entry (it can't be deleted meanwhile). */
  installing(libraryId: number): string[] {
    const install = this.#install?.libraryId === libraryId ? [this.#install.id] : [];
    return [...[...this.#jobs.values()].filter((j) => j.libraryId === libraryId).map((j) => j.serverId), ...install];
  }

  /** Whether a New server install runs (a hub deploy and a library add wait for it). */
  installRunning(): boolean {
    return this.#install !== undefined;
  }

  /** The Pending servers, oldest first, each with its setup command, and the running install. */
  pending(): PendingServers {
    const i = this.#install;
    const installScript = existsSync(ROOT_SCRIPT) ? null : `sudo install -D -m 755 -o root -g root -t ${dirname(ROOT_SCRIPT)} ${REPO_SCRIPT}`;
    return {
      pending: this.#d.db.pendingServers().map(({ token: _, unit: __, ...p }) => ({
        ...p,
        command: `sudo ${ROOT_SCRIPT} ${p.id} ${this.#d.dataDir} --hub-unit ${this.#d.install?.hubUnit ?? 'orrery-hub.service'}`,
        installScript,
      })),
      installing: i ? { id: i.id, name: i.name, by: i.byName, started: i.started, step: i.step, detail: i.detail } : null,
    };
  }

  /**
   * Starts installing a library pack as a new server in `<root>/servers/<id>`, and resolves with its id once every check
   * passed; the install runs in the background, announced as `install` events, and ends as a Pending server. Refused
   * (`PackRefused`) before anything is written.
   */
  async install(body: Record<string, unknown>, by: string, byName: string): Promise<string> {
    const cfg = this.#d.install;
    if (!cfg) throw new PackRefused(404, 'New server needs the GitHub integration.');
    const id = typeof body.id === 'string' ? body.id : '';
    if (!SERVER_ID.test(id)) throw new PackRefused(400, 'The id must be a lowercase letter, then up to 31 lowercase letters, digits or dashes.');
    const name = text(body.name, 'a name', true);
    const port = body.gamePort;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new PackRefused(400, 'The game port must be 1–65535.');
    const gamePort = port as number;
    if (typeof body.memory !== 'string' || !/^[1-9]\d{0,5}[MG]$/.test(body.memory)) throw new PackRefused(400, 'Memory is a size like 6G or 512M.');
    const memory = body.memory;
    if (body.eula !== true) throw new PackRefused(400, 'Accept the Minecraft EULA to install a server.');
    if (typeof body.startScript !== 'string' || !SCRIPT.test(body.startScript)) throw new PackRefused(400, 'Pick a start script from the pack.');
    const startScript = body.startScript;
    const removeLoop = body.removeLoop === true;
    const runtime = body.runtime ?? null;
    if (runtime !== null && (typeof runtime !== 'string' || !RUNTIME.test(runtime) || !this.#d.library.runtime(runtime))) {
      throw new PackRefused(404, 'No such runtime in the library.');
    }
    const entry = this.#source(body);
    if (this.#install) throw new PackRefused(409, `${this.#install.name} is being installed: one install at a time.`);
    if (this.#d.library.busy()) throw new PackRefused(409, 'A library add is running: install once it is done.');
    const install: Install = { id, name, by, byName, started: Date.now(), step: 'unpack', detail: 'Checking', libraryId: entry.id };
    this.#install = install; // claimed before the first await: two requests can't both pass
    let build: { tag: string; asset: string } | undefined;
    let script: StartScript | undefined;
    try {
      const pending = this.#d.db.pendingServers();
      if (this.#settings(id)) throw new PackRefused(409, `The id ${id} is a server in config already.`);
      if (pending.some((p) => p.id === id)) throw new PackRefused(409, `The id ${id} is a Pending server already.`);
      if (this.#d.db.hasPackData(id)) throw new PackRefused(409, `orrery still has pack data under the id ${id}: pick another id.`);
      if ((await exists(this.#serverDir(id))) || (await exists(this.#javaLink(id)))) {
        throw new PackRefused(409, `${this.#serverDir(id)} or ${this.#javaLink(id)} exists already: pick another id.`);
      }
      const taken = pending.find((p) => p.gamePort === gamePort)?.name ?? (await this.#portUser(gamePort));
      if (taken) throw new PackRefused(409, `Port ${gamePort} is ${taken}'s game port.`);
      let unit: boolean;
      try {
        unit = await cfg.unitExists(`${id}.service`);
      } catch (err) {
        throw new PackRefused(409, `Couldn't ask systemd about ${id}.service: ${(err as Error).message}`);
      }
      if (unit) throw new PackRefused(409, `systemd has a unit ${id}.service already: pick another id.`);
      build = cfg.mods.modBuild(entry.mc);
      if (!build) throw new PackRefused(409, `No Mod release has a build for Minecraft ${entry.mc}.`);
      script = (await startScripts(this.#d.library.zip(entry.id))).find((sc) => sc.name === startScript);
      if (!script) throw new PackRefused(400, `${startScript} isn't a start script in ${entry.name} ${entry.version}.`);
      if (!script.memory) throw new PackRefused(400, `${startScript} sets no -Xmx or -Xms for the memory: pick another start script.`);
    } catch (err) {
      this.#install = undefined;
      throw err;
    }
    this.#d.hub.audit(by, 'server install', id, `${name}: ${entry.name} ${entry.version}, port ${gamePort}, ${memory}, ${runtime ?? 'system java'}`);
    void this.#runInstall(install, entry, build, { gamePort, memory, startScript, removeLoop: removeLoop && script!.loops, runtime });
    return id;
  }

  /** Deletes a Pending server: its folder, Java link, pack data and row. Refused (409) once its id is in config. */
  async discard(id: string, by: string): Promise<void> {
    if (this.#settings(id)) throw new PackRefused(409, `${id} is in config: it is a server now, not a Pending one.`);
    const p = this.#d.db.pendingServers().find((x) => x.id === id);
    if (!p) throw new PackRefused(404, 'No such Pending server.');
    await this.#removeInstall(id);
    this.#d.hub.audit(by, 'server discard', id, p.name);
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
      runtime: await this.#runtime(s),
    };
  }

  /**
   * Sets the Java a server runs on from its next start: its link `<root>/java/<server>` swapped atomically to a runtime
   * (a new link renamed over it), or removed for the host's own `java` (`name` null).
   */
  async setRuntime(serverId: string, name: unknown, by: string): Promise<PackState> {
    const s = this.#server(serverId);
    if (name !== null && (typeof name !== 'string' || !RUNTIME.test(name) || !this.#d.library.runtime(name))) {
      throw new PackRefused(404, 'No such runtime in the library.');
    }
    const link = this.#javaLink(serverId);
    if (name === null) await rm(link, { force: true });
    else {
      await mkdir(dirname(link), { recursive: true });
      const next = `${link}.new-${process.pid}-${Date.now()}`;
      await symlink(join(this.#d.dataDir, 'runtimes', name), next);
      await rename(next, link).catch(async (err) => {
        await rm(next, { force: true });
        throw err;
      });
    }
    this.#runtimeChanged.add(serverId);
    this.#d.hub.audit(by, 'pack runtime', serverId, name ?? 'system java');
    return this.state(s.id);
  }

  /** Compares a pack with the server folder; held for `adopt`. Refused once the server has a pack. */
  async compare(serverId: string, source: unknown, by: string): Promise<CompareReport> {
    const s = this.#server(serverId);
    if (this.#d.db.pack(serverId)) throw new PackRefused(409, `${s.name} has a pack already.`);
    const entry = this.#source(source);
    const into = this.#work(serverId);
    const kept = await this.#kept(s);
    try {
      const { root, files } = await unpack(this.#d.library.zip(entry.id), into);
      const manifest = files.filter((f) => !keptBy(f, kept)).sort();
      const own = new Set(manifest);
      const report: CompareReport = { name: entry.name, version: entry.version, matching: 0, mod: await modJars(s.dir!), notInPack: [], different: [] };
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
      this.#compared.set(serverId, { report, entry, manifest, own, timer });
      this.#d.hub.audit(by, 'pack compare', serverId, `${entry.name} ${entry.version}: ${report.matching} files match`);
      return report;
    } finally {
      await rm(into, { recursive: true, force: true });
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
    if (!this.#d.library.entry(c.entry.id)) throw new PackRefused(409, `${c.entry.name} ${c.entry.version} is no longer in the library: compare again.`);
    const at = Date.now();
    for (const target of new Set(keep as string[])) {
      const from = join(s.dir!, target);
      const sha256 = await sha256File(from);
      const id = this.#d.db.addExtra(serverId, { target, sha256, label: '', note: 'kept at adopt', by: byName, at });
      await mkdir(this.#extrasDir(serverId), { recursive: true });
      await copyFile(from, join(this.#extrasDir(serverId), String(id)));
    }
    const { id: libraryId, name, version, source, sha256 } = c.entry;
    this.#d.db.setPack(serverId, { name, version, source, sha256, by: byName, at, how: 'adopted', snapshot: JSON.stringify(this.#snapshot(serverId)), libraryId }, c.manifest, c.own);
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
    let entry: LibraryRow | undefined;
    if (source === 'pending') {
      if (!pending.length) throw new PackRefused(409, `Nothing is pending: ${pack.version} is installed as it is.`);
      if (pack.libraryId === null || !this.#d.library.entry(pack.libraryId)) {
        throw new PackRefused(409, `${pack.name} ${pack.version} isn't in the library: update to a version from the library instead.`);
      }
    } else {
      entry = this.#source(source);
      if (entry.sha256 === pack.sha256 && entry.version === pack.version && !pending.length) {
        throw new PackRefused(409, `${pack.name} ${pack.version} is installed already, with nothing pending.`);
      }
    }
    const changes = entry ? null : pending.map((p) => `${p.path} ${p.change}`);
    const job: Job = {
      id: 0,
      serverId,
      name: entry?.name ?? pack.name,
      version: entry?.version ?? pack.version,
      libraryId: entry?.id ?? pack.libraryId!,
      from: pack.version,
      actor: by,
      byName,
      started: Date.now(),
      steps: STEPS.map((step) => ({ step, state: 'waiting', detail: '' })),
      cancelled: false,
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
    void this.#run(job, s, pack, entry);
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
    else job.cancelled = true;
  }

  // The update itself.

  async #run(job: Job, s: ServerSettings, pack: PackRow, entry: LibraryRow | undefined): Promise<void> {
    const dir = s.dir!;
    const staging = join(dir, UPDATE);
    const service = this.#d.services.ofServer(s.id)!;
    const oldFiles = this.#d.db.packFiles(s.id);
    const oldOwn = new Set(this.#d.db.packFiles(s.id, true));
    let next: PackRow | undefined;
    let manifest: string[] = [];
    let own = new Set<string>();
    try {
      // 1. Prepare: the staged set, while the server runs.
      this.#step(job, 'prepare', 'running', 'Unpacking');
      await rm(join(dir, LEGACY_STAGING), { recursive: true, force: true });
      const { root, files } = await unpack(this.#d.library.zip(job.libraryId), join(staging, 'zip'));
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
      next = {
        name: job.name,
        version: job.version,
        source: entry?.source ?? pack.source,
        sha256: entry?.sha256 ?? pack.sha256,
        by: job.byName,
        at: 0,
        how: 'updated',
        snapshot: JSON.stringify(snapshot),
        libraryId: job.libraryId,
      };
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
          return await this.#end(job, 'cancelled', staging);
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
        for (const e of this.#d.db.extras(s.id)) if (e.removed) await this.#purge(s.id, e.id);
        for (const e of this.#d.db.configEdits(s.id)) if (e.failedOn) this.#d.db.updateEdit(e.id, { ...e, failedOn: null });
        this.#step(job, 'gate', 'done', `Hello after ${clock(waited)}`);
        return await this.#end(job, 'ok', staging);
      }
      this.#step(job, 'gate', 'failed', `No hello within ${formatDuration(this.#o.gateMs)}`);
      return await this.#rollback(job, s, service.id, pack, { oldFiles, oldOwn, manifest });
    } catch (err) {
      if (this.#closed) return; // left running: the next hub closes it as interrupted
      const why = (err as Error).message;
      this.#log(job, why);
      const at = job.steps.find((x) => x.state === 'running');
      if (at) this.#step(job, at.step, 'failed', why);
      if (job.touched) return await this.#rollback(job, s, service.id, pack, { oldFiles, oldOwn, manifest });
      if (job.stopped) {
        await this.#d.services.act(service.id, 'start', job.actor, job.byName).catch(() => {});
        return await this.#end(job, 'failed before swap', staging);
      }
      return await this.#end(job, job.cancelled ? 'cancelled' : 'failed in staging', staging);
    }
  }

  /** Puts the old files and records back after the health gate failed (or the swap broke), and starts the server again. */
  async #rollback(
    job: Job,
    s: ServerSettings,
    serviceId: string,
    pack: PackRow,
    { oldFiles, oldOwn, manifest }: { oldFiles: string[]; oldOwn: Set<string>; manifest: string[] },
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
        return await this.#end(job, 'rolled back', join(dir, UPDATE));
      }
      this.#log(job, `${s.name} didn't come back after the rollback either. The old files are in ${job.pre}/`);
      this.#step(job, 'rollback', 'failed', `No hello after the rollback either. The old files are in ${job.pre}/`);
    } catch (err) {
      if (this.#closed) return;
      this.#log(job, `The rollback failed: ${(err as Error).message}. The old files are in ${job.pre}/`);
      this.#step(job, 'rollback', 'failed', (err as Error).message);
    }
    return await this.#end(job, 'failed', join(dir, UPDATE));
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

  async #end(job: Job, outcome: PackFinished, staging: string): Promise<void> {
    if (this.#closed) return;
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (outcome === 'cancelled') this.#log(job, 'Cancelled: the server was not touched.');
    const finished = Date.now();
    this.#d.db.setPackUpdate(job.id, { outcome, finished, log: job.log.slice(-LOG_LINES).join('\n') });
    this.#jobs.delete(job.serverId);
    this.#d.hub.audit(job.actor, 'pack update', job.serverId, `${job.from} → ${job.version}: ${outcome}`);
    const severity: Severity = outcome === 'ok' ? 'good' : ['rolled back', 'failed', 'failed before swap'].includes(outcome) ? 'problem' : 'info';
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

  // New server.

  async #runInstall(
    i: Install,
    entry: LibraryRow,
    build: { tag: string; asset: string },
    f: { gamePort: number; memory: string; startScript: string; removeLoop: boolean; runtime: string | null },
  ): Promise<void> {
    const dir = this.#serverDir(i.id);
    const work = join(this.#d.dataDir, 'work', 'install');
    const cfg = this.#d.install!;
    try {
      await mkdir(dirname(this.#installMarker()), { recursive: true });
      await writeFile(this.#installMarker(), JSON.stringify({ id: i.id }));
      this.#installStep(i, 'unpack', `Unpacking ${entry.name} ${entry.version}`);
      if (f.runtime) {
        // First: a runtime the install will use is in use from now on.
        await mkdir(dirname(this.#javaLink(i.id)), { recursive: true });
        await symlink(join(this.#d.dataDir, 'runtimes', f.runtime), this.#javaLink(i.id));
      }
      const { root, files } = await unpack(this.#d.library.zip(entry.id), work);
      await mkdir(dirname(dir), { recursive: true });
      await rename(root, dir);

      this.#installStep(i, 'write', 'Writing eula.txt and server.properties');
      await writeFile(join(dir, 'eula.txt'), `# Accepted by ${i.byName} in orrery, ${new Date().toISOString()}\neula=true\n`);
      const props = await readFile(join(dir, 'server.properties'), 'utf8').catch(() => '');
      const port = `server-port=${f.gamePort}`;
      await writeFile(join(dir, 'server.properties'), /^server-port=.*$/m.test(props) ? props.replace(/^server-port=.*$/m, port) : `${props}${props && !props.endsWith('\n') ? '\n' : ''}${port}\n`);

      this.#installStep(i, 'mod', `Downloading ${build.asset} (${build.tag})`);
      const jar = await cfg.mods.download(build.tag, build.asset);
      await mkdir(join(dir, 'mods'), { recursive: true });
      await writeFile(join(dir, 'mods', build.asset), jar);
      const token = randomBytes(32).toString('hex');
      await mkdir(join(dir, 'config'), { recursive: true });
      await writeFile(join(dir, 'config', 'orrery.cfg'), forgeConfig({ hubHost: '127.0.0.1', hubPort: cfg.hubPort, serverId: i.id, token }), { mode: 0o600 });

      this.#installStep(i, 'write', 'Applying the Config edits');
      const at = Date.now();
      this.#d.db.addEdit(i.id, { path: f.startScript, find: MEMORY_FLAG.source, replace: `-Xm$1${f.memory}`, note: 'Memory, set at install', by: i.byName, at });
      if (f.removeLoop) this.#d.db.addEdit(i.id, { path: f.startScript, find: LOOP, replace: '$1', note: "No restart loop: systemd restarts the server", by: i.byName, at });
      for (const e of this.#d.db.configEdits(i.id)) {
        const file = join(dir, e.path);
        const content = await readFile(file, 'utf8');
        const re = new RegExp(e.find, 'gm');
        if (!re.test(content)) throw new Error(`The Config edit on ${e.path} (${e.find}) matched nothing.`);
        await writeFile(file, content.replace(re, e.replace));
      }
      // The Kept paths of the server it becomes (no `keep` yet; the backup folder `<dir>/backups`, as config defaults it).
      const kept = await this.#kept({ id: i.id, name: i.name, dir, backupDir: join(dir, 'backups'), keep: [] } as unknown as ServerSettings);
      const manifest = files.filter((x) => !keptBy(x, kept) && !MOD_JAR.test(x)).sort();
      const { name, version, source, sha256, id: libraryId } = entry;
      this.#d.db.setPack(i.id, { name, version, source, sha256, by: i.byName, at, how: 'installed', snapshot: JSON.stringify(this.#snapshot(i.id)), libraryId }, manifest, new Set(manifest));

      await writeFile(join(dir, PENDING_FILE), `${JSON.stringify({ name: i.name, startScript: f.startScript, token })}\n`, { mode: 0o600 });
      this.#d.db.addPendingServer({ id: i.id, name: i.name, dir, token, unit: `${i.id}.service`, gamePort: f.gamePort, runtime: f.runtime, by: i.byName, at: Date.now() });
      this.#installStep(i, 'done', '');
      this.#d.hub.audit(i.by, 'server install', i.id, `${i.name}: ok`);
    } catch (err) {
      if (this.#closed) return;
      const why = (err as Error).message;
      await this.#removeInstall(i.id).catch((e: Error) => console.error(`[packs] cleaning up ${i.id}'s install failed:`, e.message));
      this.#installStep(i, 'failed', why);
      this.#d.hub.audit(i.by, 'server install', i.id, `${i.name}: failed: ${why}`);
    } finally {
      // A closing hub leaves the marker: the next one removes what this install wrote.
      if (!this.#closed) await rm(this.#installMarker(), { force: true }).catch(() => {});
      await rm(work, { recursive: true, force: true }).catch(() => {});
      if (this.#install === i) this.#install = undefined;
    }
  }

  /** Removes everything an install wrote under an id: its folder, Java link, pack data and Pending row. */
  async #removeInstall(id: string): Promise<void> {
    await rm(this.#serverDir(id), { recursive: true, force: true });
    await rm(this.#javaLink(id), { force: true });
    this.#d.db.deletePackData(id);
    this.#d.db.deletePendingServer(id);
  }

  #installStep(i: Install, step: InstallStep['step'], detail: string): void {
    if (this.#closed) throw new Error('The hub is closing.');
    i.step = step;
    i.detail = detail;
    this.#d.hub.publishTarget({ target: 'install', id: i.id, type: 'install', step, detail, name: i.name, by: i.byName });
  }

  /** The name of the configured server whose `server.properties` sets this game port (25565 when it sets none). */
  async #portUser(port: number): Promise<string | undefined> {
    for (const s of this.#d.servers) {
      if (!s.dir) continue;
      const props = await readFile(join(s.dir, 'server.properties'), 'utf8').catch(() => undefined);
      if (props !== undefined && Number(/^server-port=\s*(\d+)/m.exec(props)?.[1] ?? 25565) === port) return s.name;
    }
    return undefined;
  }

  /** Names the running install's id, so the next hub can clean up after a crash. */
  #installMarker(): string {
    return join(this.#d.dataDir, 'work', 'installing.json');
  }

  #serverDir(id: string): string {
    return join(this.#d.dataDir, 'servers', id);
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

  /** A server with an adopted pack and no update running, else 404 or 409: Extras and edits change only between updates. */
  #adopted(serverId: string): ServerSettings {
    const s = this.#server(serverId);
    if (!this.#d.db.pack(serverId)) throw new PackRefused(409, `orrery doesn't know ${s.name}'s pack yet: adopt it first.`);
    if (this.#jobs.has(serverId)) throw new PackRefused(409, `A pack update is running on ${s.name}: change Extras and edits once it is done.`);
    return s;
  }

  #blocked(serverId: string, name: string): string | null {
    if (this.#jobs.has(serverId)) return `A pack update is running on ${name}.`;
    if (this.#d.restoring(serverId)) return `A restore is running on ${name}.`;
    const deploy = this.#d.deploying(serverId);
    if (deploy === 'mod') return `A Mod deploy onto ${name} is running.`;
    if (deploy === 'hub') return 'A hub deploy is running.';
    // Its Stop would clash with the countdown (`CountdownRunning`), after the backup.
    if (this.#d.restarts.pending(serverId)) return `A countdown is running on ${name}: cancel it first.`;
    return null;
  }

  #extrasDir(serverId: string): string {
    return join(this.#d.dataDir, 'extras', serverId);
  }

  /** A server's Java link, which its unit names in `PATH` and `JAVA_HOME`. */
  #javaLink(serverId: string): string {
    return join(this.#d.dataDir, 'java', serverId);
  }

  /** What the server's Java link points at, whether that waits for a restart, and the unit lines it lacks. */
  async #runtime(s: ServerSettings): Promise<PackRuntime> {
    const link = this.#javaLink(s.id);
    const target = await readlink(link).catch(() => null);
    const runtimes = join(this.#d.dataDir, 'runtimes');
    const name = target && dirname(target) === runtimes ? target.slice(runtimes.length + 1) : null;
    const env = await this.#d.services.environment(this.#d.services.ofServer(s.id)!.id);
    const names = env !== undefined && (env.split(/\s+/).includes(`JAVA_HOME=${link}`) || env.includes(`${link}/bin`));
    return {
      name,
      pending: this.#runtimeChanged.has(s.id),
      unitLines: names ? null : [`Environment=PATH=${link}/bin:/usr/local/bin:/usr/bin:/bin`, `Environment=JAVA_HOME=${link}`],
    };
  }

  /** Compare's scratch folder for a server. */
  #work(serverId: string): string {
    return join(this.#d.dataDir, 'work', serverId);
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
      `${UPDATE}/`,
      `${LEGACY_STAGING}/`,
      'mods/gtnhdiscord-*.jar',
      'mods/orrery-*.jar',
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

  /** A source: `{ library: <id> }`, an entry in the library. */
  #source(raw: unknown): LibraryRow {
    const id = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!Number.isSafeInteger(id.library) || (id.library as number) < 1) throw new PackRefused(400, 'Pick a pack version from the library.');
    const entry = this.#d.library.entry(id.library as number);
    if (!entry) throw new PackRefused(404, 'No such pack in the library.');
    return entry;
  }

  /** Takes an upload for use: it is gone from the list (its file is the caller's). */
  #take(id: unknown): Upload {
    const up = this.#d.uploads.take(id);
    if (!up) throw new PackRefused(400, 'Upload the file (again).');
    return up;
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

/** A pack's start scripts: the plain `*.sh` files at its content root, each with whether it loops (`LOOP` matches) and sets the heap. */
export async function startScripts(zip: string): Promise<StartScript[]> {
  const entries = await zipEntries(zip);
  const root = contentRoot(entries);
  const prefix = root ? `${root}/` : '';
  const scripts: StartScript[] = [];
  for (const e of entries) {
    const name = e.startsWith(prefix) ? e.slice(prefix.length) : '';
    if (!SCRIPT.test(name)) continue;
    const content = await unzip(['-p', zip, e]).catch(() => '');
    scripts.push({ name, loops: new RegExp(LOOP, 'm').test(content), memory: MEMORY_FLAG.test(content) });
  }
  return scripts.sort((a, b) => a.name.localeCompare(b.name));
}

/** Forge's config format, as the Mod reads `config/orrery.cfg` (`Configuration`, category `general`). */
function forgeConfig(c: { hubHost: string; hubPort: number; serverId: string; token: string }): string {
  return [
    '# Configuration file',
    '',
    'general {',
    '    # Address of the orrery hub',
    `    S:hubHost=${c.hubHost}`,
    '',
    '    # TCP port of the hub [range: 1 ~ 65535, default: 25580]',
    `    I:hubPort=${c.hubPort}`,
    '',
    "    # This server's id in the hub's config.json",
    `    S:serverId=${c.serverId}`,
    '',
    "    # This server's token from the hub's config.json",
    `    S:token=${c.token}`,
    '}',
    '',
  ].join('\n');
}

const installed = ({ name, version, source, sha256, by, at, how }: PackRow): InstalledPack => ({ name, version, source, sha256, by, at, how });

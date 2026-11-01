// Game updates, the agent's side (docs/protocol.md, "Agent connection"): the hub decides what to run, the agent checks
// it, stages it, swaps it in, gates it and rolls it back. Steps: prepare, backup, stop (the hub's, with its countdown),
// swap, gate, and rollback when the gate fails. The hub's input is checked like any other (agent/CLAUDE.md, "Trust
// boundaries"); the hashes come from factorio.com and the mod portal, never from the hub alone.
import { createHash } from 'node:crypto';
import { constants, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentMsg, FactorioMod, PackFinished, PackStep, PackStepState, ServiceVerb } from '../../hub/src/types.ts';
import { openPlain } from './files.ts';
import { redact } from './logs.ts';
import type { Saves } from './saves.ts';
import type { UnitState } from './service.ts';
import type { Status } from './status.ts';
import { compareGlibc, glibcNeed, unpack, unxz } from './unpack.ts';
import { LIMITS, cut, type Request } from './wire.ts';

/**
 * The only hosts an update's downloads come from, and the only ones a redirect may lead to: factorio.com's game
 * downloads, and the mod portal's CDN. S11 (2026-10-31) found that the portal's authenticated mod download answers
 * 302 to dl-mod.factorio.com, whose only query key is `secure` (a signed link, no credentials).
 */
export const ALLOWED_HOSTS: readonly string[] = ['www.factorio.com', 'dl.factorio.com', 'dl-mod.factorio.com'];
/** factorio.com's sha256 of every release file: the game's hash comes from here, not from the hub. */
const SHA256SUMS = 'https://www.factorio.com/download/sha256sums/';
/** The mod portal's public API (no credentials): each mod's releases with their sha1. */
const MOD_API = 'https://mods.factorio.com/api/mods/';
const MAX_HOPS = 5;

/** A Factorio version, and a mod's: `X.Y.Z`. */
const VERSION = /^\d+\.\d+\.\d+$/;
/** A mod portal name (and never a `..` in it). */
const MOD_NAME = /^[A-Za-z0-9_. -]+$/;
/** `/opt/factorio/current`'s target, as setup writes it: relative, to one release. */
const RELEASE = /^releases\/(\d+\.\d+\.\d+)$/;

/** The headless build for this machine's architecture: its file in factorio.com's sha256 list, and its `bin/` folder. */
const BUILDS: Record<string, { tarball: (version: string) => string; bin: string }> = {
  arm64: { tarball: (v) => `factorio-headless_linux-arm64_${v}.tar.xz`, bin: 'arm64' },
  x64: { tarball: (v) => `factorio-headless_linux_${v}.tar.xz`, bin: 'x64' },
};

/** Download caps: far over a headless tarball (about 60 MB), a light mod, and the hash lists. */
const GAME_MAX = 1024 ** 3;
const MOD_MAX = 512 * 1024 ** 2;
const META_MAX = 16 * 1024 ** 2;
const SETTINGS_MAX = 64 * 1024 ** 2;
/** The releases kept besides the running one: the newest three. */
export const KEEP_RELEASES = 3;
/** The health gate's limit, and the wait for a stop to finish (factorio.service stops within 200 s). */
export const GATE_MS = 5 * 60 * 1000;
export const STOP_WAIT_MS = 5 * 60 * 1000;
/** An `updateStep` per step at most this often, unless its state changes. */
export const STEP_MS = 1000;
/**
 * A running step goes out again after this long without one (a long unpack, save, gate or rollback), so the hub, which
 * gives an update up after 15 minutes without a word, hears it is alive.
 */
export const BEAT_MS = 60_000;
/** A download that gets no byte for this long (its answer, or its body) is stopped: prepare fails. */
export const STALL_MS = 60_000;

/** The `installed` message's fields. */
export type InstalledMsg = Omit<Extract<AgentMsg, { type: 'installed' }>, 'type'>;

/** The game's own mods, as the hub counts them in an update's `to` (`GAME_MODS` in hub/src/factorio.ts; a test compares). */
export const GAME_MODS: readonly string[] = ['base', 'elevated-rails', 'quality', 'recycler', 'space-age'];

/**
 * `updateDone`'s `from` and `to`, as the hub names its row (docs/protocol.md, "Game updates"): "2.1.24 · 5 mods",
 * every enabled mod counted, the game's own included. `from`: the latest `installed`; `to`: the update's version, with
 * the game's own mods enabled in that `installed` and the update's mods. With no `installed` yet: the bare versions
 * (`from` the release `current` points at).
 */
export function labels(installed: InstalledMsg | null, current: string, req: Request<'update'>): { from: string; to: string } {
  if (!installed) return { from: current, to: req.factorio.version };
  const game = installed.mods.filter((m) => GAME_MODS.includes(m.name)).length;
  return { from: label(installed.factorio, installed.mods.length), to: label(req.factorio.version, game + req.mods.length) };
}
/** Within the hub's 256 characters for a string even for an absurd version. */
const label = (version: string, n: number) => cut(`${version} · ${n} mod${n === 1 ? '' : 's'}`, LIMITS.text);
/** What `/orrery-status` says runs: the game's version and every enabled mod (`base` and the game's own included), by name. */
export const installedOf = (s: Status): InstalledMsg => ({
  factorio: s.version,
  mods: Object.entries(s.mods)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, version]) => ({ name, version })),
});

/** An HTTP GET of `url` with no redirect followed (`redirect: 'manual'`): the agent follows them itself, checked. */
export type Http = (url: string, signal: AbortSignal) => Promise<Response>;
const http: Http = (url, signal) => fetch(url, { redirect: 'manual', signal });

/** The server's unit as an update needs it: a fresh state, and the agent's own start and stop. */
export type UnitControl = { read(): Promise<UnitState>; act(verb: ServiceVerb): Promise<void> };

export type UpdatesOptions = {
  /** The game's releases and `current` (`/opt/factorio`; the container mounts it read-only). */
  install: string;
  /** The server's data folder (`/srv/factorio`; the container writes it all). */
  data: string;
  /** The agent's bookkeeping folder (`/srv/orrery-agent/state`), for `update.json`. */
  state: string;
  /** `/etc/orrery-agent/image.json`, setup's record of the container image and its glibc. */
  image: string;
  unit: UnitControl;
  saves: Pick<Saves, 'preUpdate' | 'list' | 'hold' | 'release' | 'restore'>;
  /** Sends on the Agent connection; false while it isn't up. */
  send: (msg: AgentMsg) => boolean;
  /** `updateDone` on the Agent connection (`HubClient.deliver`): true once its write succeeded. */
  deliver: (msg: AgentMsg) => Promise<boolean>;
  /** Whether the game connection is up (the gate's last condition). */
  gameUp: () => boolean;
  /** Whether the Agent connection is up: a rollback's gate asks for the game connection only then. */
  connected: () => boolean;
  /** The latest `installed` (`HubClient`'s, kept across restarts): an update's `from` and `to` are named from it. */
  installed: () => InstalledMsg | null;
  /**
   * Rejects while one of the agent's own deploys runs (`Deploys.idle`): its restart of the agent would cut the update
   * short, so an `update` is refused then, with that error.
   */
  idle: () => Promise<void>;
  http?: Http;
  /** A tarball's bytes, decompressed (`xz -dc`). */
  decompress?: (file: string) => AsyncIterable<Buffer>;
  /** This machine's architecture, as `process.arch`. */
  arch?: string;
  gateMs?: number;
  stopWaitMs?: number;
  /** Between looks at the gate and at a stopping unit. */
  pollMs?: number;
  stepMs?: number;
  beatMs?: number;
  stallMs?: number;
  /** A clock that only goes forward (ms), for the step throttle. */
  clock?: () => number;
};

const PHASES = ['prepare', 'backup', 'stop', 'swap', 'gate', 'rollback', 'done'] as const;
type Phase = (typeof PHASES)[number];
/** The phases an update can still be cancelled in, and that a restart of the agent ends without a rollback. */
const BEFORE_SWAP: readonly Phase[] = ['prepare', 'backup', 'stop'];
const OUTCOMES: readonly PackFinished[] = ['ok', 'rolled back', 'failed in staging', 'failed before swap', 'failed', 'cancelled'];

/** An update as `state/update.json` keeps it: enough to roll back, or to report, after a restart of the agent. */
type Job = {
  id: string;
  factorio: string;
  /** The portal mods it installs. */
  mods: FactorioMod[];
  /** The gate's mod set: the release's own mods (`base`, …) and `mods`, by name; known once prepare has the release. */
  expect: Record<string, string> | null;
  /** What ran before: its version, and its mods as `/orrery-status` last said (null: not known). */
  from: { factorio: string; mods: Record<string, string> | null };
  /** `updateDone`'s `from` and `to` (`labels`). */
  label: { from: string; to: string };
  /** `current`'s target before the update, `releases/X.Y.Z`. */
  previous: string;
  /** The save a rollback loads: the pre-update save, or the newest one when the server was stopped. */
  backup: string | null;
  phase: Phase;
  outcome: PackFinished | null;
  /** The hub stopped the server for it (`updateResume`): a failure before the swap starts the old one again. */
  resumed: boolean;
};

type StepMsg = Extract<AgentMsg, { type: 'updateStep' }>;
type Running = {
  job: Job;
  abort: AbortController;
  /** While the update waits in its stop step: the hub's `updateResume` or `updateCancel` ends the wait. */
  wake: ((how: 'resume' | 'cancel') => void) | null;
  cancelled: boolean;
  /** The latest step, sent or held back by the throttle: sent again on each connect. */
  current: StepMsg | null;
  /** A step held back by the throttle, sent by `later` unless another goes out first. */
  pending: StepMsg | null;
  sent: Map<PackStep, { state: PackStepState['state']; at: number }>;
  later: NodeJS.Timeout | undefined;
  /** Sends a running step again once none went out for `beatMs`. */
  beat: NodeJS.Timeout | undefined;
};

/** A step that failed, with the detail it fails with. */
class Fail extends Error {}
/** The hub cancelled the update. */
class Cancelled extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
/** A URL as it may be shown: no query string, no fragment (a signed link's credentials). */
const bare = (u: URL) => `${u.origin}${u.pathname}`;
const reason = (err: unknown) => redact(err instanceof Error ? err.message : String(err));
const there = (path: string) => lstat(path).then(
  () => true,
  () => false,
);
const stopped = (s: UnitState) => s.active === 'inactive' || s.active === 'failed';
const count = (mods: Record<string, string>) => Object.keys(mods).length;

/**
 * A download's abort: the update's own (a cancel), or `ms` without a byte (a stall, `stalled`). Armed from the request
 * on, so an answer that never comes stalls too; `alive` after each answer and chunk, `end` once done.
 */
function watch(update: AbortSignal, ms: number) {
  const stall = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const w = {
    signal: AbortSignal.any([update, stall.signal]),
    get stalled() {
      return stall.signal.aborted;
    },
    alive() {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), ms);
    },
    end: () => clearTimeout(timer),
  };
  w.alive();
  return w;
}
type Watch = ReturnType<typeof watch>;
const newestFirst = (a: string, b: string) => {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
};

/** `fn` on the folder `dir` opened once without following a symlink: the container may swap the folder for one. */
async function within<T>(dir: string, fn: (base: string) => Promise<T>): Promise<T> {
  const fd = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return await fn(`/proc/self/fd/${fd.fd}`);
  } finally {
    await fd.close();
  }
}

/** A new file at `path` (never through a link, never over one), written whole. */
async function create(path: string): Promise<FileHandle> {
  await rm(path, { force: true }); // a file left there, or a link: removed, not followed
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
}

async function writeAll(fh: FileHandle, chunk: Uint8Array): Promise<void> {
  for (let done = 0; done < chunk.length; ) done += (await fh.write(chunk, done, chunk.length - done)).bytesWritten;
}

/**
 * `url` checked as the hub's download link (or a redirect's target): https, on `ALLOWED_HOSTS`, no port, no user. The
 * errors never show the URL's query string.
 */
export function allowedUrl(url: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  if (u.protocol !== 'https:') throw new Error(`${what} is not https`);
  if (!ALLOWED_HOSTS.includes(u.hostname)) throw new Error(`${what} is on ${u.hostname}, not a host updates come from (${ALLOWED_HOSTS.join(', ')})`);
  if (u.port !== '' || u.username !== '' || u.password !== '') throw new Error(`${what} names a port or a user`);
  return u;
}

/**
 * The hub's `update` checked before anything happens (the reply refuses it): versions `X.Y.Z`, mod names of letters,
 * digits, `_`, `.`, `-` and spaces with no `..`, each mod once, `orrery` among them (the gate reads its
 * `/orrery-status`), hashes in hex, every URL allowed (`allowedUrl`), and a headless build for this machine.
 */
export function checkUpdate(req: Request<'update'>, arch: string): void {
  const { factorio, mods } = req;
  if (!BUILDS[arch]) throw new Error(`there is no Factorio headless build for this machine (${arch})`);
  if (!VERSION.test(factorio.version)) throw new Error(`${JSON.stringify(factorio.version)} is not a Factorio version (X.Y.Z)`);
  allowedUrl(factorio.url, `Factorio ${factorio.version}'s download`);
  if (!/^[0-9a-f]{64}$/.test(factorio.sha256)) throw new Error(`Factorio ${factorio.version}'s sha256 is not 64 hex digits`);
  const names = new Set<string>();
  for (const mod of mods) {
    if (!MOD_NAME.test(mod.name) || mod.name.includes('..')) throw new Error(`${JSON.stringify(mod.name)} is not a mod name`);
    if (names.has(mod.name)) throw new Error(`${mod.name} is in the mods twice`);
    names.add(mod.name);
    if (!VERSION.test(mod.version)) throw new Error(`${JSON.stringify(mod.version)} is not a version of ${mod.name} (X.Y.Z)`);
    allowedUrl(mod.url, `${mod.name} ${mod.version}'s download`);
    if (!/^[0-9a-f]{40}$/.test(mod.sha1)) throw new Error(`${mod.name} ${mod.version}'s sha1 is not 40 hex digits`);
  }
  if (!names.has('orrery')) throw new Error('the mods must include orrery: the health gate reads its /orrery-status');
}

/** factorio.com's sha256 list: file name to hash. */
function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)\s*$/.exec(line);
    if (m) sums.set(m[2]!, m[1]!);
  }
  return sums;
}

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

/** How a mod set differs from the one expected, briefly. */
function differences(want: Record<string, string>, got: Record<string, string>): string | null {
  const out: string[] = [];
  for (const [name, version] of Object.entries(want)) {
    if (!Object.hasOwn(got, name)) out.push(`${name} missing`);
    else if (got[name] !== version) out.push(`${name} ${got[name]}, not ${version}`);
  }
  for (const name of Object.keys(got)) if (!Object.hasOwn(want, name)) out.push(`${name} extra`);
  if (out.length === 0) return null;
  return out.length > 5 ? `${out.slice(0, 5).join(', ')} and ${out.length - 5} more` : out.join(', ');
}

/** `update.json` as the agent wrote it (its own folder), shape-checked anyway; null if it isn't one. */
function readJob(raw: unknown): Job | null {
  if (!isObject(raw) || !isObject(raw.from)) return null;
  const from = raw.from;
  const record = (v: unknown) => v === null || (isObject(v) && Object.values(v).every((x) => typeof x === 'string' && VERSION.test(x)));
  const ok =
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    raw.id.length <= LIMITS.text &&
    typeof raw.factorio === 'string' &&
    VERSION.test(raw.factorio) &&
    Array.isArray(raw.mods) &&
    raw.mods.length <= LIMITS.mods &&
    raw.mods.every((m) => isObject(m) && typeof m.name === 'string' && MOD_NAME.test(m.name) && typeof m.version === 'string' && VERSION.test(m.version)) &&
    record(raw.expect) &&
    typeof from.factorio === 'string' &&
    VERSION.test(from.factorio) &&
    record(from.mods) &&
    isObject(raw.label) &&
    [raw.label.from, raw.label.to].every((l) => typeof l === 'string' && l.length > 0 && l.length <= LIMITS.text) &&
    typeof raw.previous === 'string' &&
    RELEASE.test(raw.previous) &&
    (raw.backup === null || (typeof raw.backup === 'string' && raw.backup.length <= LIMITS.text && /^[^/\0]+\.zip$/.test(raw.backup))) &&
    PHASES.includes(raw.phase as Phase) &&
    (raw.outcome === null || OUTCOMES.includes(raw.outcome as PackFinished)) &&
    typeof raw.resumed === 'boolean';
  return ok ? (raw as unknown as Job) : null;
}

/**
 * Game updates on this agent's server, one at a time (agent/CLAUDE.md, `src/update.ts`):
 *
 * 1. prepare: the hub's `update` checked (`checkUpdate`; a refusal is the reply's); the game's sha256 checked against
 *    factorio.com's list and each mod's sha1 against the mod portal's, before any download; the tarball downloaded to
 *    `<install>/.incoming/` (only when the release isn't there yet), checked, unpacked (`unpack`) and its binary's
 *    glibc need checked against the image's (`image.json`) before it becomes `<install>/releases/<ver>/`; the mods
 *    downloaded to `<data>/.incoming/`, checked and staged in `<data>/mods.next/` with a `mod-list.json` and
 *    `mod-settings.dat` carried over. Downloads follow redirects only to `ALLOWED_HOSTS`, at most 5, with caps, and
 *    stop after `STALL_MS` without a byte.
 * 2. backup: a pre-update save while the server runs, else the newest save; held from pruning until the end.
 * 3. stop, the hub's: `waiting` (its only state that goes out) until the hub stopped the server (`updateResume`) or
 *    cancelled the update (`updateCancel`, which never starts or stops the unit).
 * 4. swap: the unit checked stopped, `current` flipped to the new release, `mods` to `mods.prev`, `mods.next` to
 *    `mods`, the unit started.
 * 5. gate, 5 minutes at most: `/orrery-status` with the new version and exactly the expected mods, and the game
 *    connection up.
 * 6. rollback, when the swap or the gate failed: the old `current`, `mods.prev` back (its `mod-settings.dat` with it),
 *    the backup copied as the newest save, started and gated again (the game connection only while the Agent
 *    connection is up): `rolled back`, or `failed`.
 *
 * `<state>/update.json` (the agent's own folder: a file of that name under `<data>` is never read) records each phase
 * before it acts, so a restart of the agent ends an update before the swap as failed and rolls one back from the swap
 * on. Steps go out as `updateStep` (one per step per second at most, unless the state changes; the latest again on
 * each connect; a running one again after `BEAT_MS` without one), the end as `updateDone` (`from` and `to`: `labels`),
 * kept until its write on the Agent connection succeeded, and sent again on each connect until then. No detail carries a query string.
 */
export class Updates {
  #o: Required<UpdatesOptions>;
  #running: Running | null = null;
  #done: Extract<AgentMsg, { type: 'updateDone' }> | null = null;
  #removing: Promise<unknown> = Promise.resolve();
  /** An `update` being checked: a second one meanwhile is refused. */
  #starting = false;
  /** What `/orrery-status` said last: the next update's `from`. */
  #known: Status | null = null;
  /** Its latest answer since the gate's start, null before one: the gate's evidence. */
  #latest: Status | null = null;

  constructor(options: UpdatesOptions) {
    this.#o = {
      http,
      decompress: unxz,
      arch: process.arch,
      gateMs: GATE_MS,
      stopWaitMs: STOP_WAIT_MS,
      pollMs: 1000,
      stepMs: STEP_MS,
      beatMs: BEAT_MS,
      stallMs: STALL_MS,
      clock: () => performance.now(),
      ...options,
    };
  }

  /**
   * Whether an update runs, or one is being checked or recovered after a restart (`#starting`, the gap before it
   * runs): a restore and a deploy are refused then.
   */
  get busy(): boolean {
    return this.#running !== null || this.#starting;
  }

  get #file(): string {
    return join(this.#o.state, 'update.json');
  }

  /**
   * After a restart of the agent: an update `update.json` records ends now. Before the swap: as failed, nothing changed
   * (the old server started again if the hub had stopped it); from the swap on: rolled back. A finished one's
   * `updateDone` is sent again.
   */
  async start(): Promise<void> {
    let job: Job | null = null;
    this.#starting = true; // no update from the hub before this one is known
    try {
      job = readJob(JSON.parse(await readFile(this.#file, 'utf8')));
      if (!job) {
        console.error(`[update] ${this.#file} is not an update: removed`);
        await rm(this.#file, { force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[update] can't read ${this.#file}: ${reason(err)}`);
    } finally {
      this.#starting = false;
    }
    if (!job) return;
    if (job.backup) this.#o.saves.hold(job.backup);
    if (job.phase === 'done') {
      this.#done = this.#doneMsg(job);
      return this.#flush();
    }
    const r = this.#begin(job);
    console.log(`[update] the agent restarted during update ${job.id} (${job.phase})`);
    if (BEFORE_SWAP.includes(job.phase)) {
      this.#step(r, job.phase as PackStep, 'failed', 'The agent restarted before the swap: nothing was changed');
      await this.#clean();
      const unit = await this.#o.unit.read().catch(() => null);
      const restart = job.resumed || (job.phase === 'stop' && unit !== null && stopped(unit));
      if (restart) await this.#startOld();
      return this.#finish(r, restart ? 'failed before swap' : 'failed in staging');
    }
    if (job.phase !== 'rollback') this.#step(r, job.phase as PackStep, 'failed', 'The agent restarted before the health gate passed');
    await this.#finish(r, await this.#rollback(r));
  }

  /** Stops the step throttle's timers (the agent exits; `update.json` stays for the next start). */
  stop(): void {
    clearTimeout(this.#running?.later);
    clearTimeout(this.#running?.beat);
  }

  /** Each `/orrery-status` answer: the gate's evidence, and the next update's `from`. */
  status(s: Status): void {
    this.#known = s;
    this.#latest = s;
  }

  /** The Agent connection is up again: the running update's latest step, and an `updateDone` not yet sent. */
  connected(): void {
    const r = this.#running;
    if (r?.current) this.#send(r, r.current);
    this.#flush();
  }

  /**
   * The hub's `update`: checked, then started; resolves once accepted (the reply), the steps follow. Refused while
   * another runs, one's `updateDone` waits to be sent, or a deploy of the agent runs (`idle`).
   */
  async update(req: Request<'update'>): Promise<void> {
    if (this.#running) throw new Error(`the update ${this.#running.job.id} is running`);
    if (this.#starting) throw new Error('another update is being checked');
    if (this.#done) throw new Error(`the update ${this.#done.id} has not been reported yet`);
    this.#starting = true; // before the deploy check: a deploy is refused from here on (busy)
    try {
      await this.#o.idle();
      checkUpdate(req, this.#o.arch);
      const previous = await this.#current();
      const fromVersion = previous.slice('releases/'.length);
      const known = this.#known?.version === fromVersion ? this.#known.mods : null;
      await this.#removing;
      const job: Job = {
        id: req.id,
        factorio: req.factorio.version,
        mods: req.mods.map(({ name, version }) => ({ name, version })),
        expect: null,
        from: { factorio: fromVersion, mods: known },
        label: labels(this.#o.installed(), fromVersion, req),
        previous,
        backup: null,
        phase: 'prepare',
        outcome: null,
        resumed: false,
      };
      await this.#save(job);
      console.log(`[update] ${job.id}: from ${job.label.from} to ${job.label.to}`);
      void this.#run(this.#begin(job), req);
    } catch (err) {
      throw new Error(reason(err));
    } finally {
      this.#starting = false;
    }
  }

  /**
   * The hub's `updateResume`: it stopped the server for the update waiting in its stop step. Its request id is its
   * own (docs/protocol.md): it acts on the one update running.
   */
  async resume(): Promise<void> {
    const r = this.#running;
    if (!r) throw new Error('no update is running');
    if (!r.wake) throw new Error(`the update ${r.job.id} is not waiting for the server to stop`);
    r.wake('resume');
  }

  /**
   * The hub's `updateCancel`, with a request id of its own, on the one update running: only before the swap; the
   * downloads stop and `.incoming` is cleaned. It never starts or stops the unit: a server the hub stopped, it starts.
   */
  async cancel(): Promise<void> {
    const r = this.#running;
    if (!r) throw new Error('no update is running');
    if (!BEFORE_SWAP.includes(r.job.phase)) throw new Error(`the update ${r.job.id} is past the swap: too late to cancel`);
    r.cancelled = true;
    r.abort.abort();
    r.wake?.('cancel');
  }

  #begin(job: Job): Running {
    const r: Running = { job, abort: new AbortController(), wake: null, cancelled: false, current: null, pending: null, sent: new Map(), later: undefined, beat: undefined };
    this.#running = r;
    return r;
  }

  async #run(r: Running, req: Request<'update'>): Promise<void> {
    const { job } = r;
    let step: PackStep = 'prepare';
    try {
      await this.#prepare(r, req);
      this.#check(r);
      step = 'backup';
      await this.#backup(r);
      this.#check(r);
      step = 'stop';
      await this.#stop(r);
      // The stop is the hub's: the swap starts by checking that it is done.
      step = 'swap';
      this.#step(r, 'swap', 'running', 'Checking that the server is stopped');
      await this.#stopped();
      this.#check(r);
      job.phase = 'swap'; // at once: no cancel from here on
    } catch (err) {
      this.#step(r, step, 'failed', r.cancelled ? 'Cancelled by the hub' : reason(err));
      if (!r.cancelled && !(err instanceof Fail)) console.error(`[update] ${job.id}: ${reason(err)}`);
      await this.#clean();
      if (job.resumed && !r.cancelled) await this.#startOld(); // a cancel never starts the unit: the hub does
      return this.#finish(r, r.cancelled ? 'cancelled' : job.resumed ? 'failed before swap' : 'failed in staging');
    }
    let outcome: PackFinished;
    step = 'swap';
    try {
      await this.#swap(r);
      step = 'gate';
      this.#step(r, 'gate', 'running', `Waiting for Factorio ${job.factorio} with exactly its mods, and the game connection (${Math.round(this.#o.gateMs / 1000)} s at most)`);
      const ok = await this.#gate(job.factorio, job.expect);
      this.#step(r, 'gate', 'done', ok);
      outcome = 'ok';
    } catch (err) {
      this.#step(r, step, 'failed', reason(err));
      outcome = await this.#rollback(r);
    }
    await this.#finish(r, outcome);
  }

  #check(r: Running): void {
    if (r.cancelled) throw new Cancelled('cancelled');
  }

  async #prepare(r: Running, req: Request<'update'>): Promise<void> {
    const { job } = r;
    const { install, data } = this.#o;
    const build = BUILDS[this.#o.arch]!;
    const v = job.factorio;
    const release = join(install, 'releases', v);
    const have = await there(release);
    this.#step(r, 'prepare', 'running', 'Checking the hashes with factorio.com and the mod portal');
    // The hashes come from factorio.com and the portal: a mismatch with the hub's fails before any download.
    const tarball = build.tarball(v);
    let gameSha: string | null = null;
    if (!have) {
      gameSha = parseSums(await this.#text(r, SHA256SUMS)).get(tarball) ?? null;
      if (gameSha === null) throw new Fail(`factorio.com's sha256 list has no ${tarball}`);
      if (gameSha !== req.factorio.sha256) throw new Fail(`The hub's sha256 for ${tarball} is not factorio.com's: nothing downloaded`);
    }
    for (const mod of req.mods) {
      this.#check(r);
      let info: unknown;
      try {
        info = JSON.parse(await this.#text(r, `${MOD_API}${encodeURIComponent(mod.name)}/full`));
      } catch (err) {
        if (err instanceof Fail || err instanceof Cancelled) throw err;
        throw new Fail(`The mod portal's answer for ${mod.name} is not JSON`);
      }
      const releases = isObject(info) && Array.isArray(info.releases) ? info.releases : [];
      const found = releases.find((x: unknown) => isObject(x) && x.version === mod.version) as Record<string, unknown> | undefined;
      if (!found || typeof found.sha1 !== 'string') throw new Fail(`The mod portal has no ${mod.name} ${mod.version}`);
      if (found.sha1 !== mod.sha1) throw new Fail(`The hub's sha1 for ${mod.name} ${mod.version} is not the mod portal's: nothing downloaded`);
    }

    await this.#clean();
    if (!have) {
      await mkdir(join(install, '.incoming'), { recursive: true });
      const file = join(install, '.incoming', tarball);
      const sha = await this.#download(r, req.factorio.url, join(install, '.incoming'), tarball, 'sha256', GAME_MAX, (got) => `Downloading Factorio ${v}: ${mb(got)}`);
      if (sha !== gameSha) throw new Fail(`The download of ${tarball} doesn't match factorio.com's sha256`);
      this.#check(r);
      this.#step(r, 'prepare', 'running', `Unpacking Factorio ${v}`);
      const unpacked = join(install, '.incoming', v);
      await mkdir(unpacked);
      try {
        await unpack(this.#o.decompress(file), unpacked);
      } catch (err) {
        throw new Fail(`Factorio ${v}'s tarball is refused: ${reason(err)}`);
      }
      await rm(file, { force: true });
      await this.#glibc(unpacked, v);
      await rename(unpacked, release);
      console.log(`[update] installed Factorio ${v} in ${release}`);
    } else await this.#glibc(release, v);
    const own = await ownMods(release);
    job.expect = { ...own, ...Object.fromEntries(job.mods.map((m) => [m.name, m.version])) };

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
          this.#check(r);
          const file = `${mod.name}_${mod.version}.zip`;
          const what = `${mod.name} ${mod.version} (${i + 1} of ${req.mods.length})`;
          const sha1 = await this.#download(r, mod.url, incoming, file, 'sha1', MOD_MAX, (got) => `Downloading ${what}: ${mb(got)}`);
          if (sha1 !== mod.sha1) throw new Fail(`The download of ${mod.name} ${mod.version} doesn't match the mod portal's sha1`);
          await rename(`${incoming}/${file}`, `${next}/${file}`);
        }
        const list = [...Object.keys(own).sort(), ...job.mods.map((m) => m.name)].map((name) => ({ name, enabled: true }));
        const fh = await create(`${next}/mod-list.json`);
        try {
          await writeAll(fh, Buffer.from(JSON.stringify({ mods: list }, null, 2) + '\n'));
        } finally {
          await fh.close();
        }
      }),
    );
    const settings = await this.#settings();
    await this.#save(job);
    this.#step(r, 'prepare', 'done', `Staged Factorio ${v} and ${plural(job.mods.length, 'mod')}${settings ? ', mod-settings.dat carried over' : ''}`);
  }

  /** The binary's highest glibc need against the image's, from setup's `image.json`. */
  async #glibc(release: string, v: string): Promise<void> {
    const bin = join(release, 'bin', BUILDS[this.#o.arch]!.bin, 'factorio');
    let need: string | null;
    try {
      need = await glibcNeed(bin);
    } catch (err) {
      throw new Fail(`Can't read Factorio ${v}'s binary: ${reason(err)}`);
    }
    if (need === null) throw new Fail(`Can't tell which glibc Factorio ${v} needs: its binary names none`);
    let have: unknown;
    try {
      have = (JSON.parse(await readFile(this.#o.image, 'utf8')) as Record<string, unknown>).glibc;
    } catch {
      have = null;
    }
    if (typeof have !== 'string' || !/^\d+\.\d+$/.test(have)) throw new Fail(`Can't read the image's glibc from ${this.#o.image}`);
    if (compareGlibc(need, have) > 0) throw new Fail(`Factorio ${v} needs glibc ${need}; the friend must re-run setup with a newer image (it has glibc ${have})`);
  }

  /** `mods/mod-settings.dat` copied into `mods.next` (replacing one there): true if there was one. */
  async #settings(): Promise<boolean> {
    const { data } = this.#o;
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
        } finally {
          await out.close();
        }
      });
    } finally {
      await src.fh.close();
    }
    return true;
  }

  async #backup(r: Running): Promise<void> {
    const { job } = r;
    job.phase = 'backup';
    await this.#save(job);
    this.#step(r, 'backup', 'running', `Saving the game as orrery-pre-update-${job.from.factorio}`);
    const unit = await this.#o.unit.read();
    if (unit.active === 'active') {
      job.backup = await this.#o.saves.preUpdate(job.from.factorio);
      await this.#save(job);
      return this.#step(r, 'backup', 'done', `Saved ${job.backup}`);
    }
    job.backup = (await this.#o.saves.list()).saves[0]?.name ?? null;
    if (job.backup) this.#o.saves.hold(job.backup);
    await this.#save(job);
    this.#step(r, 'backup', 'done', job.backup ? `The server is stopped: no save made; a rollback loads ${job.backup}, the newest` : 'The server is stopped and has no saves');
  }

  /** The stop step, the hub's: `waiting` until its `updateResume` (it stopped the server) or `updateCancel`. */
  async #stop(r: Running): Promise<void> {
    const { job } = r;
    job.phase = 'stop';
    await this.#save(job);
    this.#step(r, 'stop', 'waiting', 'Waiting for the hub to stop the server');
    const how = await new Promise<'resume' | 'cancel'>((resolve) => {
      r.wake = resolve;
      if (r.cancelled) resolve('cancel');
    });
    r.wake = null;
    if (how === 'cancel') throw new Cancelled('cancelled');
    job.resumed = true;
    await this.#save(job);
  }

  async #swap(r: Running): Promise<void> {
    const { job } = r;
    const { data } = this.#o;
    await this.#save(job); // the swap phase, before anything moves
    this.#step(r, 'swap', 'running', `Putting Factorio ${job.factorio} and ${plural(job.mods.length, 'mod')} in place`);
    this.#latest = null;
    // Factorio writes mod-settings.dat as it stops: the copy prepare made is taken again, as it is now.
    const settings = await this.#settings();
    await this.#flip(`releases/${job.factorio}`);
    await rm(join(data, 'mods.prev'), { recursive: true, force: true });
    if (await there(join(data, 'mods'))) await rename(join(data, 'mods'), join(data, 'mods.prev'));
    await rename(join(data, 'mods.next'), join(data, 'mods'));
    job.phase = 'gate';
    await this.#save(job);
    await this.#o.unit.act('start');
    this.#step(r, 'swap', 'done', `Factorio ${job.factorio} and ${plural(job.mods.length, 'mod')} in place${settings ? ', with mod-settings.dat' : ''}; the server is starting`);
  }

  /**
   * Resolves with the gate's detail once `/orrery-status` says `version` with exactly `mods` (unless null) and the
   * game connection is up. A rollback's (`back`) asks for the game connection only while the Agent connection is up:
   * the old server ran with the hub before, so with the hub unreachable its RCON answer is enough.
   */
  async #gate(version: string, mods: Record<string, string> | null, back = false): Promise<string> {
    const until = performance.now() + this.#o.gateMs;
    let why = 'no /orrery-status answer';
    for (;;) {
      const s = this.#latest;
      if (s) {
        const diff = mods && differences(mods, s.mods);
        const game = this.#o.gameUp();
        if (s.version !== version) why = `/orrery-status says Factorio ${s.version}, not ${version}`;
        else if (diff) why = `/orrery-status lists other mods: ${diff}`;
        else if (!game && (!back || this.#o.connected())) why = 'the game connection to the hub is not up';
        else return `Factorio ${version} answers with ${mods ? `exactly its ${plural(count(mods), 'mod')}` : 'its mods'}, ${game ? 'and the game connection is up' : 'with the hub unreachable'}`;
      }
      if (performance.now() >= until) throw new Fail(`Not up within ${Math.round(this.#o.gateMs / 1000)} s: ${why}`);
      await sleep(this.#o.pollMs);
    }
  }

  async #rollback(r: Running): Promise<PackFinished> {
    const { job } = r;
    const { data } = this.#o;
    const back = job.previous.slice('releases/'.length);
    this.#step(r, 'rollback', 'running', `Going back to Factorio ${back}, its mods and the pre-update save`);
    try {
      job.phase = 'rollback';
      await this.#save(job);
      const unit = await this.#o.unit.read();
      if (!stopped(unit)) await this.#o.unit.act('stop');
      await this.#stopped();
      this.#latest = null;
      await this.#flip(job.previous);
      if (await there(join(data, 'mods.prev'))) {
        await rm(join(data, 'mods'), { recursive: true, force: true });
        await rename(join(data, 'mods.prev'), join(data, 'mods'));
      }
      await rm(join(data, 'mods.next'), { recursive: true, force: true });
      let save = '';
      if (job.backup) {
        try {
          await this.#o.saves.restore(job.backup);
          save = `, ${job.backup} copied as the newest save`;
        } catch (err) {
          console.error(`[update] ${job.id}: can't copy ${job.backup} as the newest save: ${reason(err)}`);
          save = `; ${job.backup} could not be copied as the newest save (${reason(err)})`;
        }
      }
      await this.#o.unit.act('start');
      this.#step(r, 'rollback', 'running', `Back on Factorio ${back}${save}: waiting for it to come up`);
      await this.#gate(back, job.from.mods, true);
      this.#step(r, 'rollback', 'done', `Back on Factorio ${back} with its mods${save}`);
      return 'rolled back';
    } catch (err) {
      this.#step(r, 'rollback', 'failed', reason(err));
      return 'failed';
    }
  }

  async #finish(r: Running, outcome: PackFinished): Promise<void> {
    const { job } = r;
    clearTimeout(r.later);
    clearTimeout(r.beat);
    job.phase = 'done';
    job.outcome = outcome;
    await this.#save(job).catch((err: Error) => console.error(`[update] can't write ${this.#file}: ${reason(err)}`));
    if (job.backup) this.#o.saves.release(job.backup);
    await this.#clean();
    await this.#prune().catch((err: Error) => console.error(`[update] can't prune ${this.#o.install}/releases: ${reason(err)}`));
    console.log(`[update] ${job.id}: ${outcome}`);
    this.#running = null;
    this.#done = this.#doneMsg(job);
    this.#flush();
  }

  #doneMsg(job: Job): Extract<AgentMsg, { type: 'updateDone' }> {
    const outcome = job.outcome ?? 'failed';
    const msg = { type: 'updateDone', id: job.id, outcome, from: job.label.from, to: job.label.to } as const;
    return job.backup ? { ...msg, backup: job.backup } : msg;
  }

  /**
   * The pending `updateDone`, sent if the Agent connection is up: only once its write succeeded is it done with, and
   * `update.json` goes. Until then it stays pending, and goes again on each connect (the hub ignores a repeat).
   */
  #flush(): void {
    const msg = this.#done;
    if (!msg) return;
    void this.#o.deliver(msg).then((written) => {
      if (!written || this.#done !== msg) return;
      this.#done = null;
      this.#removing = rm(this.#file, { force: true }).catch((err: Error) => console.error(`[update] can't remove ${this.#file}: ${reason(err)}`));
    });
  }

  /**
   * An `updateStep`, cut and redacted, and logged. The stop is the hub's (docs/protocol.md, "Game updates"): of the
   * `stop` step only `waiting` goes out, and how it ended (a cancel, a restart of the agent) is only logged.
   */
  #step(r: Running, step: PackStep, state: PackStepState['state'], detail: string): void {
    const msg: StepMsg = { type: 'updateStep', id: r.job.id, step, state, detail: cut(redact(detail), LIMITS.detail) };
    console.log(`[update] ${r.job.id}: ${step} ${state}: ${msg.detail}`);
    if (step === 'stop' && state !== 'waiting') return;
    this.#emit(r, msg);
  }

  /** A download's progress, as a prepare step's detail: not logged. */
  #progress(r: Running, detail: string): void {
    this.#emit(r, { type: 'updateStep', id: r.job.id, step: 'prepare', state: 'running', detail: cut(redact(detail), LIMITS.detail) });
  }

  /**
   * Sends a step, unless the same step went out in the same state less than a second ago: then it is held, and sent
   * once the second is up unless another goes out first (a held one never follows a newer one).
   */
  #emit(r: Running, msg: StepMsg): void {
    r.current = msg;
    const last = r.sent.get(msg.step);
    const now = this.#o.clock();
    if (last && last.state === msg.state && now - last.at < this.#o.stepMs) {
      r.pending = msg;
      r.later ??= setTimeout(() => {
        r.later = undefined;
        const held = r.pending;
        if (held && this.#running === r) this.#send(r, held);
      }, this.#o.stepMs - (now - last.at));
      return;
    }
    this.#send(r, msg);
  }

  #send(r: Running, msg: StepMsg): void {
    r.pending = null;
    r.sent.set(msg.step, { state: msg.state, at: this.#o.clock() });
    this.#o.send(msg);
    clearTimeout(r.beat);
    r.beat = setTimeout(() => this.#beat(r), this.#o.beatMs).unref();
  }

  /**
   * No step went out for `beatMs`: a running one goes again, as it is (through the throttle). Never a `waiting` one,
   * which asks the hub to stop the server (and the hub doesn't count its own stop as the agent's silence).
   */
  #beat(r: Running): void {
    r.beat = undefined;
    if (this.#running === r && r.current?.state === 'running') this.#emit(r, r.current);
  }

  /** Waits until the unit is inactive or failed, 5 minutes at most. */
  async #stopped(): Promise<void> {
    const until = performance.now() + this.#o.stopWaitMs;
    for (;;) {
      const s = await this.#o.unit.read();
      if (stopped(s)) return;
      if (performance.now() >= until) throw new Fail(`The server is still ${s.active} (${s.sub}) after ${Math.round(this.#o.stopWaitMs / 1000)} s`);
      await sleep(this.#o.pollMs);
    }
  }

  /** The old server again, after a failure before the swap, if the hub had stopped it. */
  async #startOld(): Promise<void> {
    try {
      const s = await this.#o.unit.read();
      if (stopped(s)) await this.#o.unit.act('start');
    } catch (err) {
      console.error(`[update] can't start the server again: ${reason(err)}`);
    }
  }

  /** `current`'s target, `releases/X.Y.Z`, checked: the only form the agent (and setup) write. */
  async #current(): Promise<string> {
    const target = await readlink(join(this.#o.install, 'current')).catch(() => null);
    if (target === null || !RELEASE.test(target)) throw new Error(`${this.#o.install}/current does not point at a release (releases/X.Y.Z)`);
    if (!(await lstat(join(this.#o.install, target)).catch(() => null))?.isDirectory()) throw new Error(`${this.#o.install}/${target} is not there`);
    return target;
  }

  /** Points `current` at `target` in one rename, as setup does (relative, `releases/X.Y.Z`), checked first. */
  async #flip(target: string): Promise<void> {
    if (!RELEASE.test(target)) throw new Error(`${JSON.stringify(target)} is not a release`);
    const current = join(this.#o.install, 'current');
    if ((await readlink(current).catch(() => null)) === target) return;
    const tmp = join(this.#o.install, '.current.new');
    await rm(tmp, { force: true });
    await symlink(target, tmp);
    await rename(tmp, current);
  }

  /** Keeps the newest three releases and the running one. */
  async #prune(): Promise<void> {
    const dir = join(this.#o.install, 'releases');
    const versions = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && VERSION.test(d.name))
      .map((d) => d.name)
      .sort(newestFirst);
    const running = (await this.#current().catch(() => null))?.slice('releases/'.length);
    const keep = new Set([...versions.slice(0, KEEP_RELEASES), running]);
    for (const v of versions) {
      if (keep.has(v)) continue;
      await rm(join(dir, v), { recursive: true, force: true });
      console.log(`[update] removed Factorio ${v} from ${dir}`);
    }
  }

  /** Empties both `.incoming` folders, and removes `mods.next`. */
  async #clean(): Promise<void> {
    const { install, data } = this.#o;
    for (const dir of [join(install, '.incoming'), join(data, '.incoming')]) {
      await within(dir, async (base) => {
        for (const name of await readdir(base)) await rm(`${base}/${name}`, { recursive: true, force: true });
      }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') console.error(`[update] can't clean ${dir}: ${reason(err)}`);
      });
    }
    await rm(join(data, 'mods.next'), { recursive: true, force: true }).catch((err: Error) => console.error(`[update] can't remove mods.next: ${reason(err)}`));
  }

  async #save(job: Job): Promise<void> {
    await mkdir(this.#o.state, { recursive: true });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(job) + '\n');
    await rename(tmp, this.#file);
  }

  /**
   * A GET, following redirects itself (5 at most), each only to an allowed https host: `url` is the hub's (checked
   * too) or, `ours`, one of the agent's own (the hash lists). Anything but 200 at the end fails, and so does a 200 whose
   * `Content-Length` is over `cap`; so does an answer that doesn't come within the stall time (`w`).
   */
  async #get(r: Running, url: string, ours: boolean, w: Watch, cap: number): Promise<{ res: Response; at: URL }> {
    let at = ours ? new URL(url) : allowedUrl(url, 'the download');
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await this.#o.http(at.href, w.signal);
      } catch (err) {
        if (r.abort.signal.aborted) throw new Cancelled('cancelled');
        if (w.stalled) throw this.#stalled(at);
        throw new Fail(`Can't download ${bare(at)}: ${reason((err as Error).cause ?? err)}`);
      }
      w.alive();
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get('location');
        if (!location) throw new Fail(`${bare(at)} answered ${res.status} with no Location`);
        if (hop >= MAX_HOPS) throw new Fail(`${bare(at)}: over ${MAX_HOPS} redirects`);
        let next: string;
        try {
          next = new URL(location, at).href;
        } catch {
          throw new Fail(`${bare(at)} redirected to something that is not a URL`);
        }
        try {
          at = allowedUrl(next, `${bare(at)}'s redirect`);
        } catch (err) {
          throw new Fail(reason(err));
        }
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        throw new Fail(`${bare(at)} answered HTTP ${res.status}`);
      }
      if (Number(res.headers.get('content-length')) > cap) {
        await res.body?.cancel().catch(() => {});
        throw new Fail(`${bare(at)} is over ${mb(cap)}`);
      }
      return { res, at };
    }
  }

  /** The step error for a download that got no byte for the stall time. */
  #stalled(at: URL): Fail {
    return new Fail(`No data from ${bare(at)} for ${this.#o.stallMs / 1000} s: the download was stopped`);
  }

  /** One of the agent's own URLs as text, 16 MiB at most. */
  async #text(r: Running, url: string): Promise<string> {
    const w = watch(r.abort.signal, this.#o.stallMs);
    try {
      const { res, at } = await this.#get(r, url, true, w, META_MAX);
      const parts: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of res.body ?? []) {
          w.alive();
          size += chunk.length;
          if (size > META_MAX) throw new Fail(`${bare(at)} is over ${mb(META_MAX)}`);
          parts.push(Buffer.from(chunk));
        }
      } catch (err) {
        if (r.abort.signal.aborted) throw new Cancelled('cancelled');
        if (err instanceof Fail) throw err;
        if (w.stalled) throw this.#stalled(at);
        throw new Fail(`Can't read ${bare(at)}: ${reason(err)}`);
      }
      return Buffer.concat(parts).toString('utf8');
    } finally {
      w.end();
    }
  }

  /** The hub's `url` into `<dir>/<name>` (a new file), `cap` bytes at most; resolves with its hash in hex. */
  async #download(r: Running, url: string, dir: string, name: string, algo: 'sha1' | 'sha256', cap: number, progress: (got: number) => string): Promise<string> {
    const w = watch(r.abort.signal, this.#o.stallMs);
    try {
      const { res, at } = await this.#get(r, url, false, w, cap);
      const file = `${dir}/${name}`;
      const fh = await create(file);
      const hash = createHash(algo);
      let got = 0;
      try {
        for await (const chunk of res.body ?? []) {
          w.alive();
          got += chunk.length;
          if (got > cap) throw new Fail(`${bare(at)} is over ${mb(cap)}`);
          hash.update(chunk);
          await writeAll(fh, chunk);
          this.#progress(r, progress(got));
        }
      } catch (err) {
        await fh.close();
        await rm(file, { force: true });
        if (r.abort.signal.aborted) throw new Cancelled('cancelled');
        if (err instanceof Fail) throw err;
        if (w.stalled) throw this.#stalled(at);
        throw new Fail(`Can't download ${bare(at)}: ${reason(err)}`);
      }
      await fh.close();
      return hash.digest('hex');
    } finally {
      w.end();
    }
  }
}

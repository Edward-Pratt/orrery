// The server's saves as Backups (Factorio's `saves/` folder): listed with their kind and the current world, a named
// save on the hub's request and every 6 h after play, pruning, and a restore by copy.
import { EventEmitter } from 'node:events';
import { constants, link, lstat, open, readdir, statfs, unlink, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { posix } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentMsg, Save, SaveKind } from '../../hub/src/types.ts';
import { head, openPlain } from './files.ts';
import { RconNoAnswer } from './rcon.ts';
import type { UnitState } from './service.ts';
import { LIMITS, printable } from './wire.ts';

/** A named save every 6 h, if anyone played since the last one. */
export const SAVE_EVERY_MS = 6 * 60 * 60 * 1000;
/** The named saves kept (the newest; pre-update ones count), and the world files. */
export const KEEP_NAMED = 20;
export const KEEP_WORLD = 3;
/** A save is written once its file's size and time held for 5 s; it may take 5 minutes at most. */
export const STABLE_MS = 5000;
export const SAVE_WAIT_MS = 5 * 60 * 1000;
/**
 * A restored copy's time is this much newer than every other file's: `--start-server-load-latest` loads the newest
 * save, telling times apart only to the second.
 */
const NEWER_MS = 2000;
/** Far past where Factorio logs the map it loads (its start); the rest of the log is not read. */
const HEAD_MAX = 1024 * 1024;

/** The agent's own saves: `orrery-<time>.zip`, or before an update `orrery-pre-update-<from>-<time>.zip`. */
const NAMED = /^orrery-(?:pre-update-\d+\.\d+\.\d+-)?\d{8}T\d{6}Z\.zip$/;

/**
 * A copy while it is written: a restore's `.restored-<time>-<name>.partial` (the name a listed save's), or a game
 * update's `.orrery-pre-update-<from>-<time>.zip.partial` (`keep`).
 */
const PARTIAL = /^\.(?:restored-\d{8}T\d{6}Z-.+|orrery-pre-update-\d+\.\d+\.\d+-\d{8}T\d{6}Z)\.zip\.partial$/;
/** The prefixes earlier restores put on a name: a restored copy's name carries only the newest one. */
const RESTORED = /^(?:restored-\d{8}T\d{6}Z-)+/;

/** What kind of save a file is, by its name: the agent's (`named`), Factorio's autosave (`auto`), or anything else (`world`). */
export const kindOf = (name: string): SaveKind => (NAMED.test(name) ? 'named' : name.startsWith('_autosave') ? 'auto' : 'world');

/** A time as save names carry it, UTC: `20261031T120000Z` (`/orrery-save` takes letters, digits, `.`, `_` and `-` only). */
export const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

/**
 * Factorio's own line for the map it loads, `<seconds> Loading map <absolute path>: <bytes> bytes.` (an engine
 * `Info File.cpp:N:` part allowed): a mod's `log()` line has `Script @__<mod>__/…` there, so it can't pass for one.
 */
const LOADING = /^ *\d+\.\d+ (?:\w+ [\w.]+:\d+: )?Loading map (\/.+): \d+ bytes\.$/;

/** The path in a log's last `Loading map` line (only whole lines count); null if it has none. */
export function loadedMap(log: string): string | null {
  const lines = log.split('\n');
  lines.pop(); // a line still being written, or nothing
  let path: string | null = null;
  for (const raw of lines) {
    const m = LOADING.exec(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (m) path = m[1]!;
  }
  return path;
}

export type SavesMsg = Omit<Extract<AgentMsg, { type: 'saves' }>, 'type'>;
/** A save's outcome as the game connection's `backup` carries it. */
export type BackupResult = { ok: boolean; detail: string };

export type SavesOptions = {
  /** Factorio's saves folder, `<data>/saves`. */
  dir: string;
  /** `factorio-current.log`, whose `Loading map` line names the current world. */
  log: string;
  /** Runs an RCON command (`/orrery-save`). */
  run: (command: string) => Promise<string>;
  /** The unit's state now (a fresh `systemctl show`), for a restore. */
  unit: () => Promise<UnitState>;
  /** Between listings of the folder. */
  intervalMs?: number;
  /** Between looks at a save being written. */
  pollMs?: number;
  stableMs?: number;
  waitMs?: number;
  /** Wall-clock time (epoch ms): save names, the 6 h schedule, a restored copy's time. */
  now?: () => number;
};

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
/** A unit no Factorio runs from: a restore copies only then. */
const isStopped = (unit: UnitState) => unit.active === 'inactive' || unit.active === 'failed';
const span = (ms: number) => (ms >= 60_000 ? `${ms / 60_000} minutes` : `${ms / 1000} s`);
/** The saves of a kind past the newest `keep` (the list is newest first). */
const past = (saves: Save[], kind: SaveKind, keep: number) => saves.filter((s) => s.kind === kind).slice(keep);

/** Whether `/orrery-save`'s reply is `{"ok": true, "name": <name>}`. */
function saved(reply: string, name: string): boolean {
  try {
    const r = JSON.parse(reply) as unknown;
    return typeof r === 'object' && r !== null && (r as Record<string, unknown>).ok === true && (r as Record<string, unknown>).name === name;
  } catch {
    return false;
  }
}

/**
 * The server's saves (`saves/`, which the container writes and could swap for a symlink, so every operation goes
 * through the folder opened once, `O_DIRECTORY | O_NOFOLLOW`, as `/proc/self/fd/<fd>/<name>`; a file counts only if
 * it is a regular one on that folder's filesystem).
 *
 * - Lists every `*.zip` but a name with a control character (`printable`), newest first (500 at most), with its kind
 *   and `current` on the file Factorio last loaded (the log's last `Loading map` line, matched against the folder's
 *   own entries by path); emits `saves` with the free space on each change of the list (every 10 s, and after its own
 *   changes).
 * - `save`: `/orrery-save orrery-<time>.zip`, then waits until the file is there and its size and time held for 5 s (5
 *   minutes at most), and emits `backup`; one at a time. `played` makes one every 6 h if anyone played since the last.
 * - `prune` after each named save and restore: the newest 20 named saves and 3 world files stay; never the current
 *   world, nor a save `hold` keeps for a running update; autosaves are Factorio's.
 * - `restore`: copies a listed save, only while the unit is stopped, from its open handle to a new
 *   `restored-<time>-<name>` (`name` without the `restored-<time>-` prefixes of earlier restores; never over a file)
 *   whose time is 2 s past every other file's, so the next start loads it; written under a name that is no save, and
 *   given its own name only once whole and the unit is still stopped. `start` removes such a partial copy that an exit
 *   during a restore (or a `keep`) left behind, before the first listing.
 * - `keep`: a game update's held copy of a listed save, `orrery-pre-update-<from>-<time>.zip`, 2 s older than it, so
 *   a start still loads the save itself and never writes the copy.
 */
export class Saves extends EventEmitter<{ saves: [SavesMsg]; backup: [BackupResult] }> {
  #o: Required<SavesOptions>;
  #startedAt: number;
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;
  #pushed: string | null = null;
  #failing = false;
  #lastSave: number | null = null;
  #playedAt: number | null = null;
  #saving = false;
  #held = new Set<string>();

  constructor(options: SavesOptions) {
    super();
    this.#o = { intervalMs: 10_000, pollMs: 1000, stableMs: STABLE_MS, waitMs: SAVE_WAIT_MS, now: Date.now, ...options };
    this.#startedAt = this.#o.now();
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#sweep().then(() => {
      if (!this.#stopped) void this.#loop();
    });
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  /** Keeps `name` from pruning until `release`: a save a running update needs. */
  hold(name: string): void {
    this.#held.add(name);
  }

  release(name: string): void {
    this.#held.delete(name);
  }

  /** The folder now: every `*.zip` that is a regular file, newest first, and the bytes free there. */
  async list(): Promise<SavesMsg> {
    const loaded = loadedMap((await head(this.#o.log, HEAD_MAX)) ?? '');
    const current = loaded !== null && posix.dirname(posix.normalize(loaded)) === this.#o.dir ? posix.basename(loaded) : null;
    return this.#within(async (base, dev) => {
      const saves: Save[] = [];
      for (const name of await readdir(base)) {
        // A name with a control character (a newline: a forged log line) is no save: Factorio and the agent make none.
        if (!name.endsWith('.zip') || name.length > LIMITS.text || printable(name) !== name) continue;
        const st = await lstat(`${base}/${name}`).catch(() => null); // lstat: a symlink is not a file
        if (!st?.isFile() || st.dev !== dev) continue;
        saves.push({ name, size: st.size, mtime: Math.round(st.mtimeMs), kind: kindOf(name), current: name === current });
      }
      saves.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : 1));
      const fs = await statfs(base);
      return { saves: saves.slice(0, LIMITS.saves), free: fs.bavail * fs.bsize };
    });
  }

  /** Lists the folder, and emits `saves` if the list changed since the last one emitted. */
  async refresh(): Promise<void> {
    let msg: SavesMsg;
    try {
      msg = await this.list();
    } catch (err) {
      if (!this.#failing) console.error(`[saves] can't list ${this.#o.dir}: ${(err as Error).message}`);
      this.#failing = true;
      return;
    }
    if (this.#failing) console.log(`[saves] listing ${this.#o.dir} works again`);
    this.#failing = false;
    if (this.#lastSave === null) {
      // The 6 h count starts at the newest named save there (not later than now), or at the agent's start.
      const newest = msg.saves.find((s) => s.kind === 'named');
      this.#lastSave = newest ? Math.min(newest.mtime, this.#o.now()) : this.#startedAt;
    }
    const key = JSON.stringify(msg.saves);
    if (key === this.#pushed) return;
    this.#pushed = key;
    this.emit('saves', msg);
  }

  /** RCON answered `/orrery-status`: a named save is due 6 h after the last one, once anyone played since then. */
  played(online: boolean): void {
    const now = this.#o.now();
    if (online) this.#playedAt = now;
    const last = this.#lastSave;
    if (last === null || this.#saving || this.#playedAt === null || this.#playedAt <= last || now - last < SAVE_EVERY_MS) return;
    void this.save();
  }

  /**
   * A named save, `orrery-<time>`, answered by `backup`: done once the file's size and time held for 5 s, failed if
   * it isn't there (or still changing) after 5 minutes. While one is being made another does nothing: that one's
   * `backup` answers both.
   */
  async save(): Promise<void> {
    if (this.#saving) return console.log('[saves] a save is being made already: no second one');
    this.#saving = true;
    const at = this.#o.now();
    this.#lastSave = at;
    const name = `orrery-${stamp(at)}`;
    let result: BackupResult;
    try {
      result = { ok: true, detail: `Saved ${name}.zip (${mb(await this.#make(name))})` };
    } catch (err) {
      result = { ok: false, detail: `${name}.zip: ${(err as Error).message}` };
    } finally {
      this.#saving = false;
    }
    if (result.ok) console.log(`[saves] ${result.detail}`);
    else console.error(`[saves] the save failed: ${result.detail}`);
    this.emit('backup', result);
    if (result.ok) await this.prune();
    await this.refresh();
  }

  /**
   * A game update's pre-update save, `orrery-pre-update-<from>-<time>` (`from`: the version it updates from, `X.Y.Z`),
   * made and waited for like `save`'s but with no `backup` (the update's own steps report it); resolves with its file
   * name, held from pruning until `release`.
   */
  async preUpdate(from: string): Promise<string> {
    if (!/^\d+\.\d+\.\d+$/.test(from)) throw new Error(`${JSON.stringify(from)} is not a version`);
    const name = `orrery-pre-update-${from}-${stamp(this.#o.now())}`;
    this.hold(`${name}.zip`);
    try {
      await this.#make(name);
    } catch (err) {
      this.release(`${name}.zip`);
      throw new Error(`${name}.zip: ${(err as Error).message}`);
    }
    await this.refresh();
    return `${name}.zip`;
  }

  /** Keeps the newest 20 named saves and 3 world files, and every current or held one. */
  async prune(): Promise<void> {
    let saves: Save[];
    try {
      saves = (await this.list()).saves;
    } catch (err) {
      return console.error(`[saves] can't prune: ${(err as Error).message}`);
    }
    const doomed = [...past(saves, 'named', KEEP_NAMED), ...past(saves, 'world', KEEP_WORLD)].filter((s) => !s.current && !this.#held.has(s.name));
    if (doomed.length === 0) return;
    await this.#within(async (base) => {
      for (const s of doomed) {
        try {
          await unlink(`${base}/${s.name}`);
          console.log(`[saves] pruned ${printable(s.name)}`);
        } catch (err) {
          console.error(`[saves] can't prune ${printable(s.name)}: ${printable((err as Error).message)}`);
        }
      }
    }).catch((err: Error) => console.error(`[saves] can't prune: ${err.message}`));
  }

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
  async restore(name: string): Promise<void> {
    const unit = await this.#o.unit();
    if (!isStopped(unit)) throw new Error(`the server is ${unit.active || 'in an unknown state'}: stop it first`);
    if (!(await this.list()).saves.some((s) => s.name === name)) throw new Error(`${name} is not a listed save`);
    const copy = `restored-${stamp(this.#o.now())}-${name.replace(RESTORED, '')}`;
    await this.#within(async (base) => {
      const newest = async () => {
        let newest = 0;
        for (const other of await readdir(base)) {
          if (other === `.${copy}.partial`) continue;
          const st = await lstat(`${base}/${other}`).catch(() => null);
          if (st) newest = Math.max(newest, st.mtimeMs);
        }
        return new Date(Math.max(this.#o.now(), newest + NEWER_MS));
      };
      await this.#copy(base, name, copy, newest, async () => {
        const now = await this.#o.unit();
        if (!isStopped(now)) throw new Error(`the server started during the restore (it is ${now.active || 'in an unknown state'}): nothing was restored`);
      });
    });
    console.log(`[saves] restored ${printable(name)} as ${printable(copy)}: the next start loads it`);
    await this.prune();
    await this.refresh();
  }

  /**
   * A game update's copy of the listed save `name` (the newest, as the stop left it) for its rollback:
   * `orrery-pre-update-<from>-<time>.zip` (a later second if that name is taken), held from pruning until `release`,
   * byte for byte, its time 2 s before `name`'s. So `--start-server-load-latest` loads `name` itself, which the new
   * release may write as it stops, and never the copy: a rollback restores what the old release saved. Written as
   * `.<copy>.partial` and linked to its name like a restore's copy (never over a file); resolves with its name.
   */
  async keep(name: string, from: string): Promise<string> {
    if (!/^\d+\.\d+\.\d+$/.test(from)) throw new Error(`${JSON.stringify(from)} is not a version`);
    if (!(await this.list()).saves.some((s) => s.name === name)) throw new Error(`${name} is not a listed save`);
    const copy = await this.#within(async (base) => {
      const taken = new Set(await readdir(base));
      let at = this.#o.now();
      let copy = `orrery-pre-update-${from}-${stamp(at)}.zip`;
      while (taken.has(copy) || taken.has(`.${copy}.partial`) || this.#held.has(copy)) copy = `orrery-pre-update-${from}-${stamp((at += 1000))}.zip`;
      this.hold(copy);
      try {
        await this.#copy(base, name, copy, (src) => new Date(src.mtimeMs - NEWER_MS));
      } catch (err) {
        this.release(copy);
        throw err;
      }
      return copy;
    });
    console.log(`[saves] kept ${printable(name)} as ${copy} for a rollback`);
    await this.refresh();
    return copy;
  }

  /**
   * Copies `name` in the folder `base` to `copy` through `.<copy>.partial` (created `O_EXCL`, synced, its time
   * `mtime`, then `ready` checked and linked to `copy`, which fails if that exists); the partial file is always removed.
   */
  async #copy(base: string, name: string, copy: string, mtime: (src: Stats) => Date | Promise<Date>, ready?: () => Promise<void>): Promise<void> {
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

  /**
   * Removes every partial copy a restore (or a `keep`) left when the agent exited during it (a restart or a crash: `process.exit`
   * skips its `finally`). No restore of this agent runs yet, and one started later takes a new name. Such a file is
   * no save, so neither the list nor pruning would ever see it.
   */
  async #sweep(): Promise<void> {
    await this.#within(async (base, dev) => {
      for (const name of await readdir(base)) {
        if (!PARTIAL.test(name) || printable(name) !== name) continue;
        const st = await lstat(`${base}/${name}`).catch(() => null);
        if (!st?.isFile() || st.dev !== dev) continue;
        try {
          await unlink(`${base}/${name}`);
          console.log(`[saves] removed ${name}, left by a copy the agent's exit cut short`);
        } catch (err) {
          console.error(`[saves] can't remove ${name}: ${printable((err as Error).message)}`);
        }
      }
    }).catch((err: Error) => console.error(`[saves] can't look for partial restores: ${printable(err.message)}`));
  }

  async #loop(): Promise<void> {
    await this.refresh();
    if (!this.#stopped) this.#timer = setTimeout(() => void this.#loop(), this.#o.intervalMs);
  }

  /** `fn` on the saves folder opened once: `base` names it whatever its path points at later, `dev` is its filesystem. */
  async #within<T>(fn: (base: string, dev: number) => Promise<T>): Promise<T> {
    const dir = await open(this.#o.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      return await fn(`/proc/self/fd/${dir.fd}`, (await dir.stat()).dev);
    } finally {
      await dir.close();
    }
  }

  /**
   * `/orrery-save <name>.zip`, then the wait for its file; resolves with the file's size. The `.zip` goes in the
   * command: Factorio makes whatever follows a name's last `.` its extension (`game.server_save`, seen on 2.1.24), so
   * `orrery-pre-update-2.1.24-<time>` alone would be written as `orrery-pre-update-2.1.zip`.
   */
  async #make(name: string): Promise<number> {
    const file = `${name}.zip`;
    try {
      const reply = await this.#o.run(`/orrery-save ${file}`);
      if (!saved(reply, file)) throw new Error(`/orrery-save answered ${printable(JSON.stringify(reply.slice(0, 200)))}`);
    } catch (err) {
      // The save runs within the command's tick, so on a big map RCON's answer can come after its timeout: the command
      // was sent, so the file tells. One never sent (RCON not reached, or no auth answer) did not run: it fails now.
      if (!(err instanceof RconNoAnswer)) throw err;
    }
    return this.#written(file);
  }

  /** Waits until `file` is a regular file whose size and time held for `stableMs`, for `waitMs` at most. */
  async #written(file: string): Promise<number> {
    const { pollMs, stableMs, waitMs } = this.#o;
    const until = performance.now() + waitMs;
    let seen: { size: number; mtime: number; at: number } | null = null;
    for (;;) {
      const st = await this.#within((base, dev) => lstat(`${base}/${file}`).then((s) => (s.isFile() && s.dev === dev ? s : null), () => null));
      const t = performance.now();
      if (!st) seen = null;
      else if (!seen || st.size !== seen.size || st.mtimeMs !== seen.mtime) seen = { size: st.size, mtime: st.mtimeMs, at: t };
      else if (t - seen.at >= stableMs) return st.size;
      if (t >= until) throw new Error(seen ? `still being written after ${span(waitMs)}` : `did not appear within ${span(waitMs)}`);
      await sleep(pollMs);
    }
  }
}

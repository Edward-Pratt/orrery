// The server's saves as Backups (Factorio's `saves/` folder): listed with their kind and the current world, a named
// save on the hub's request and every 6 h after play, pruning, and a restore by copy.
//
// `Saves`, Factorio's `saves/` as Backups: the state and the order of its flows. The folder (`within`, the listing,
// pruning, the sweep at `start`, a save made and waited for) is `saves-folder.ts`'s, a restore and `keep`
// `saves-copy.ts`'s (through `CopyCtx`), an upload `saves-upload.ts`'s (through `UploadCtx`), the names, kinds, times
// and constants `saves-rules.ts`'s; every name this file exported before is re-exported here. `refresh` (every 10 s,
// and after its own changes) emits `saves` when the list changed. `save`: `/orrery-save orrery-<UTC time>.zip`
// (`stamp`, `20261031T120000Z`), then waits until the file is written (`makeSave`), and emits `backup { ok, detail }`;
// one at a time (a second does nothing). `played` (each RCON answer) makes one 6 h after the last named save (the
// newest there, or the agent's start) once anyone played since. `preUpdate(from)`: a game update's
// `orrery-pre-update-<from>-<time>`, made and waited for like `save`'s but with no `backup` (the update's steps report
// it), held until `release`. `prune` after each save and restore; `hold` keeps a name from it for a running update
// until `release`. `start` first removes every partial file an exit left (`sweepPartials`), then lists. The constants
// (6 h, 20, 3, 5 s, 5 minutes) are not settings.
import { EventEmitter } from 'node:events';
import { keepSave, restoreSave, type CopyCtx } from './saves-copy.ts';
import { listSaves, makeSave, pruneSaves, sweepPartials } from './saves-folder.ts';
import { SAVE_EVERY_MS, SAVE_WAIT_MS, STABLE_MS, mb, stamp, type BackupResult, type SavesMsg, type SavesOptions } from './saves-rules.ts';
import { uploadCancel, uploadChunk, uploadEnd, uploadStart, type Upload, type UploadCtx } from './saves-upload.ts';

export {
  KEEP_NAMED,
  KEEP_WORLD,
  SAVE_EVERY_MS,
  SAVE_WAIT_MS,
  STABLE_MS,
  UPLOAD_SPARE,
  kindOf,
  loadedMap,
  stamp,
  uploadedName,
  type BackupResult,
  type SavesMsg,
  type SavesOptions,
} from './saves-rules.ts';

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
  #uploads = new Map<string, Upload>();
  /** What the copy and upload flows read of this, live. */
  #ctx: CopyCtx & UploadCtx;

  constructor(options: SavesOptions) {
    super();
    this.#o = { intervalMs: 10_000, pollMs: 1000, stableMs: STABLE_MS, waitMs: SAVE_WAIT_MS, now: Date.now, ...options };
    this.#startedAt = this.#o.now();
    this.#ctx = {
      o: this.#o,
      held: this.#held,
      uploads: this.#uploads,
      list: () => this.list(),
      prune: () => this.prune(),
      refresh: () => this.refresh(),
      hold: (name) => this.hold(name),
      release: (name) => this.release(name),
    };
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void sweepPartials(this.#o.dir).then(() => {
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

  /** The folder now: every `*.zip` that is a regular file, newest first, and the bytes free there (`listSaves`). */
  list(): Promise<SavesMsg> {
    return listSaves(this.#o.dir, this.#o.log);
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
      result = { ok: true, detail: `Saved ${name}.zip (${mb(await makeSave(this.#o, name))})` };
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
      await makeSave(this.#o, name);
    } catch (err) {
      this.release(`${name}.zip`);
      throw new Error(`${name}.zip: ${(err as Error).message}`);
    }
    await this.refresh();
    return `${name}.zip`;
  }

  /** Keeps the newest 20 named saves and 3 world files, and every current or held one (`pruneSaves`). */
  prune(): Promise<void> {
    return pruneSaves(this.#o.dir, () => this.list(), this.#held);
  }

  /** Copies the listed save `name` to `restored-<time>-<name>`, which the next start loads (`restoreSave`). */
  restore(name: string): Promise<void> {
    return restoreSave(this.#ctx, name);
  }

  /** A game update's held copy of the listed save `name` for its rollback; resolves with its name (`keepSave`). */
  keep(name: string, from: string): Promise<string> {
    return keepSave(this.#ctx, name, from);
  }

  /** Starts receiving an uploaded save (`saveUploadStart`, `saves-upload.ts`). */
  uploadStart(id: string, name: string, size: number, sha256: string): Promise<void> {
    return uploadStart(this.#ctx, id, name, size, sha256);
  }

  /** The next piece of an upload (`saveChunk`). */
  uploadChunk(id: string, offset: number, data: Buffer): Promise<void> {
    return uploadChunk(this.#ctx, id, offset, data);
  }

  /** Ends an upload (`saveUploadEnd`): checked, then stored as `uploadedName`; resolves with that name. */
  uploadEnd(id: string, installed: string | undefined): Promise<string> {
    return uploadEnd(this.#ctx, id, installed);
  }

  /** Drops an upload (`saveUploadCancel`, or the hub giving up). Nothing to drop is fine. */
  uploadCancel(id: string): Promise<void> {
    return uploadCancel(this.#ctx, id);
  }

  async #loop(): Promise<void> {
    await this.refresh();
    if (!this.#stopped) this.#timer = setTimeout(() => void this.#loop(), this.#o.intervalMs);
  }
}

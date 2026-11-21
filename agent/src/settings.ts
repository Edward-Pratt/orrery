// A factorio server's game settings (docs/notes/factorio-world-settings.md, stage A; docs/protocol.md "Game
// settings"): server-settings.json and server-adminlist.json in the server's config folder, read as untrusted (the
// container writes them), written only from checked fields, applied live where Factorio has a `/config set` option,
// and put back as they were at the last good start when the next start fails.
//
// `GameSettings`, a factorio server's game settings, the state and the order of its flows; the rules are
// `settings-rules.ts`'s, the files (and `<state>/settings.json`) `settings-files.ts`'s, the live commands
// `settings-live.ts`'s, each re-exported here. `autoPause` and `verification`: `auto_pause` and
// `require_user_verification` as the running server started with them (null when unknown). `report` (the `settings`
// push, `game_password_set` only, never the password) on `start`, `refresh` (each welcome), after its own writes and
// when a start's file was read; pushes go out in order. `set` (`settingsSet`), one at a time (`busy` while one runs or
// waits: a game update, a restore and a deploy are refused meanwhile): `ready` (no game update, no deploy), then a
// fresh `systemctl show`, refused while activating, deactivating or reloading; the password and the rules across
// fields (`keptPassword`, `checkSet`). Then `renderSettings` written through the folder handle (`writeIn`); the start
// gate armed and `rolledBack` cleared. With the unit active: `applyLive`. With it stopped: no RCON; the adminlist
// written the same way, lowercased, when it differs. The reply is `{ applied, pending }`, then the push.
// `StartGate`'s `start` reads the file as `startedWith` (kept with the run's change time, so an agent restarted during
// a run keeps it), emptying the failed ones; its `good` makes that `lastGood` when fully readable (a password the rule
// lets through), and so does its `late` while there is no `lastGood` yet (an agent deployed onto a server that has run
// past 300 s: its `startedWith` is the file as read at the agent's start); its `failed` writes `lastGood` back as a
// write does (none: nothing written) and sets `rolledBack` to the time and Factorio's last `Error` line from
// `factorio-current.log` (`printable`, 2 KiB). `<state>/settings.json` is written whole after each change, one write
// after another. `start` removes partial files an exit left in the config folder. Never logs a value: key names only.
import { join } from 'node:path';
import type { GameSettingsReport } from '../../hub/src/types.ts';
import { StartGate } from './gate.ts';
import type { UnitState } from './service.ts';
import { STATE_FILE, lastError, readAdminsFile, readSettingsFile, readState, removePartials, saveState, writeIn, type State } from './settings-files.ts';
import { applyLive, diffAdmins, type SettingsAnswer } from './settings-live.ts';
import { ADMINS_FILE, SETTINGS_FILE, changedKeys, checkSet, copyModel, keptPassword, ordered, passwordOk, renderSettings, restartPending, type Key, type Model } from './settings-rules.ts';
import { LIMITS, cut, printable, type Request } from './wire.ts';

export { ADMINS_FILE, KEYS, NAME_BYTES, RESTART_ONLY, SETTINGS_FILE, parseAdmins, parseSettings, renderSettings, type FileRead, type Model } from './settings-rules.ts';
export { LIVE, type SettingsAnswer } from './settings-live.ts';

export type GameSettingsOptions = {
  /** The server's config folder (`<data>/config`), which the container writes. */
  config: string;
  /** The agent's state folder, for `settings.json`. */
  state: string;
  /** `factorio-current.log`, for a failed start's last error line. */
  log: string;
  /** The unit's state now (`ServiceWatch.read`): a write is refused while it starts or stops. */
  unit: { read(): Promise<UnitState> };
  /** Runs one RCON command (the agent's `RconSession`). */
  run: (command: string) => Promise<string>;
  /** Rejects with why a write can't run now (a game update, a deploy). */
  ready: () => Promise<void>;
  /** The `settings` push, at connect (`refresh`), after each of its own writes and when the unit becomes active. */
  push: (report: GameSettingsReport) => void;
  now?: () => number;
  goodWithinMs?: number;
  /** How long a write may spend on live commands (the hub waits 60 s for the reply: `SETTINGS_SET_MS`). */
  liveMs?: number;
  /** How long a `/promote` or `/demote` has to show in the adminlist, polled every `pollMs`. */
  adminWaitMs?: number;
  pollMs?: number;
};

/**
 * The game settings (`settingsSet`, and the `settings` push). Reads `server-settings.json` and the adminlist through
 * the config folder opened once, as untrusted files that drive display only. `set`: one at a time; refused while a
 * game update or a deploy runs (`ready`) and while the unit starts or stops (a fresh `systemctl show`); then the file
 * written from the checked fields alone and the start gate armed; then, with the unit active, each changed key with a
 * live option (and each one a write before couldn't apply) as `/config set`, counted applied only on Factorio's own
 * reply for it, and the admins as `/promote` and `/demote`, counted applied once the adminlist shows them; a failure,
 * or 20 s spent, leaves the rest pending. With the unit stopped the adminlist is written instead. At each start
 * (`StartGate`'s `start`) the file read then is `startedWith`; a good start makes it `lastGood` when fully readable
 * (a late one too, while there is none);
 * a failed start the gate watched puts `lastGood` back and reports `rolledBack`, until the next write.
 */
export class GameSettings {
  #o: Required<Omit<GameSettingsOptions, 'goodWithinMs'>>;
  #gate: StartGate;
  #state: State;
  #file: string;
  #queue: Promise<unknown> = Promise.resolve();
  #saving: Promise<void> = Promise.resolve();
  /** Pushes, one after another, so they go out in the order of the changes. */
  #pushing: Promise<void> = Promise.resolve();
  /** The read of the file a start began with: a good start waits for it. */
  #starting: Promise<void> = Promise.resolve();
  #stopped = false;
  /** `settingsSet`s running or queued. */
  #sets = 0;

  constructor(o: GameSettingsOptions) {
    this.#o = { now: Date.now, liveMs: 20_000, adminWaitMs: 2000, pollMs: 100, ...o };
    this.#file = join(o.state, STATE_FILE);
    this.#state = readState(this.#file);
    this.#gate = new StartGate({ armedAt: this.#state.armedAt, goodWithinMs: o.goodWithinMs, now: this.#o.now });
    this.#gate.on('start', (since) => void (this.#starting = this.#started(since)));
    this.#gate.on('good', (since, gated) => void this.#starting.then(() => this.#good(since, gated)));
    this.#gate.on('late', (since, gated) => void this.#starting.then(() => this.#late(since, gated)));
    this.#gate.on('failed', (s) => void this.#failed(s));
  }

  /** Removes partial files a write left when the agent exited during it, then pushes the first report. */
  async start(): Promise<void> {
    await removePartials(this.#o.config);
    await this.refresh();
  }

  stop(): void {
    this.#stopped = true;
  }

  /** Each unit state in turn (the start gate's). */
  service(s: UnitState): void {
    this.#gate.service(s);
  }

  /** RCON answered (the start gate's evidence of a good start). */
  rconUp(): void {
    this.#gate.rconUp();
  }

  /** `auto_pause` as the running server started with it; null when that isn't known (the file decides then). */
  get autoPause(): boolean | null {
    return this.#state.startedWith?.model?.fields.auto_pause ?? null;
  }

  /** `require_user_verification` as the running server started with it; null when that isn't known. */
  get verification(): boolean | null {
    return this.#state.startedWith?.model?.fields.require_user_verification ?? null;
  }

  /** The files read now, as the `settings` push. */
  async report(): Promise<GameSettingsReport> {
    const rolledBack = this.#state.rolledBack; // as it was before the files were read: never newer than they are
    const [file, admins] = await Promise.all([readSettingsFile(this.#o.config), readAdminsFile(this.#o.config)]);
    const m = file.model;
    return {
      settings: m ? { ...m.fields, game_password_set: m.password !== '' } : null,
      admins: admins ?? [],
      problem: file.problem === null ? null : cut(printable(file.problem), LIMITS.detail),
      pending: this.#pending(m),
      extra: file.extra,
      rolledBack,
    };
  }

  /** Reads the files and pushes them (on each connect, and after the Agent's own changes). */
  refresh(): Promise<void> {
    const run = this.#pushing.then(async () => {
      if (this.#stopped) return;
      try {
        this.#o.push(await this.report());
      } catch (err) {
        console.error(`[settings] can't read the game settings: ${printable((err as Error).message)}`);
      }
    });
    this.#pushing = run;
    return run;
  }

  /** A `settingsSet`, after any running one. */
  set(req: Request<'settingsSet'>): Promise<SettingsAnswer> {
    this.#sets++;
    const run = this.#queue.then(() => this.#set(req)).finally(() => this.#sets--);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Whether a `settingsSet` runs or waits: a game update, a restore and a deploy are refused meanwhile. */
  get busy(): boolean {
    return this.#sets > 0;
  }

  async #set(req: Request<'settingsSet'>): Promise<SettingsAnswer> {
    await this.#o.ready();
    const unit = await this.#o.unit.read();
    if (unit.active === 'activating' || unit.active === 'deactivating' || unit.active === 'reloading') {
      throw new Error('The server is starting or stopping: try again in a minute.');
    }
    const before = await readSettingsFile(this.#o.config);
    const after: Model = { fields: copyModel({ fields: req.settings, password: '' }).fields, password: keptPassword(req, before) };
    checkSet(req, before, after);

    const changed = changedKeys(before.model, before.password ?? '', after);
    const adminsBefore = (await readAdminsFile(this.#o.config)) ?? [];
    await writeIn(this.#o.config, SETTINGS_FILE, renderSettings(after));
    this.#gate.arm();
    this.#state.rolledBack = null;

    let answer: SettingsAnswer;
    if (unit.active === 'active') answer = await applyLive(this.#o, this.#state, after, changed, adminsBefore, req.admins);
    else {
      const adminsChanged = diffAdmins(adminsBefore, req.admins).length > 0;
      if (adminsChanged) await writeIn(this.#o.config, ADMINS_FILE, JSON.stringify(req.admins.map((n) => n.toLowerCase())) + '\n');
      answer = { applied: [], pending: ordered([...changed, ...(adminsChanged ? ['admins'] : [])]) };
    }
    this.#persist();
    console.log(
      `[settings] wrote ${SETTINGS_FILE} with the server ${unit.active}: changed ${changed.join(', ') || 'nothing'}; applied ${answer.applied.join(', ') || 'nothing'}; pending ${answer.pending.join(', ') || 'nothing'}`,
    );
    setImmediate(() => void this.refresh()); // after the reply
    return answer;
  }

  /** The keys saved but not in the running server: restart-only ones that differ from what it started with, and failed live ones. */
  #pending(m: Model | null): string[] {
    return ordered([...(m ? this.#restartPending(m, []) : []), ...this.#state.failedLive]);
  }

  /** The restart-only keys of `m` the running server doesn't have: those that differ from what it started with, else those `changed`. */
  #restartPending(m: Model, changed: string[]): Key[] {
    return restartPending(this.#state.startedWith?.model, m, changed);
  }

  async #started(since: number): Promise<void> {
    if (this.#state.startedWith?.since === since) return; // this run's, kept across an agent restart
    const file = await readSettingsFile(this.#o.config);
    this.#state.startedWith = { since, model: file.model };
    this.#state.failedLive = [];
    this.#persist();
    await this.refresh();
  }

  #good(since: number, gated: boolean): void {
    if (this.#startedOk(since)) this.#state.lastGood = this.#state.startedWith!.model;
    if (gated) console.log('[settings] the server started with the settings written last');
    this.#persist();
  }

  /**
   * RCON first answered past `GOOD_WITHIN_MS` (a run the agent came to late, as after its own deploy onto a server that
   * has run for a while, or a slow load): never a good start, but with no `lastGood` yet the settings that run started
   * with become it, so the first write after such a deploy has something to put back. A later good start replaces it.
   */
  #late(since: number, gated: boolean): void {
    if (this.#state.lastGood === null && this.#startedOk(since)) {
      this.#state.lastGood = this.#state.startedWith!.model;
      console.log('[settings] no good start seen yet: the settings the running server started with are the last good ones');
    }
    if (gated) console.log('[settings] the server started with the settings written last, after more than 300 s');
    this.#persist();
  }

  /** Whether the run with this change time started with settings the Agent may put back: fully readable, a password by its rule. */
  #startedOk(since: number): boolean {
    const started = this.#state.startedWith;
    return started?.since === since && started.model !== null && passwordOk(started.model.password);
  }

  async #failed(s: UnitState): Promise<void> {
    const at = new Date(this.#o.now()).toISOString();
    const line = await lastError(this.#o.log);
    const good = this.#state.lastGood;
    let detail: string;
    if (!good) detail = `${at}: the start failed, and no earlier start had readable settings to put back (${line})`;
    else {
      try {
        await writeIn(this.#o.config, SETTINGS_FILE, renderSettings(good));
        detail = `${at}: ${line}`;
      } catch (err) {
        detail = `${at}: ${line}; putting the settings back failed (${(err as Error).message})`;
      }
    }
    this.#state.rolledBack = cut(printable(detail), LIMITS.detail);
    console.error(`[settings] the server didn't start (${s.active} ${s.sub}, ${s.result}) after a write: ${this.#state.rolledBack}`);
    this.#persist();
    await this.refresh();
  }

  /** `<state>/settings.json`, written whole (mode 600: it holds the last good password), one write after another. */
  #persist(): void {
    const s = this.#state;
    const content = JSON.stringify({ ...s, armedAt: this.#gate.armedAt }) + '\n';
    const file = this.#file;
    this.#saving = this.#saving
      .then(() => saveState(this.#o.state, file, content))
      .catch((err: Error) => console.error(`[settings] can't write ${file}: ${(err as NodeJS.ErrnoException).code ?? err.message}`));
  }

  /** Resolves once the state file writes queued so far are done (tests). */
  get saved(): Promise<void> {
    return this.#saving;
  }
}

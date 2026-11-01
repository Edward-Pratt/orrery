// A factorio server's game settings (docs/notes/factorio-world-settings.md, stage A; docs/protocol.md "Game
// settings"): server-settings.json and server-adminlist.json in the server's config folder, read as untrusted (the
// container writes them), written only from checked fields, applied live where Factorio has a `/config set` option,
// and put back as they were at the last good start when the next start fails.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { constants, lstat, mkdir, open, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { GameSettingsFields, GameSettingsReport } from '../../hub/src/types.ts';
import { openPlain, tail } from './files.ts';
import { StartGate } from './gate.ts';
import type { UnitState } from './service.ts';
import { GAME_SETTINGS, LIMITS, cut, printable, settingsFieldOk, type Request } from './wire.ts';

export const SETTINGS_FILE = 'server-settings.json';
export const ADMINS_FILE = 'server-adminlist.json';
/** Far over any real file of either (a few KiB); a bigger one is not read. */
const FILE_MAX = 1024 * 1024;

/** The keys the dashboard changes, in the file's order (the password and the admins aside). */
export const KEYS = [
  'name',
  'description',
  'max_players',
  'require_user_verification',
  'autosave_interval',
  'autosave_slots',
  'afk_autokick_interval',
  'auto_pause',
  'auto_pause_when_players_connect',
  'only_admins_can_pause_the_game',
  'allow_commands',
] as const satisfies readonly (keyof GameSettingsFields)[];
type Key = (typeof KEYS)[number];

/**
 * Factorio's own values for the keys a file may leave out (data/server-settings.example.json; setup's file has no
 * `max_players`, for one). `name` and `description` have none: Factorio refuses to host without them.
 */
const DEFAULTS: Partial<GameSettingsFields> = {
  max_players: 0,
  require_user_verification: true,
  autosave_interval: 10,
  autosave_slots: 5,
  afk_autokick_interval: 0,
  auto_pause: true,
  auto_pause_when_players_connect: false,
  only_admins_can_pause_the_game: true,
  allow_commands: 'admins-only',
};

/** Keys with no `/config set` option: they apply at the next start. */
export const RESTART_ONLY: readonly Key[] = ['auto_pause', 'autosave_slots'];

/** Keys the Agent writes itself; any other in the file (but a `_comment…`) is reported as `extra`, which a write drops. */
const WRITTEN = new Set<string>([...KEYS, 'game_password', 'visibility', 'non_blocking_saving']);

/** Factorio 2.1.24 keeps only the first 50 bytes (UTF-8) of a server's name, from the file and from `/config set`. */
export const NAME_BYTES = 50;

const COMMENT =
  "Written by the orrery Agent from the dashboard's Settings tab: orrery's own keys only (any other is dropped at the next save). A private server: not listed, no factorio.com username or token.";

/** The game settings with the password (`''`: none), as written to the file and kept as the last good ones. */
export type Model = { fields: GameSettingsFields; password: string };

/** server-settings.json as read: the model, or why there is none; the keys a write drops; the file's password. */
export type FileRead = {
  model: Model | null;
  problem: string | null;
  extra: string[];
  /** The file's `game_password` if it is a string (also when another key fails), `''` when left out; null otherwise. */
  password: string | null;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A password the Agent may put in the file and in a command: none, or one by the rule. */
const passwordOk = (p: string): boolean => p === '' || GAME_SETTINGS.password.test(p);

/**
 * server-settings.json's text, read as untrusted: each managed key by the hub's rule (`settingsFieldOk`), a key left
 * out as Factorio's default. One that fails makes the whole model unreadable (`problem` names the key, never a value).
 * `allow_commands` must be a string: Factorio 2.1.24 refuses a boolean there (`Value must be a string`).
 */
export function parseSettings(text: string): FileRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { model: null, problem: `${SETTINGS_FILE} is not valid JSON`, extra: [], password: null };
  }
  if (!isObject(raw)) return { model: null, problem: `${SETTINGS_FILE} is not a JSON object`, extra: [], password: null };
  const extra = Object.keys(raw)
    .filter((k) => !WRITTEN.has(k) && !k.startsWith('_comment') && GAME_SETTINGS.key.test(k))
    .slice(0, LIMITS.extra);
  const pw = Object.hasOwn(raw, 'game_password') ? raw.game_password : '';
  const password = typeof pw === 'string' ? pw : null;
  const fail = (problem: string): FileRead => ({ model: null, problem, extra, password });
  const fields: Record<string, unknown> = {};
  for (const key of KEYS) {
    const has = Object.hasOwn(raw, key);
    if (!has && DEFAULTS[key] === undefined) return fail(`${key} is missing (Factorio needs it)`);
    const v = has ? raw[key] : DEFAULTS[key];
    if (key === 'allow_commands' && typeof v === 'boolean') return fail('allow_commands is a boolean: Factorio needs the string "true", "false" or "admins-only"');
    if (!settingsFieldOk(key, v)) return fail(`${key} is not valid`);
    fields[key] = v;
  }
  if (password === null) return fail('game_password is not a string');
  if (!isObject(raw.visibility)) return fail('visibility is missing (Factorio needs it)');
  return { model: { fields: fields as GameSettingsFields, password }, problem: null, extra, password };
}

/** server-adminlist.json's text: the names that pass the rule, each once whatever its case, 100 at most; null if not a list. */
export function parseAdmins(text: string): string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const n of raw) {
    if (typeof n !== 'string' || !GAME_SETTINGS.admin.test(n) || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    names.push(n);
    if (names.length === LIMITS.admins) break;
  }
  return names;
}

/** The file the Agent writes: the checked fields alone, never public nor on the LAN, no factorio.com credentials. */
export function renderSettings(m: Model): string {
  const f = m.fields;
  const file = {
    _comment: COMMENT,
    name: f.name,
    description: f.description,
    max_players: f.max_players,
    visibility: { public: false, lan: false },
    game_password: m.password,
    require_user_verification: f.require_user_verification,
    autosave_interval: f.autosave_interval,
    autosave_slots: f.autosave_slots,
    afk_autokick_interval: f.afk_autokick_interval,
    auto_pause: f.auto_pause,
    auto_pause_when_players_connect: f.auto_pause_when_players_connect,
    only_admins_can_pause_the_game: f.only_admins_can_pause_the_game,
    allow_commands: f.allow_commands,
    non_blocking_saving: false,
  };
  return JSON.stringify(file, null, 2) + '\n';
}

const minutes = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;
const ALLOW_WORDS = { true: 'Yes', false: 'No', 'admins-only': 'Admins only' } as const;

/** A key Factorio changes live, the command for its new value and the reply that says it changed (seen on 2.1.24). */
type Live = { key: Exclude<Key, 'auto_pause' | 'autosave_slots'> | 'game_password'; command: (m: Model) => [command: string, reply: string] };

/**
 * The live options, in the order they are sent: the password before verification, so turning the account check off
 * with a new password never leaves a moment with neither. Each value is one the rules let through: one line, no
 * control character, within its limit. Only these built-in commands are built (agent/CLAUDE.md, "Trust boundaries").
 */
export const LIVE: readonly Live[] = [
  {
    key: 'game_password',
    command: (m) => (m.password === '' ? ['/config set password', 'Server password removed.'] : [`/config set password ${m.password}`, 'Server password changed.']),
  },
  {
    key: 'require_user_verification',
    command: (m) => [`/config set require-user-verification ${m.fields.require_user_verification}`, `User verification has been ${m.fields.require_user_verification ? 'enabled' : 'disabled'}.`],
  },
  { key: 'name', command: (m) => [`/config set name ${m.fields.name}`, `Server name changed to: ${m.fields.name}`] },
  {
    key: 'description',
    command: (m) =>
      m.fields.description === ''
        ? ['/config set description', 'Server description cleared.']
        : [`/config set description ${m.fields.description}`, `Server description set to: ${m.fields.description}`],
  },
  {
    key: 'max_players',
    command: (m) => [`/config set max-players ${m.fields.max_players}`, m.fields.max_players === 0 ? 'Player limit removed.' : `Maximum number of players changed to ${m.fields.max_players}.`],
  },
  {
    key: 'autosave_interval',
    command: (m) => [
      `/config set autosave-interval ${m.fields.autosave_interval}`,
      m.fields.autosave_interval === 0 ? 'Autosave is now disabled.' : `Autosave interval changed to ${minutes(m.fields.autosave_interval)}.`,
    ],
  },
  {
    key: 'afk_autokick_interval',
    command: (m) => [
      `/config set afk-auto-kick ${m.fields.afk_autokick_interval}`,
      m.fields.afk_autokick_interval === 0 ? 'AFK auto kick is now disabled.' : `AFK auto-kick changed to ${minutes(m.fields.afk_autokick_interval)}.`,
    ],
  },
  {
    key: 'auto_pause_when_players_connect',
    command: (m) => [`/config set auto-pause-when-players-connect ${m.fields.auto_pause_when_players_connect}`, `Auto pause when players connect set to: ${m.fields.auto_pause_when_players_connect}.`],
  },
  {
    key: 'only_admins_can_pause_the_game',
    command: (m) => [`/config set only-admins-can-pause ${m.fields.only_admins_can_pause_the_game}`, `Only admins can pause set to: ${m.fields.only_admins_can_pause_the_game}.`],
  },
  {
    key: 'allow_commands',
    command: (m) => [`/config set allow-commands ${m.fields.allow_commands}`, `Allow Lua commands set to ${ALLOW_WORDS[m.fields.allow_commands]}.`],
  },
];

/** Every key a reply or a report may name, in one order. */
const ORDER: readonly string[] = [...KEYS, 'game_password', 'admins'];
const ordered = (keys: Iterable<string>): string[] => [...new Set(keys)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).slice(0, LIMITS.pending);

/** The keys whose value differs between `before` (null: unreadable, so all of them) and `after`. */
function changedKeys(before: Model | null, beforePassword: string, after: Model): string[] {
  const keys: string[] = KEYS.filter((k) => !before || before.fields[k] !== after.fields[k]);
  if (beforePassword !== after.password) keys.push('game_password');
  return keys;
}

/** Whether `m` is a model the Agent may write back as is: every field by its rule, and a password by its own. */
function modelOk(m: unknown): m is Model {
  if (!isObject(m) || !isObject(m.fields) || typeof m.password !== 'string' || !passwordOk(m.password)) return false;
  const fields = m.fields;
  return KEYS.every((k) => Object.hasOwn(fields, k) && settingsFieldOk(k, fields[k]));
}
const copyModel = (m: Model): Model => ({ fields: Object.fromEntries(KEYS.map((k) => [k, m.fields[k]])) as GameSettingsFields, password: m.password });

/** `<state>/settings.json`: the Agent's own bookkeeping, holding a password (mode 600, in the folder the container never mounts). */
type State = {
  /** The settings of the last good start that were fully readable. */
  lastGood: Model | null;
  /** What the run with this change time started with, as read when the unit became active (or when the agent came to it). */
  startedWith: { since: number; model: Model | null } | null;
  /** The start gate's arming time, or null. */
  armedAt: number | null;
  /** Live keys (and `admins`) a write couldn't apply to the running server: pending until the next start. */
  failedLive: string[];
  rolledBack: string | null;
};

const STATE_FILE = 'settings.json';
const safeInt = (v: unknown): v is number => Number.isSafeInteger(v);

/** The state file read back, each part shape-checked; what fails is left out. */
function readState(file: string): State {
  const state: State = { lastGood: null, startedWith: null, armedAt: null, failedLive: [], rolledBack: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return state;
  }
  if (!isObject(raw)) return state;
  if (modelOk(raw.lastGood)) state.lastGood = copyModel(raw.lastGood);
  const s = raw.startedWith;
  if (isObject(s) && safeInt(s.since)) state.startedWith = { since: s.since, model: modelOk(s.model) ? copyModel(s.model) : null };
  if (safeInt(raw.armedAt)) state.armedAt = raw.armedAt;
  if (Array.isArray(raw.failedLive)) state.failedLive = raw.failedLive.filter((k): k is string => typeof k === 'string' && ORDER.includes(k));
  if (typeof raw.rolledBack === 'string') state.rolledBack = cut(printable(raw.rolledBack), LIMITS.detail);
  return state;
}

/** `fn` on `dir` opened once (`O_DIRECTORY`, `O_NOFOLLOW`): a folder the container swapped for a link is refused. */
async function within<T>(dir: string, fn: (base: string) => Promise<T>): Promise<T> {
  const fh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return await fn(`/proc/self/fd/${fh.fd}`);
  } finally {
    await fh.close();
  }
}

/** A plain file's text in an opened folder (`files.ts`'s `openPlain`): null when missing or not a regular file; throws over 1 MiB. */
async function readIn(base: string, name: string): Promise<string | null> {
  const file = await openPlain(`${base}/${name}`);
  if (!file) return null;
  try {
    if (file.st.size > FILE_MAX) throw new Error(`${name} is over 1 MiB`);
    const buf = Buffer.alloc(file.st.size);
    const { bytesRead } = await file.fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.fh.close();
  }
}

const PARTIAL = /^\.server-(settings|adminlist)\.json\.[0-9a-f]{12}\.partial$/;

/**
 * Writes `name` in `dir` whole or not at all, through the folder opened once: `.<name>.<random>.partial` created
 * there (`O_CREAT`, `O_EXCL`, `O_NOFOLLOW`, mode 600; never in /tmp, whose SELinux label the container can't read),
 * synced, then renamed over `name` (a link there is replaced, never followed).
 */
async function writeIn(dir: string, name: string, content: string): Promise<void> {
  await within(dir, async (base) => {
    const partial = `.${name}.${randomBytes(6).toString('hex')}.partial`;
    const out = await open(`${base}/${partial}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        await out.writeFile(content);
        await out.sync();
      } finally {
        await out.close();
      }
      await rename(`${base}/${partial}`, `${base}/${name}`);
    } catch (err) {
      await unlink(`${base}/${partial}`).catch(() => {});
      throw new Error(`can't write ${name}: ${(err as NodeJS.ErrnoException).code ?? 'failed'}`);
    }
  });
}

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
  /** How long a write may spend on live commands (the hub waits 30 s for the reply). */
  liveMs?: number;
  /** How long a `/promote` or `/demote` has to show in the adminlist, polled every `pollMs`. */
  adminWaitMs?: number;
  pollMs?: number;
};

export type SettingsAnswer = { applied: string[]; pending: string[] };

/**
 * The game settings (`settingsSet`, and the `settings` push). Reads `server-settings.json` and the adminlist through
 * the config folder opened once, as untrusted files that drive display only. `set`: one at a time; refused while a
 * game update or a deploy runs (`ready`) and while the unit starts or stops (a fresh `systemctl show`); then the file
 * written from the checked fields alone and the start gate armed; then, with the unit active, each changed key with a
 * live option (and each one a write before couldn't apply) as `/config set`, counted applied only on Factorio's own
 * reply for it, and the admins as `/promote` and `/demote`, counted applied once the adminlist shows them; a failure,
 * or 20 s spent, leaves the rest pending. With the unit stopped the adminlist is written instead. At each start
 * (`StartGate`'s `start`) the file read then is `startedWith`; a good start makes it `lastGood` when fully readable;
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

  constructor(o: GameSettingsOptions) {
    this.#o = { now: Date.now, liveMs: 20_000, adminWaitMs: 2000, pollMs: 100, ...o };
    this.#file = join(o.state, STATE_FILE);
    this.#state = readState(this.#file);
    this.#gate = new StartGate({ armedAt: this.#state.armedAt, goodWithinMs: o.goodWithinMs, now: this.#o.now });
    this.#gate.on('start', (since) => (this.#starting = this.#started(since)));
    this.#gate.on('good', (since, gated) => void this.#starting.then(() => this.#good(since, gated)));
    this.#gate.on('failed', (s) => void this.#failed(s));
  }

  /** Removes partial files a write left when the agent exited during it, then pushes the first report. */
  async start(): Promise<void> {
    await within(this.#o.config, async (base) => {
      for (const name of await readdir(base)) {
        if (!PARTIAL.test(name)) continue;
        const st = await lstat(`${base}/${name}`).catch(() => null);
        if (st?.isFile()) await unlink(`${base}/${name}`).catch(() => {});
      }
    }).catch((err: Error) => console.error(`[settings] can't look for partial files: ${printable(err.message)}`));
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

  /** The files read now, as the `settings` push. */
  async report(): Promise<GameSettingsReport> {
    const rolledBack = this.#state.rolledBack; // as it was before the files were read: never newer than they are
    const [file, admins] = await Promise.all([this.#readSettings(), this.#readAdmins()]);
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
    const run = this.#queue.then(() => this.#set(req));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #set(req: Request<'settingsSet'>): Promise<SettingsAnswer> {
    await this.#o.ready();
    const unit = await this.#o.unit.read();
    if (unit.active === 'activating' || unit.active === 'deactivating' || unit.active === 'reloading') {
      throw new Error('The server is starting or stopping: try again in a minute.');
    }
    const before = await this.#readSettings();
    const after: Model = { fields: copyModel({ fields: req.settings, password: '' }).fields, password: this.#password(req, before) };
    const f = after.fields;
    if (!f.require_user_verification && after.password === '') throw new Error('Without the account check a game password is needed.');
    if (!f.name.isWellFormed() || !f.description.isWellFormed()) throw new Error('The name or the description has a broken character.');
    if (f.name !== before.model?.fields.name && Buffer.byteLength(f.name) > NAME_BYTES) {
      throw new Error(`Factorio keeps only the first ${NAME_BYTES} bytes of a server's name: use a shorter one.`);
    }
    const lower = req.admins.map((n) => n.toLowerCase());
    const twice = req.admins.find((_, i) => lower.indexOf(lower[i]!) !== i);
    if (twice !== undefined) throw new Error(`admins: ${twice} is listed twice.`);

    const changed = changedKeys(before.model, before.password ?? '', after);
    const adminsBefore = (await this.#readAdmins()) ?? [];
    await writeIn(this.#o.config, SETTINGS_FILE, renderSettings(after));
    this.#gate.arm();
    this.#state.rolledBack = null;

    let answer: SettingsAnswer;
    if (unit.active === 'active') answer = await this.#applyLive(after, changed, adminsBefore, req.admins);
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

  /** The password to write: the request's (null: none), else the file's, which must be one the rule lets through. */
  #password(req: Request<'settingsSet'>, before: FileRead): string {
    if (req.game_password !== undefined) return req.game_password ?? '';
    const kept = before.password ?? '';
    if (!passwordOk(kept)) throw new Error("The file's game password can't be kept: set a new one.");
    return kept;
  }

  /** The live part of a write to a running server: commands one at a time, the first failure leaving the rest pending. */
  async #applyLive(after: Model, changed: string[], adminsBefore: string[], admins: string[]): Promise<SettingsAnswer> {
    const want = new Set([...changed, ...this.#state.failedLive]);
    const applied: string[] = [];
    const failed: string[] = [];
    const deadline = performance.now() + this.#o.liveMs;
    let answering = true;
    for (const live of LIVE) {
      if (!want.has(live.key)) continue;
      if (answering && performance.now() < deadline) {
        const [command, reply] = live.command(after);
        try {
          if ((await this.#o.run(command)) === reply) {
            applied.push(live.key);
            continue;
          }
        } catch {
          answering = false; // RCON is gone or slow: the rest waits for the restart
        }
      }
      failed.push(live.key);
    }
    const diff = diffAdmins(adminsBefore, admins);
    if (diff.length > 0) {
      let sent = answering && performance.now() < deadline;
      for (const [verb, name] of diff) {
        if (!sent) break;
        sent = await this.#o.run(`/${verb} ${name}`).then(
          () => true,
          () => false,
        );
      }
      if (sent && (await this.#adminsShow(admins))) applied.push('admins');
      else failed.push('admins');
    }
    this.#state.failedLive = failed;
    return { applied: ordered(applied), pending: ordered([...failed, ...this.#restartPending(after, changed)]) };
  }

  /** Whether the adminlist, read again until `adminWaitMs`, holds exactly `admins` (ignoring case): Factorio rewrites it at once. */
  async #adminsShow(admins: string[]): Promise<boolean> {
    const until = performance.now() + this.#o.adminWaitMs;
    for (;;) {
      if (diffAdmins((await this.#readAdmins()) ?? [], admins).length === 0) return true;
      if (performance.now() >= until) return false;
      await sleep(this.#o.pollMs);
    }
  }

  /** The keys saved but not in the running server: restart-only ones that differ from what it started with, and failed live ones. */
  #pending(m: Model | null): string[] {
    return ordered([...(m ? this.#restartPending(m, []) : []), ...this.#state.failedLive]);
  }

  /** The restart-only keys of `m` the running server doesn't have: those that differ from what it started with, else those `changed`. */
  #restartPending(m: Model, changed: string[]): Key[] {
    const started = this.#state.startedWith?.model;
    return RESTART_ONLY.filter((k) => (started ? m.fields[k] !== started.fields[k] : changed.includes(k)));
  }

  async #started(since: number): Promise<void> {
    if (this.#state.startedWith?.since === since) return; // this run's, kept across an agent restart
    const file = await this.#readSettings();
    this.#state.startedWith = { since, model: file.model };
    this.#state.failedLive = [];
    this.#persist();
    await this.refresh();
  }

  #good(since: number, gated: boolean): void {
    const started = this.#state.startedWith;
    if (started?.since === since && started.model && passwordOk(started.model.password)) this.#state.lastGood = started.model;
    if (gated) console.log('[settings] the server started with the settings written last');
    this.#persist();
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

  async #readSettings(): Promise<FileRead> {
    try {
      const text = await within(this.#o.config, (base) => readIn(base, SETTINGS_FILE));
      if (text === null) return { model: null, problem: `${SETTINGS_FILE} is missing or not a regular file`, extra: [], password: null };
      return parseSettings(text);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return { model: null, problem: e.code ? `the config folder can't be read (${e.code})` : e.message, extra: [], password: null };
    }
  }

  /** The adminlist's names; null when it can't be read (missing counts as none). */
  async #readAdmins(): Promise<string[] | null> {
    try {
      const text = await within(this.#o.config, (base) => readIn(base, ADMINS_FILE));
      return text === null ? [] : parseAdmins(text);
    } catch {
      return null;
    }
  }

  /** `<state>/settings.json`, written whole (mode 600: it holds the last good password), one write after another. */
  #persist(): void {
    const s = this.#state;
    const content = JSON.stringify({ ...s, armedAt: this.#gate.armedAt }) + '\n';
    const file = this.#file;
    this.#saving = this.#saving
      .then(async () => {
        await mkdir(this.#o.state, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await rm(tmp, { force: true });
        await writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
        await rename(tmp, file);
      })
      .catch((err: Error) => console.error(`[settings] can't write ${file}: ${(err as NodeJS.ErrnoException).code ?? err.message}`));
  }

  /** Resolves once the state file writes queued so far are done (tests). */
  get saved(): Promise<void> {
    return this.#saving;
  }
}

/** `/promote` and `/demote` that turn `from` into `to`, ignoring case (the names from the file passed the rule when read). */
function diffAdmins(from: string[], to: string[]): ['promote' | 'demote', string][] {
  const has = new Set(from.map((n) => n.toLowerCase()));
  const wants = new Set(to.map((n) => n.toLowerCase()));
  return [...to.filter((n) => !has.has(n.toLowerCase())).map((n) => ['promote', n] as ['promote', string]), ...from.filter((n) => !wants.has(n.toLowerCase())).map((n) => ['demote', n] as ['demote', string])];
}

/** Factorio's last `Error` line in its log, without its uptime (e.g. `Error CommandLineMultiplayer.cpp:360: Hosting multiplayer game failed: …`). */
async function lastError(log: string): Promise<string> {
  const lines = await tail(log, 200).catch(() => null);
  const line = lines?.findLast((l) => /^\s*\d+\.\d+ Error /.test(l));
  return line ? printable(line.replace(/^\s*\d+\.\d+ /, '')) : 'no error line in factorio-current.log';
}

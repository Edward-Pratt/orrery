// The game settings' rules (`settings.ts`'s `GameSettings` applies them): the managed keys (`KEYS`) and Factorio's
// defaults for those a file leaves out, the restart-only ones, the file the Agent writes, and the rules across fields.
// `parseSettings`: each managed key by the hub's rule (`settingsFieldOk`), one left out as Factorio's default (but
// `name`, `description` and `visibility`, which Factorio needs), `allow_commands` only as a string (Factorio 2.1.24
// refuses a boolean there); one that fails makes the model null and `problem` names the key, never a value; other keys
// (not `_comment…`) are `extra`. `parseAdmins`: the names that pass the rule, each once whatever its case, 100 at most.
// `keptPassword`: the request's (null: none), else the file's, refused if the rule refuses it ("The file's game
// password can't be kept: set a new one."). `checkSet` refuses verification off with no password, an admin twice in
// any case, a new name over 50 bytes (`NAME_BYTES`, `GAME_SETTINGS.nameBytes`: Factorio 2.1.24 keeps no more), a
// broken UTF-16 character. `renderSettings`: `JSON.stringify` of a new object: the managed keys, `visibility` false and
// false, `non_blocking_saving` false, its own `_comment`; no username, token or admins. `modelOk` and `copyModel`: a
// model the Agent may write back as is (the state file's, read back shape-checked). `restartPending`: the restart-only
// keys, `auto_pause` and `autosave_slots`, that differ from what the run started with.
import type { GameSettingsFields } from '../../hub/src/types.ts';
import { GAME_SETTINGS, LIMITS, settingsFieldOk, type Request } from './wire.ts';

export const SETTINGS_FILE = 'server-settings.json';
export const ADMINS_FILE = 'server-adminlist.json';

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
export type Key = (typeof KEYS)[number];

/**
 * Factorio's own values for the keys a file may leave out (data/server-settings.example.json; setup's file has no
 * `max_players`, for one). Checked on 2.1.24 (2026-11-01): a server started from setup's file answers `/config get`
 * with these for `max-players`, `afk-auto-kick`, `auto-pause-when-players-connect`, `only-admins-can-pause`,
 * `autosave-interval`, `allow-commands` and `require-user-verification` (`auto_pause` and `autosave_slots` have no
 * `/config get`, and setup's file sets both). `name` and `description` have none: Factorio refuses to host without them.
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
export const NAME_BYTES = GAME_SETTINGS.nameBytes;

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

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A password the Agent may put in the file and in a command: none, or one by the rule. */
export const passwordOk = (p: string): boolean => p === '' || GAME_SETTINGS.password.test(p);

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

/** The password to write: the request's (null: none), else the file's, which must be one the rule lets through. */
export function keptPassword(req: Request<'settingsSet'>, before: FileRead): string {
  if (req.game_password !== undefined) return req.game_password ?? '';
  const kept = before.password ?? '';
  if (!passwordOk(kept)) throw new Error("The file's game password can't be kept: set a new one.");
  return kept;
}

/** The rules across fields: throws with the reason the write is refused (before anything is written). */
export function checkSet(req: Request<'settingsSet'>, before: FileRead, after: Model): void {
  const f = after.fields;
  if (!f.require_user_verification && after.password === '') throw new Error('Without the account check a game password is needed.');
  if (!f.name.isWellFormed() || !f.description.isWellFormed()) throw new Error('The name or the description has a broken character.');
  if (f.name !== before.model?.fields.name && Buffer.byteLength(f.name) > NAME_BYTES) {
    throw new Error(`Factorio keeps only the first ${NAME_BYTES} bytes of a server's name: use a shorter one.`);
  }
  const lower = req.admins.map((n) => n.toLowerCase());
  const twice = req.admins.find((_, i) => lower.indexOf(lower[i]!) !== i);
  if (twice !== undefined) throw new Error(`admins: ${twice} is listed twice.`);
}

/** Every key a reply or a report may name, in one order. */
export const ORDER: readonly string[] = [...KEYS, 'game_password', 'admins'];
export const ordered = (keys: Iterable<string>): string[] => [...new Set(keys)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).slice(0, LIMITS.pending);

/** The keys whose value differs between `before` (null: unreadable, so all of them) and `after`. */
export function changedKeys(before: Model | null, beforePassword: string, after: Model): string[] {
  const keys: string[] = KEYS.filter((k) => !before || before.fields[k] !== after.fields[k]);
  if (beforePassword !== after.password) keys.push('game_password');
  return keys;
}

/**
 * The restart-only keys of `m` the running server doesn't have: those that differ from what it started with
 * (`started`), else those `changed`.
 */
export function restartPending(started: Model | null | undefined, m: Model, changed: string[]): Key[] {
  return RESTART_ONLY.filter((k) => (started ? m.fields[k] !== started.fields[k] : changed.includes(k)));
}

/** Whether `m` is a model the Agent may write back as is: every field by its rule, and a password by its own. */
export function modelOk(m: unknown): m is Model {
  if (!isObject(m) || !isObject(m.fields) || typeof m.password !== 'string' || !passwordOk(m.password)) return false;
  const fields = m.fields;
  return KEYS.every((k) => Object.hasOwn(fields, k) && settingsFieldOk(k, fields[k]));
}
export const copyModel = (m: Model): Model => ({ fields: Object.fromEntries(KEYS.map((k) => [k, m.fields[k]])) as GameSettingsFields, password: m.password });

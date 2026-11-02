// Wire contract between the hub and what connects to it, one JSON object per line: a Mod or an Agent's game
// connection (`parseModLine`), and an Agent connection (`parseAgentLine`).
// The message types live in types.ts (pure types, for the dashboard and the agent too); this file validates against them.
//
// Validation of the wire messages (their types are in `types.ts`, re-exported here): a schema per message type,
// checked to have exactly its type's fields, with a limit on every field (`LIMITS`: player names 64, messages 1 KiB,
// `players[]` 200, `output[]` 500 lines of 1 KiB, `detail` 2 KiB, `saves[]`/`mods[]` 500, `reply.data` 256 KiB as
// JSON, an `update`'s URLs 2 KiB (`LIMITS.url`, for what the hub sends), a factorio server's game settings' `name`
// 100 (`serverName`), `admins[]` 100, `bans[]` 500 and a ban's `reason` 200 (a `playerLists` answer), `pending[]` 16,
// `extra[]` 32, any other string 256; the same on both ports); over a limit the message is refused, but a command's
// `output` and a `backup`'s `detail` are cut to fit (Mods already deployed send up to 2000 lines of any length).
// `LIMITS.lineBytes` (1 MiB, the newline not counted) is the Agent port's line cap, for its line reader.
// `parseModLine` for a game connection (a Mod's, or an Agent's for its server: `milestone`, `heartbeat.paused`),
// `parseAgentLine` for the Agent port (`agentHello`, a game `hello` as a first line, and the Agent connection's
// messages), `parseReplyData(request, data)` for an ok `reply`'s data (`journal`/`log`: 1000 lines of 1 KiB; `logs`:
// file entries; `settingsSet`: `applied` and `pending` keys; `playerLists` and `moderate`: the bans and admins by the
// admins' rule, `outcome` one of four). `GAME_SETTINGS`: the rules of one game settings field, each integer key's
// range, the characters a name or description may not hold, a game password's, an admin name's and a settings key's
// patterns, and `nameBytes`, a changed name's most UTF-8 bytes (the Agent's `wire.ts` holds a copy), which the
// `settings` schema applies to every field (a name also trimmed); the rules across fields are the modules'. Each
// returns a new object of only the schema's fields, nested ones too, or null; a `reply`'s `data` alone is only
// size-checked (one too deep to serialise is refused), so nothing reads it before `parseReplyData`.
// `PROTOCOL_VERSION` is shared by the Mod's hello and `agentHello`. The contract with the mod and the Agent.
import type {
  AgentHello,
  AgentMsg,
  AgentReplyData,
  DimTime,
  GameSettingsFields,
  GameSettingsValues,
  Hello,
  HubMsg,
  ModMsg,
  QuestDone,
} from './types.ts';
export type {
  AgentHello,
  AgentMsg,
  AgentReplyData,
  AgentRequest,
  DimTime,
  Hello,
  HubAgentMsg,
  HubMsg,
  ModMsg,
  QuestDone,
} from './types.ts';

/** The Mod's protocol version; an Agent's `agentHello` announces the same number. */
export const PROTOCOL_VERSION = 1;
/**
 * Oldest mod protocol the hub still accepts. Policy (docs/adr/0001): the hub supports the current and the
 * previous version, so servers can update their mods one at a time.
 */
export const MIN_PROTOCOL = 1;

/**
 * Field limits, the same on the Mod port and the Agent port: string lengths in characters (UTF-16 code units),
 * lists in entries. A message with a field over its limit is invalid as a whole, but for a command's `output` and a
 * `backup`'s `detail`, which are cut to their limits: Mods already deployed send up to 2000 lines of any length, and
 * an exception's text as is. `text` is every string with no limit of its own (ids, tokens, versions, unit names,
 * tags, file names).
 */
export const LIMITS = {
  /** A player name; a Factorio force's too. */
  player: 64,
  /** Chat and death messages, a milestone's text. */
  message: 1024,
  players: 200,
  /** A command's output lines, of `line` each. */
  output: 500,
  /** One line of output, a log or a journal. */
  line: 1024,
  /** A `reply`'s `data`, as serialised JSON. */
  replyData: 256 * 1024,
  /** The lines of a `log` or `journal` reply. */
  logLines: 1000,
  saves: 500,
  mods: 500,
  /**
   * A backup's or update step's `detail`, a `reply`'s `error`, an `events`' `reason`, a `settings`' `problem` and
   * `rolledBack`.
   */
  detail: 2048,
  /** A `deployResult`'s `log`: the last 40 lines of the deploy. */
  deployLog: 16 * 1024,
  /** A host sample's mounts, and the files a `logs` reply lists. */
  disks: 32,
  logFiles: 32,
  /** An `update`'s download URLs (a mod's signed link is longer than `text`). */
  url: 2048,
  /** A factorio server's name in its game settings (`settings`, `settingsSet`); its description is `text`. */
  serverName: 100,
  /** The admins in a `settings` or `settingsSet`, and in a `playerLists` answer. */
  admins: 100,
  /** The bans in a `playerLists` answer, and a ban's (or a `moderate`'s) reason in characters. */
  bans: 500,
  reason: 200,
  /** The keys a `settings` lists as `pending`, and a `settingsSet` answer as `applied` or `pending`. */
  pending: 16,
  /** The keys a `settings` lists as `extra`. */
  extra: 32,
  text: 256,
  /** A `saveChunk`'s `data`: base64 of at most 512 KiB, so its line stays well under `lineBytes`. */
  saveChunk: 700_000,
  /** An uploaded save's size. */
  saveBytes: 1024 * 1024 * 1024,
  /**
   * Bytes in one line on the Agent port (its newline not counted), before and after the handshake: a longer line
   * destroys the socket. The Agent keeps every line it sends at or under it.
   */
  lineBytes: 1024 * 1024,
} as const;

/**
 * The rules of a factorio server's game settings that hold for one field (docs/notes/factorio-world-settings.md,
 * "What can be changed"), the hub's and the Agent's alike (agent/src/wire.ts holds a copy): `ranges`, each integer
 * key's lowest and highest value; `control`, what a name or a description may not hold (C0, DEL, C1 and the line and
 * paragraph separators, so each is one printable line; a name is also trimmed and 1 to `LIMITS.serverName` long, a
 * description at most `LIMITS.text`); `password`, a game password (printable ASCII without a space, 1 to 64);
 * `admin`, an admin's name; `key`, a settings key as `pending`, `extra` and `applied` name one; `nameBytes`, the most
 * UTF-8 bytes of a name that changes (a longer one already in the file is read as it is). The rules across fields (no
 * user verification without a game password, an admin named once whatever the case, `nameBytes`) are the modules'.
 */
export const GAME_SETTINGS = {
  ranges: {
    max_players: [0, 1000],
    autosave_interval: [0, 1440],
    autosave_slots: [1, 100],
    afk_autokick_interval: [0, 1440],
  },
  control: /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/,
  password: /^[\x21-\x7e]{1,64}$/,
  admin: /^[A-Za-z0-9_.-]{1,60}$/,
  key: /^[a-z_]{1,64}$/,
  /** A new name's most UTF-8 bytes: Factorio 2.1.24 keeps no more, from the file and from `/config set`. */
  nameBytes: 50,
} as const;

/** A failed check. */
const BAD = Symbol('bad');
/** Checks one field's value: a fresh copy of it (`undefined`: an optional field left out), or `BAD`. */
type Check = (v: unknown) => unknown;
/** One check per field of a message, its `type` left out. */
type Fields<M> = { [K in Exclude<keyof M, 'type'>]-?: Check };
/** A schema per message type, each with exactly that type's fields. */
type Schemas<M extends { type: string }> = { [T in M['type']]: Fields<Extract<M, { type: T }>> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str =
  (max: number = LIMITS.text, min = 0): Check =>
  (v) =>
    typeof v === 'string' && v.length >= min && v.length <= max ? v : BAD;
const num: Check = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : BAD);
/** An integer from `min` to `max`. */
const int =
  (min: number, max: number): Check =>
  (v) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v : BAD;
const bool: Check = (v) => (typeof v === 'boolean' ? v : BAD);
/** A string cut to `max` characters, for the fields older Mods send without a limit. */
const clipped =
  (max: number): Check =>
  (v) =>
    typeof v === 'string' ? v.slice(0, max) : BAD;
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v) ? v : BAD;
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined ? undefined : check(v);
/** `check`'s value, or null. */
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null ? null : check(v);
/** A string `re` matches. */
const matching =
  (re: RegExp): Check =>
  (v) =>
    typeof v === 'string' && re.test(v) ? v : BAD;
const list =
  (item: Check, max: number, min = 0): Check =>
  (v) => {
    if (!Array.isArray(v) || v.length < min || v.length > max) return BAD;
    const out: unknown[] = [];
    for (const x of v) {
      const c = item(x);
      if (c === BAD) return BAD;
      out.push(c);
    }
    return out;
  };
/** As `list`, but entries past `max` are dropped instead of refusing the list. */
const clippedList =
  (item: Check, max: number): Check =>
  (v) =>
    Array.isArray(v) ? list(item, max)(v.slice(0, max)) : BAD;
/** A new object holding only `fields`, each checked; optional ones left out stay out. */
function pick(fields: Record<string, Check>, v: Record<string, unknown>): Record<string, unknown> | typeof BAD {
  const out: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(fields)) {
    const c = check(Object.hasOwn(v, key) ? v[key] : undefined);
    if (c === BAD) return BAD;
    if (c !== undefined) out[key] = c;
  }
  return out;
}
const object =
  (fields: Record<string, Check>): Check =>
  (v) =>
    isObject(v) ? pick(fields, v) : BAD;
/**
 * Any JSON value up to `max` characters serialised, as is (it came from `JSON.parse`, so it is a fresh tree). One
 * too deeply nested to serialise again is refused, not thrown.
 */
const json =
  (max: number): Check =>
  (v) => {
    if (v === undefined) return v;
    try {
      return JSON.stringify(v).length <= max ? v : BAD;
    } catch {
      return BAD;
    }
  };

const player = str(LIMITS.player);
const output = clippedList(clipped(LIMITS.line), LIMITS.output);
const lines = object({ lines: list(str(LIMITS.line), LIMITS.logLines) });
const hello = { protocol: num, serverId: str(), token: str(), modVersion: str() };

// A factorio server's game settings, each field by its rule in `GAME_SETTINGS`.
const oneLine =
  (max: number, min = 0): Check =>
  (v) =>
    typeof v === 'string' && !GAME_SETTINGS.control.test(v) ? str(max, min)(v) : BAD;
const serverName: Check = (v) => (typeof v === 'string' && v === v.trim() ? oneLine(LIMITS.serverName, 1)(v) : BAD);
const range = (key: keyof typeof GAME_SETTINGS.ranges): Check => int(GAME_SETTINGS.ranges[key][0], GAME_SETTINGS.ranges[key][1]);
const settingsFields = {
  name: serverName,
  description: oneLine(LIMITS.text),
  max_players: range('max_players'),
  require_user_verification: bool,
  autosave_interval: range('autosave_interval'),
  autosave_slots: range('autosave_slots'),
  afk_autokick_interval: range('afk_autokick_interval'),
  auto_pause: bool,
  auto_pause_when_players_connect: bool,
  only_admins_can_pause_the_game: bool,
  allow_commands: oneOf('true', 'false', 'admins-only'),
} satisfies Fields<GameSettingsFields>;
const admins = list(matching(GAME_SETTINGS.admin), LIMITS.admins);
const keys = (max: number): Check => list(matching(GAME_SETTINGS.key), max);

/** A game connection: a Mod's on the Mod port, or an Agent's for its server on the Agent port. */
const GAME: Schemas<Hello | ModMsg> = {
  hello,
  started: {},
  stopping: {},
  heartbeat: {
    tps: num,
    players: list(player, LIMITS.players),
    dims: optional(list(object({ id: num, name: str(LIMITS.text, 1), ms: num }), 5)), // older mods don't send it
    paused: optional(bool),
  },
  chat: { player, message: str(LIMITS.message) },
  join: { player },
  leave: { player },
  death: { player, message: str(LIMITS.message) },
  achievement: { player, achievement: str() },
  cmdResult: { id: str(), output },
  cmdLate: { id: str(), output },
  quest: { player, quests: list(object({ name: str(LIMITS.text, 1), main: bool }), 50, 1) },
  link: { player, uuid: str(), code: str() },
  unlink: { player },
  backup: { ok: bool, detail: clipped(LIMITS.detail) },
  milestone: {
    kind: oneOf('research', 'rocket', 'platform', 'landing'),
    text: str(LIMITS.message),
    player: optional(player),
    force: optional(player),
  },
};

const STEPS = ['prepare', 'backup', 'stop', 'swap', 'gate', 'rollback'];
/** The first line on the Agent port (an `agentHello`, or a game connection's `hello`), and an Agent connection. */
const AGENT: Schemas<AgentHello | Hello | AgentMsg> = {
  agentHello: { protocol: num, agentId: str(), token: str(), agentVersion: str() },
  hello,
  ping: {},
  bye: {},
  hostSample: {
    sample: object({
      ts: num,
      cpu: num,
      load: list(num, 3),
      memory: object({ used: num, total: num }),
      disks: list(object({ mount: str(), free: num, total: num }), LIMITS.disks),
    }),
  },
  serviceState: { unit: str(), active: str(), sub: str(), since: num, result: str() },
  saves: {
    saves: list(object({ name: str(), size: num, mtime: num, kind: oneOf('named', 'auto', 'world'), current: bool }), LIMITS.saves),
    free: num,
  },
  installed: { factorio: str(), mods: list(object({ name: str(), version: str() }), LIMITS.mods) },
  updateStep: { id: str(), step: oneOf(...STEPS), state: oneOf('waiting', 'running', 'done', 'failed'), detail: str(LIMITS.detail) },
  updateDone: {
    id: str(),
    outcome: oneOf('ok', 'rolled back', 'failed in staging', 'failed before swap', 'failed', 'cancelled'),
    from: str(),
    to: str(),
    backup: optional(str()),
  },
  deployResult: { tag: str(), outcome: oneOf('ok', 'failed', 'rolled back'), log: str(LIMITS.deployLog) },
  events: { on: bool, reason: optional(str(LIMITS.detail)) },
  settings: {
    settings: nullable(object({ ...settingsFields, game_password_set: bool } satisfies Fields<GameSettingsValues>)),
    admins,
    problem: nullable(str(LIMITS.detail)),
    pending: keys(LIMITS.pending),
    extra: keys(LIMITS.extra),
    rolledBack: nullable(str(LIMITS.detail)),
  },
  reply: { id: str(), ok: bool, error: optional(str(LIMITS.detail)), data: json(LIMITS.replyData) },
};

/** The `data` of an ok `reply`, per request that answers with data. */
/** A `playerLists` answer: every name by the admin rule (a player's name), a reason one line within its limit. */
const playerLists = object({
  bans: list(object({ name: matching(GAME_SETTINGS.admin), reason: nullable(str(LIMITS.reason)) }), LIMITS.bans),
  bansTotal: int(0, Number.MAX_SAFE_INTEGER),
  hidden: int(0, Number.MAX_SAFE_INTEGER),
  admins: list(matching(GAME_SETTINGS.admin), LIMITS.admins),
  verification: nullable(bool),
  problem: nullable(str(LIMITS.detail)),
});
const REPLY_DATA: { [K in keyof AgentReplyData]: Check } = {
  journal: lines,
  log: lines,
  logs: object({ files: list(object({ name: str(), size: num, modified: num }), LIMITS.logFiles) }),
  settingsSet: object({ applied: keys(LIMITS.pending), pending: keys(LIMITS.pending) }),
  saveUploadEnd: object({ name: str() }),
  playerLists,
  moderate: object({ outcome: oneOf('done', 'already', 'notOnline', 'unconfirmed'), lists: playerLists }),
};

/** The requests whose ok `reply` carries `data`: exactly those with a schema above, so the two can never drift. */
export const REPLY_WITH_DATA: ReadonlySet<string> = new Set(Object.keys(REPLY_DATA));

/** One line against `schemas`: a new object of only the schema's fields, or null. */
function parse(line: string, schemas: Record<string, Record<string, Check>>): Record<string, unknown> | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(msg) || typeof msg.type !== 'string' || !Object.hasOwn(schemas, msg.type)) return null;
  const fields = pick(schemas[msg.type]!, msg);
  return fields === BAD ? null : { type: msg.type, ...fields };
}

/**
 * Parses one line of a game connection (a Mod's, or an Agent's for its server); null for malformed JSON, unknown
 * types, wrong field types or a field over its limit. The result is a new object holding only the schema's fields.
 */
export function parseModLine(line: string): Hello | ModMsg | null {
  return parse(line, GAME) as Hello | ModMsg | null;
}

/**
 * Parses one line on the Agent port: an `agentHello`, a game connection's `hello` (as a first line only; after it,
 * the connection's lines go through `parseModLine`) or an Agent connection's message. Null and copies as
 * `parseModLine`.
 */
export function parseAgentLine(line: string): AgentHello | Hello | AgentMsg | null {
  return parse(line, AGENT) as AgentHello | Hello | AgentMsg | null;
}

/** An ok reply's `data` for a request of type `request`, copied; null if it isn't that request's shape or over a limit. */
export function parseReplyData<K extends keyof AgentReplyData>(request: K, data: unknown): AgentReplyData[K] | null {
  const v = REPLY_DATA[request](data);
  return v === BAD ? null : (v as AgentReplyData[K]);
}

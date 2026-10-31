// The agent's side of the wire contract (docs/protocol.md, "Agent connection"): the hub's constants, the capped line
// reader, the line encoder and the checks on what the hub sends. The message types come from hub/src/types.ts through
// `import type` only: an agent release carries no hub code, so the constants are copies, checked by test/wire.test.ts.
import type { AgentHello, AgentMsg, AgentRequest, Hello, HubAgentMsg, HubMsg, ModMsg } from '../../hub/src/types.ts';

/** The protocol version in both hellos: the hub's `PROTOCOL_VERSION`, which `agentHello` shares with the Mod's. */
export const PROTOCOL_VERSION = 1;

/** The hub's field limits (`LIMITS` in hub/src/protocol.ts): characters (UTF-16 code units), entries, or bytes. */
export const LIMITS = {
  player: 64,
  message: 1024,
  players: 200,
  output: 500,
  line: 1024,
  replyData: 256 * 1024,
  logLines: 1000,
  saves: 500,
  mods: 500,
  detail: 2048,
  deployLog: 16 * 1024,
  disks: 32,
  logFiles: 32,
  text: 256,
  /** Bytes in one line on the Agent port, its `\n` included, either way: the hub destroys a socket that sends more. */
  lineBytes: 1024 * 1024,
} as const;

/** Everything the agent sends on either connection. */
export type OutMsg = AgentHello | AgentMsg | Hello | ModMsg;

export class LineTooLong extends Error {}

/**
 * Splits a socket's bytes into lines, a line ending at `\n`. A line of more than `max` bytes (its `\n` included)
 * throws `LineTooLong` as soon as its unfinished part reaches that size, so a huge line is never held. Blank lines are
 * skipped.
 */
export class LineReader {
  #max: number;
  #parts: Buffer[] = [];
  #size = 0;

  constructor(max: number = LIMITS.lineBytes) {
    this.#max = max;
  }

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, nl);
      if (this.#size + piece.length + 1 > this.#max) throw new LineTooLong(`a line over ${this.#max} bytes`);
      const line = this.#size === 0 ? piece.toString('utf8') : Buffer.concat([...this.#parts, piece]).toString('utf8');
      this.#parts = [];
      this.#size = 0;
      if (line.trim() !== '') lines.push(line);
      start = nl + 1;
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0) {
      if (this.#size + rest.length + 1 > this.#max) throw new LineTooLong(`a line over ${this.#max} bytes`);
      this.#parts.push(Buffer.from(rest)); // a copy: the chunk's memory is not kept alive by a slice
      this.#size += rest.length;
    }
    return lines;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A message as the line to send, `\n` included, of at most `LIMITS.lineBytes` bytes. A command's `output` or a
 * reply's `data.lines` that doesn't fit loses its oldest (first) lines until it does; the JSON is never cut. Null: the
 * message can't fit, and is not to be sent.
 */
export function encode(msg: OutMsg): string | null {
  const line = JSON.stringify(msg) + '\n';
  if (Buffer.byteLength(line) <= LIMITS.lineBytes) return line;
  if (msg.type === 'cmdResult' || msg.type === 'cmdLate') return fit(msg.output, (output) => ({ ...msg, output }));
  if (msg.type === 'reply' && isObject(msg.data) && Array.isArray(msg.data.lines)) {
    const data = msg.data;
    return fit(data.lines as unknown[], (lines) => ({ ...msg, data: { ...data, lines } }));
  }
  return null;
}

/** `make(lines)` as a line, without as many of the first lines as it takes to fit. */
function fit<T>(lines: T[], make: (lines: T[]) => OutMsg): string | null {
  // Each line's bytes in the list, a comma counted for every one (one more than JSON has).
  const sizes = lines.map((l) => Buffer.byteLength(JSON.stringify(l)) + 1);
  let total = Buffer.byteLength(JSON.stringify(make([]))) + 1 + sizes.reduce((a, b) => a + b, 0);
  let drop = 0;
  while (drop < lines.length && total > LIMITS.lineBytes) total -= sizes[drop++]!;
  const line = JSON.stringify(make(lines.slice(drop))) + '\n';
  return Buffer.byteLength(line) <= LIMITS.lineBytes ? line : null;
}

// ---- What the hub sends, checked like the hub checks what it gets (hub/src/protocol.ts): a fresh object holding only
// the documented fields, each within its limit.

const BAD = Symbol('bad');
type Check = (v: unknown) => unknown;
type Fields<M> = { [K in Exclude<keyof M, 'type'>]-?: Check };
type Schemas<M extends { type: string }> = { [T in M['type']]: Fields<Extract<M, { type: T }>> };

const str =
  (max: number = LIMITS.text, min = 0): Check =>
  (v) =>
    typeof v === 'string' && v.length >= min && v.length <= max ? v : BAD;
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v) ? v : BAD;
const list =
  (item: Check, max: number): Check =>
  (v) => {
    if (!Array.isArray(v) || v.length > max) return BAD;
    const out: unknown[] = [];
    for (const x of v) {
      const c = item(x);
      if (c === BAD) return BAD;
      out.push(c);
    }
    return out;
  };
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

/** A request's id: what its reply carries back. */
const id = str(LIMITS.text, 1);

/** The Agent connection: the handshake's answer, then the hub's requests. */
const AGENT: Schemas<HubAgentMsg> = {
  welcome: {},
  reject: { reason: str(LIMITS.detail) },
  serviceAct: { id, action: oneOf('start', 'stop', 'restart') },
  journal: { id, unit: str() },
  logs: { id },
  log: { id, name: str() },
  restore: { id, name: str() },
  update: {
    id,
    factorio: object({ version: str(), url: str(), sha256: str() }),
    mods: list(object({ name: str(), version: str(), sha1: str(), url: str() }), LIMITS.mods),
  },
  updateResume: { id },
  updateCancel: { id },
  deploy: { id, tag: str() },
};

/** What the agent handles on the game connection so far: the handshake's answer. The rest of `HubMsg` reads as unknown. */
export type GameIn = Extract<HubMsg, { type: 'welcome' | 'reject' }>;
const GAME: Schemas<GameIn> = {
  welcome: {},
  reject: { reason: str(LIMITS.detail) },
};

/** A line from the hub: the message, or why it isn't one (`id`: the request's, if it had a usable one, to answer). */
export type Read<M> = { msg: M } | { msg: null; id: string | null; why: string };

function read<M>(line: string, schemas: Record<string, Record<string, Check>>): Read<M> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { msg: null, id: null, why: 'not JSON' };
  }
  if (!isObject(raw) || typeof raw.type !== 'string') return { msg: null, id: null, why: 'no type' };
  const rid = id(raw.id);
  const known = rid === BAD ? null : (rid as string);
  if (!Object.hasOwn(schemas, raw.type)) return { msg: null, id: known, why: 'unknown type' };
  const fields = pick(schemas[raw.type]!, raw);
  if (fields === BAD) return { msg: null, id: known, why: `invalid ${raw.type}` };
  return { msg: { type: raw.type, ...fields } as M };
}

/** A line on the Agent connection, checked against the documented fields and limits. */
export const readAgentLine = (line: string): Read<HubAgentMsg> => read(line, AGENT);
/** A line on the game connection, checked the same way. */
export const readGameLine = (line: string): Read<GameIn> => read(line, GAME);

/** The requests, for handler tables. */
export type Request<T extends AgentRequest['type']> = Extract<AgentRequest, { type: T }>;

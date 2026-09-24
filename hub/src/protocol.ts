// Wire contract between the mod and the hub: one JSON object per line.
export const PROTOCOL_VERSION = 1;

export type Hello = { type: 'hello'; protocol: number; serverId: string; token: string; modVersion: string };

export type ModMsg =
  | { type: 'started' }
  | { type: 'stopping' }
  | { type: 'heartbeat'; tps: number; players: string[] }
  | { type: 'chat'; player: string; message: string }
  | { type: 'join'; player: string }
  | { type: 'leave'; player: string }
  | { type: 'death'; player: string; message: string }
  | { type: 'achievement'; player: string; achievement: string }
  | { type: 'cmdResult'; id: string; output: string[] };

export type HubMsg =
  | { type: 'welcome' }
  | { type: 'reject'; reason: string }
  | { type: 'say'; author: string; message: string }
  | { type: 'cmd'; id: string; command: string };

type Kind = 'string' | 'number' | 'string[]';

const SCHEMAS: Record<string, Record<string, Kind>> = {
  hello: { protocol: 'number', serverId: 'string', token: 'string', modVersion: 'string' },
  started: {},
  stopping: {},
  heartbeat: { tps: 'number', players: 'string[]' },
  chat: { player: 'string', message: 'string' },
  join: { player: 'string' },
  leave: { player: 'string' },
  death: { player: 'string', message: 'string' },
  achievement: { player: 'string', achievement: 'string' },
  cmdResult: { id: 'string', output: 'string[]' },
};

function hasKind(value: unknown, kind: Kind): boolean {
  if (kind === 'string[]') return Array.isArray(value) && value.every((v) => typeof v === 'string');
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'string';
}

/** Parses one line from a mod; null for malformed JSON, unknown types, or wrong field types. */
export function parseModLine(line: string): Hello | ModMsg | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;
  if (typeof msg.type !== 'string' || !Object.hasOwn(SCHEMAS, msg.type)) return null;
  for (const [field, kind] of Object.entries(SCHEMAS[msg.type])) {
    if (!hasKind(msg[field], kind)) return null;
  }
  return msg as Hello | ModMsg;
}

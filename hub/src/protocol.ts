// Wire contract between the mod and the hub: one JSON object per line.
// The message types live in types.ts (pure types, for the dashboard too); this file validates against them.
import type { DimTime, Hello, HubMsg, ModMsg, QuestDone } from './types.ts';
export type { DimTime, Hello, HubMsg, ModMsg, QuestDone } from './types.ts';

export const PROTOCOL_VERSION = 1;
/**
 * Oldest mod protocol the hub still accepts. Policy (docs/adr/0001): the hub supports the current and the
 * previous version, so servers can update their mods one at a time.
 */
export const MIN_PROTOCOL = 1;

type Kind = 'string' | 'number' | 'boolean' | 'string[]' | 'dims?' | 'quests';

const SCHEMAS: Record<string, Record<string, Kind>> = {
  hello: { protocol: 'number', serverId: 'string', token: 'string', modVersion: 'string' },
  started: {},
  stopping: {},
  heartbeat: { tps: 'number', players: 'string[]', dims: 'dims?' },
  chat: { player: 'string', message: 'string' },
  join: { player: 'string' },
  leave: { player: 'string' },
  death: { player: 'string', message: 'string' },
  achievement: { player: 'string', achievement: 'string' },
  cmdResult: { id: 'string', output: 'string[]' },
  cmdLate: { id: 'string', output: 'string[]' },
  quest: { player: 'string', quests: 'quests' },
  link: { player: 'string', uuid: 'string', code: 'string' },
  unlink: { player: 'string' },
  backup: { ok: 'boolean', detail: 'string' },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string' && v.length > 0;
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

function hasKind(value: unknown, kind: Kind): boolean {
  switch (kind) {
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'number':
      return finite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'dims?': // optional: older mods don't send it
      return (
        value === undefined ||
        (Array.isArray(value) &&
          value.length <= 5 &&
          value.every((d) => isObject(d) && finite(d.id) && text(d.name) && finite(d.ms)))
      );
    case 'quests':
      return (
        Array.isArray(value) &&
        value.length >= 1 &&
        value.length <= 50 &&
        value.every((q) => isObject(q) && text(q.name) && typeof q.main === 'boolean')
      );
    case 'string':
      return typeof value === 'string';
  }
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

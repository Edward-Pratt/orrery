// The event checks: one of the Factorio mod's datagrams (factorio/CLAUDE.md, "Mod to agent: UDP"), read as untrusted
// and turned into the game connection's message.
//
// `parseDatagram`: `t`, `seq` a safe integer, each field checked against the hub's limits and copied; `message` and
// `text` cut to 1 KiB; not the mod's shape, a string says why (`GameEvents` drops it, each kind logged once per start).
// The mod's `hello` is only a `seq` (`event` null), the baseline for `seq` gaps. Makes `chat`, `join`, `leave` (no
// `reason` on the wire), `death` (`deathMessage`: "Alice was killed by Bob", "… by a medium biter", "Alice died"),
// `milestone` and `link` (`uuid` `""`), `unlink`. `isObject` is shared with `events-commands.ts`.
import type { ModMsg } from '../../hub/src/types.ts';
import { LIMITS } from './wire.ts';

/** The game connection's messages that come from the mod's datagrams. */
export type GameEvent = Extract<ModMsg, { type: 'chat' | 'join' | 'leave' | 'death' | 'milestone' | 'link' | 'unlink' }>;

const CODE = /^[A-Za-z0-9]{1,16}$/;
type Kind = Extract<GameEvent, { type: 'milestone' }>['kind'];
const KINDS: readonly string[] = ['research', 'rocket', 'platform', 'landing'] satisfies Kind[];

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A player (or force) name as the hub takes it: 1 to 64 characters; else null. */
const name = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= LIMITS.player ? v : null);
/** Text cut to the hub's limit for chat and milestones, never leaving half a surrogate pair; null if not a string. */
function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.length <= LIMITS.message) return v;
  const cut = v.slice(0, LIMITS.message);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The hub's death `message`, which it posts as is, so a whole sentence with the player's name: killed by a player
 * (`killer`), by an entity (`cause`, its internal name made readable: `medium-biter` is "a medium biter"), or died.
 */
export function deathMessage(player: string, cause: string | null, killer: string | null): string {
  if (killer) return `${player} was killed by ${killer}`;
  if (!cause) return `${player} died`;
  const what = cause.replace(/[-_]/g, ' ');
  return `${player} was killed by ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}`;
}

/** A datagram as read: an event and its `seq`, or the mod's `hello` (`event` null: only a `seq`). */
export type Datagram = { seq: number; event: GameEvent | null };

/**
 * One datagram of the mod's (factorio/CLAUDE.md, "Mod to agent: UDP"), read as untrusted: JSON with a `t` and a `seq`
 * (a safe integer, 0 or more), the fields of its kind checked against the hub's limits and copied, no others. A
 * required name that doesn't fit drops the event; an optional one (a milestone's `player` or `force`, a death's
 * `cause` or `killer`) is left out; `message` and `text` are cut to fit. A string says why it was dropped.
 */
export function parseDatagram(data: Buffer): Datagram | string {
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString('utf8'));
  } catch {
    return 'not JSON';
  }
  if (!isObject(raw) || typeof raw.t !== 'string') return 'no t';
  const { seq } = raw;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return 'no seq';
  if (raw.t === 'hello') return { seq, event: null };
  const event = toEvent(raw.t, raw);
  return typeof event === 'string' ? event : { seq, event };
}

function toEvent(t: string, raw: Record<string, unknown>): GameEvent | string {
  const player = name(raw.player);
  switch (t) {
    case 'chat': {
      const message = text(raw.message);
      return player && message !== null ? { type: 'chat', player, message } : 'a chat without a player or message';
    }
    case 'join':
    case 'leave': // its reason is not on the wire: the hub's leave has only the player
    case 'unlink':
      return player ? { type: t, player } : `a ${t} without a player`;
    case 'death':
      return player ? { type: 'death', player, message: deathMessage(player, name(raw.cause), name(raw.killer)) } : 'a death without a player';
    case 'milestone': {
      const { kind } = raw;
      const subject = text(raw.text);
      if (typeof kind !== 'string' || !KINDS.includes(kind) || subject === null) return 'a milestone without a kind or text';
      const m: Extract<GameEvent, { type: 'milestone' }> = { type: 'milestone', kind: kind as Kind, text: subject };
      const force = name(raw.force);
      if (player) m.player = player;
      if (force) m.force = force;
      return m;
    }
    case 'link':
      // Factorio has no player UUIDs: the hub links a factorio server's player by name (docs/protocol.md).
      return player && typeof raw.code === 'string' && CODE.test(raw.code) ? { type: 'link', player, uuid: '', code: raw.code } : 'a link without a player or code';
    default:
      return 'an unknown kind of event';
  }
}

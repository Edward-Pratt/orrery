/**
 * The Settings tab's rules, pure: the form's shape, what each field is called, the keys Factorio takes only at a start,
 * setup's defaults, the hub's and the Agent's checks, which of the hub's reasons leave nothing to edit, a changed
 * field, and the generated password. The tab itself is `settings.ts`.
 */
import type { AllowCommands, GameSettingsFields, LiveEvent } from '@hub/api';

export type Key = keyof GameSettingsFields;
/** The form: every field, and the admins. */
export type Form = GameSettingsFields & { admins: string[] };
/** One field changed in the form, as the cards say it. */
export type Edit = { [K in keyof Form]: { key: K; value: Form[K] } }[keyof Form];

/** What a field is called on the page; `game_password` and `admins` too, for the footer and the pending banner. */
export const LABELS: Record<Key | 'game_password' | 'admins', string> = {
  name: 'Name',
  description: 'Description',
  max_players: 'Max players',
  game_password: 'Game password',
  require_user_verification: "Check players' factorio.com accounts",
  autosave_interval: 'Autosave every',
  autosave_slots: 'Autosave slots',
  afk_autokick_interval: 'Kick idle players after',
  auto_pause: 'Pause while nobody is on',
  auto_pause_when_players_connect: 'Pause while a player joins',
  only_admins_can_pause_the_game: 'Only admins can pause',
  allow_commands: 'Lua commands',
  admins: 'Admins',
};
export const KEYS = Object.keys(LABELS).filter((k): k is Key => k !== 'game_password' && k !== 'admins');
/** The keys Factorio takes only at a start (no `/config set` option). */
export const AT_RESTART = new Set<string>(['auto_pause', 'autosave_slots']);
/** What setup writes: shown while the file can't be read, so a save writes a fresh one. */
export const DEFAULTS: GameSettingsFields = {
  name: 'orrery Factorio',
  description: '',
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
// The hub's and the Agent's rules (hub/src/protocol.ts, GAME_SETTINGS), for the form's own checks.
export const RANGES: Partial<Record<Key, [number, number]>> = { max_players: [0, 1000], autosave_interval: [0, 1440], autosave_slots: [1, 100], afk_autokick_interval: [0, 1440] };
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export const PASSWORD = /^[\x21-\x7e]{1,64}$/;
export const ADMIN = /^[A-Za-z0-9_.-]{1,60}$/;
export const ADMIN_RULE = 'Names are 1 to 60 letters, digits, _, . or -.';
/** Factorio 2.1.24 keeps no more of a server's name (UTF-8): the hub and the Agent refuse a longer new one (GAME_SETTINGS.nameBytes). */
export const NAME_BYTES = 50;
export const NEEDS_PASSWORD = 'Without the account check a game password is needed.';
export const COMMANDS: { value: AllowCommands; label: string }[] = [
  { value: 'false', label: 'Off' },
  { value: 'admins-only', label: 'Admins only' },
  { value: 'true', label: 'Everyone' },
];
const GENERATED = 20;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** A Host's Agent went silent or came back: whether a save can go changes. */
export const agentNotice = (e: LiveEvent) => 'target' in e && e.target === 'host' && e.type === 'notice' && (e.kind === 'agentLost' || e.kind === 'agentBack');
/**
 * The hub's reasons that leave nothing to edit (hub/src/servers/game-settings.ts): an Agent too old for game settings, one
 * not connected, and one that hasn't reported yet. Any other reason only holds Save back.
 */
export const readOnlyWhy = (blocked: string | null) =>
  blocked !== null && (blocked.startsWith("This server's Agent runs ") || blocked === "The Agent isn't connected." || blocked.endsWith("hasn't reported its game settings yet."));
export const show = (v: unknown) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : v === '' ? '(empty)' : String(v));
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const lower = (names: string[]) => names.map((n) => n.toLowerCase()).sort();
/** The page's names for these keys, for the footer and the pending banner. */
export const labels = (keys: string[]) => keys.map((k) => LABELS[k as Key] ?? k).join(', ');
/** Whether a field (or the admins, in any order and case) differs from what was saved. */
export function isChanged(form: Form, saved: Form, k: Key | 'admins'): boolean {
  const f = form[k];
  const s = saved[k];
  return Array.isArray(f) ? lower(f).join() !== lower(s as string[]).join() : f !== s;
}

/** 20 random letters and digits, made here in the browser. */
export function generatePassword(): string {
  const out: string[] = [];
  const bytes = new Uint8Array(1);
  while (out.length < GENERATED) {
    crypto.getRandomValues(bytes);
    if (bytes[0]! < 248) out.push(ALPHABET[bytes[0]! % ALPHABET.length]!); // 248 = 4 × 62: no bias
  }
  return out.join('');
}

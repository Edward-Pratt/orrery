// The rules of a factorio server's game settings, for `GameSettings` (`game-settings.ts`): `settingsRequest` checks a
// `PUT /api/settings` body by `GAME_SETTINGS`' rules (400, the reason naming the field, never a value; fields it
// doesn't know dropped; the description trimmed, as Factorio takes it; `game_password` left out keeps it, null
// removes it; admins at most 100, each once whatever the case), and `auditDetails` gives a save's audit entry (each
// changed key with its old and new value, the password only as "game password changed" or "removed", admins as
// `+bob, -alice`). `bad` is the 400 both they and `GameSettings.set` refuse with. Pure: no state, no I/O. Hub core.

import type { GameSettingsRequest } from '../api.ts';
import { GameRefused } from '../updates/factorio.ts';
import { GAME_SETTINGS, LIMITS } from '../protocol.ts';
import type { GameSettingsFields, GameSettingsReport } from '../types.ts';

/** The fields of a request, in the order an audit entry names them (the password and the admins aside). */
const KEYS = [
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
const BOOLEANS = new Set<string>(['require_user_verification', 'auto_pause', 'auto_pause_when_players_connect', 'only_admins_can_pause_the_game']);

export const bad = (why: string) => new GameRefused(400, why);
const oneLine = (v: unknown, max: number, min: number) => typeof v === 'string' && !GAME_SETTINGS.control.test(v) && v.length >= min && v.length <= max;

/**
 * A `PUT /api/settings` body, checked by the rules in `GAME_SETTINGS` (docs/protocol.md, "Game settings"): every
 * field (the description trimmed), the password only when given, and the admins; fields it doesn't know are dropped.
 * Each refusal names the field, never its value. The rules that need the Agent's report (verification off needs a
 * password, a changed name at most `GAME_SETTINGS.nameBytes`) are `set`'s.
 */
export function settingsRequest(body: Record<string, unknown>): GameSettingsRequest {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) {
    const v = body[key];
    if (key === 'name') {
      if (!oneLine(v, LIMITS.serverName, 1) || v !== (v as string).trim()) throw bad(`name: 1 to ${LIMITS.serverName} characters on one line, with no space at either end.`);
    } else if (key === 'description') {
      if (!oneLine(v, LIMITS.text, 0)) throw bad(`description: at most ${LIMITS.text} characters on one line.`);
      out[key] = (v as string).trim(); // as Factorio takes it from `/config set` (seen on 2.1.24)
      continue;
    } else if (key === 'allow_commands') {
      if (v !== 'true' && v !== 'false' && v !== 'admins-only') throw bad('allow_commands: "true", "false" or "admins-only".');
    } else if (BOOLEANS.has(key)) {
      if (typeof v !== 'boolean') throw bad(`${key}: true or false.`);
    } else {
      const [min, max] = GAME_SETTINGS.ranges[key as keyof typeof GAME_SETTINGS.ranges];
      if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw bad(`${key}: a whole number from ${min} to ${max}.`);
    }
    out[key] = v;
  }
  if (Object.hasOwn(body, 'game_password')) {
    const p = body.game_password;
    if (p !== null && (typeof p !== 'string' || !GAME_SETTINGS.password.test(p))) {
      throw bad('game_password: 1 to 64 characters of printable ASCII with no space, or null to remove it.');
    }
    out.game_password = p;
  }
  const admins = body.admins;
  if (!Array.isArray(admins) || admins.length > LIMITS.admins) throw bad(`admins: a list of at most ${LIMITS.admins} names.`);
  const seen = new Set<string>();
  for (const a of admins) {
    if (typeof a !== 'string' || !GAME_SETTINGS.admin.test(a)) throw bad('admins: each name is 1 to 60 letters, digits, "_", "." or "-".');
    if (seen.has(a.toLowerCase())) throw bad('admins: each name once, whatever its case.');
    seen.add(a.toLowerCase());
  }
  out.admins = [...admins];
  return out as GameSettingsRequest;
}

/** A value as an audit entry shows it: strings quoted. */
const shown = (v: unknown) => JSON.stringify(v);

/**
 * An audit entry's details for a save: each changed key with its old and new value (only the new one when the file
 * couldn't be read), the password only as changed or removed, and the admins as `+bob, -alice` (ignoring case).
 */
export function auditDetails(req: GameSettingsRequest, before: GameSettingsReport): string {
  const old = before.settings;
  const parts: string[] = [];
  for (const key of KEYS) {
    if (old && old[key] === req[key]) continue;
    parts.push(old ? `${key}: ${shown(old[key])} → ${shown(req[key])}` : `${key}: ${shown(req[key])}`);
  }
  if (req.game_password === null) {
    if (old?.game_password_set !== false) parts.push('game password removed');
  } else if (req.game_password !== undefined) parts.push('game password changed');
  const had = new Set(before.admins.map((a) => a.toLowerCase()));
  const has = new Set(req.admins.map((a) => a.toLowerCase()));
  const admins = [...req.admins.filter((a) => !had.has(a.toLowerCase())).map((a) => `+${a}`), ...before.admins.filter((a) => !has.has(a.toLowerCase())).map((a) => `-${a}`)];
  if (admins.length) parts.push(`admins: ${admins.join(', ')}`);
  return parts.length ? parts.join('; ') : 'no change';
}

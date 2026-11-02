// `GameSettings` (with agents and systemd), a factorio server's game settings (`server-settings.json` and its
// adminlist, which its Agent reads and writes), for a server an Agent runs (`has`; others 404, `GameRefused`): its
// Agent's latest `settings` report in memory (none before its first; kept while it is away), taken only when it
// differs from the last one (the Agent sends it on every connect, and `SAME` is per socket); `state`
// (`GameSettingsState`: the report and `blocked`: an Agent below `SETTINGS_FLOOR` (`agent-v1.2.0`, through
// `beforeAgentRelease`; the dev loop's `agent-v0.0.0` is not) with the deploy text "This server's Agent runs
// <version>, which can't change game settings. Deploy agent-v1.2.0 or later from the Host page (Releases).", the
// Agent not connected, no report yet, a save under way, a game update, a restore, a hub deploy or its Agent's own, a
// countdown, the unit activating, deactivating or reloading); `set(id, body, by, byName)`: `settingsRequest` checks
// the body by `GAME_SETTINGS`' rules (400, the reason naming the field, never a value; fields it doesn't know
// dropped; the description trimmed, as Factorio takes it; `game_password` left out keeps it, null removes it; admins
// at most 100, each once whatever the case), then verification off needs a password (one sent, or the report's
// `game_password_set` with none sent: else 400 "Without the account check a game password is needed.") and a name
// that changes at most `GAME_SETTINGS.nameBytes` (50) UTF-8 bytes (400 naming the name; one the report already has is
// kept), 409 while `blocked`, then `settingsSet` (one at a time per server: `busy`, which a game update, a restore
// and the Agent's deploy wait for), answered within `SETTINGS_SET_MS` (60 s, over the Agent's worst case of about 50
// s), and the Agent's `{ applied, pending }`, or 502 with its refusal or why it didn't answer; the password is passed
// on once and kept, logged and audited nowhere. Audited after the answer (`game settings`, `auditDetails`: each
// changed key with its old and new value, the password only as "game password changed" or "removed", admins as `+bob,
// -alice`; a refusal with its reason). Notices: `settings` (stream only, on each report change and save: the
// dashboard asks again), `verificationOff`/`verificationOn` (user verification changed from what the hub last knew:
// by a save, with the admin's name, or by a report, `by` null: a rollback or a hand edit; a report read while a save
// is under way is left to the save, and a save refused or unanswered goes by the latest report; the first value a
// restarted hub learns posts none) and `settingsRolledBack` (a report whose `rolledBack` changed from one the hub had
// heard: also audited as `hub:agent`, `game settings rollback`, with the Agent's detail; a restarted hub's first
// report posts none), each for Discord's `alertsChannel` alone (`channelFor`), never the server's channel, where its
// players read. Hub core.

import { AgentRefused, beforeAgentRelease, type Agents } from '../agents/agents.ts';
import type { GameSettingsAnswer, GameSettingsRequest, GameSettingsState } from '../api.ts';
import type { ServerSettings } from '../config.ts';
import { GameRefused } from '../updates/factorio.ts';
import { GAME_SETTINGS, LIMITS } from '../protocol.ts';
import type { RestartScheduler } from './restarts.ts';
import type { ServerHub } from './servers.ts';
import type { Services } from '../services/services.ts';
import type { AgentMsg, GameSettingsFields, GameSettingsReport } from '../types.ts';

/** The first Agent release that reads and writes its server's game settings (the repo's `agent-v0.0.0` counts as later). */
export const SETTINGS_FLOOR = 'agent-v1.2.0';
/**
 * How long a `settingsSet` may take to be answered: over the Agent's worst case (its deploy check's and its unit's
 * `systemctl` calls, 10 s each at most, 20 s of live commands plus the one under way past them, 8 s, and 2 s for the
 * adminlist: about 50 s), so a save it applied is never reported as unanswered.
 */
export const SETTINGS_SET_MS = 60_000;

export type GameSettingsDeps = {
  hub: Pick<ServerHub, 'publish' | 'audit'>;
  agents: Pick<Agents, 'list' | 'get' | 'request' | 'on'>;
  services: Pick<Services, 'ofServer'>;
  restarts: Pick<RestartScheduler, 'pending'>;
  /** The servers, for their names. */
  servers: Pick<ServerSettings, 'id' | 'name'>[];
  /** What update runs on a server (a game update), by kind; null: none. */
  updating: (serverId: string) => string | null;
  /** Whether a restore runs on a server. */
  restoring: (serverId: string) => boolean;
  /** What deploy runs that a save must not race (`agentId`: the server's Agent): a hub deploy, or the Agent's own. */
  deploying: (agentId: string) => 'hub' | 'agent' | null;
};

/** What a server reports before its Agent's first `settings`. */
const NONE: GameSettingsReport = { settings: null, admins: [], problem: null, pending: [], extra: [], rolledBack: null };
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
/** A unit in one of these states is starting or stopping: a save waits for it. */
const MOVING = new Set(['activating', 'deactivating', 'reloading']);

const bad = (why: string) => new GameRefused(400, why);
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

/**
 * A factorio server's game settings (`server-settings.json` and its adminlist), for a server an Agent runs (`has`;
 * others 404). The Agent reads and writes the files: the hub keeps its latest `settings` report in memory (none before
 * its first), checks a save by the same rules (`settingsRequest`) and sends it as `settingsSet`, never keeping or
 * logging the password. Each change of the report, and each save, goes on the server's stream as a `settings` notice;
 * user verification turning off or on (a save, with the admin's name, or a report: a rollback, a hand edit), and a
 * rollback the Agent reports, are notices for Discord's alerts channel too. Hub core.
 */
export class GameSettings {
  #d: GameSettingsDeps;
  #agentOf = new Map<string, string>();
  #serverOf = new Map<string, string>();
  #reports = new Map<string, GameSettingsReport>();
  #saving = new Set<string>();
  /** The user verification the hub last knew each server's file to have (a save's, or a report's), for its notices. */
  #verification = new Map<string, boolean>();

  constructor(deps: GameSettingsDeps) {
    this.#d = deps;
    for (const a of deps.agents.list()) {
      this.#agentOf.set(a.server, a.id);
      this.#serverOf.set(a.id, a.server);
    }
  }

  /** Listens to the Agents' `settings`. Before any Agent connects. */
  start(): void {
    this.#d.agents.on('settings', (agentId, msg) => this.#onReport(agentId, msg));
  }

  /** Whether a server has game settings: an Agent runs it. */
  has(serverId: string): boolean {
    return this.#agentOf.has(serverId);
  }

  /** Whether a save of a server's game settings is under way. */
  busy(serverId: string): boolean {
    return this.#saving.has(serverId);
  }

  /** The Agent's latest report (or none yet), and why a save is refused now. */
  state(serverId: string): GameSettingsState {
    this.#name(serverId);
    return { ...(this.#reports.get(serverId) ?? NONE), blocked: this.#blocked(serverId) };
  }

  /**
   * Checks a save (400 naming the field), refuses it while `blocked` (409), sends it to the Agent and answers what
   * applied at once and what waits for a restart (502 with the Agent's reason when it didn't take it). `by` is the
   * audit's actor, `byName` the admin's name for Discord. The password is passed on once and kept nowhere.
   */
  async set(serverId: string, body: Record<string, unknown>, by: string, byName: string): Promise<GameSettingsAnswer> {
    const name = this.#name(serverId);
    const req = settingsRequest(body);
    const before = this.#reports.get(serverId) ?? NONE;
    if (req.name !== before.settings?.name && new TextEncoder().encode(req.name).length > GAME_SETTINGS.nameBytes) {
      throw bad(`name: Factorio keeps only the first ${GAME_SETTINGS.nameBytes} bytes of a server's name (UTF-8): use a shorter one.`);
    }
    if (!req.require_user_verification) {
      const kept = req.game_password === undefined && before.settings?.game_password_set === true;
      if (!(typeof req.game_password === 'string' || kept)) throw bad('Without the account check a game password is needed.');
    }
    const blocked = this.#blocked(serverId);
    if (blocked) throw new GameRefused(409, blocked);
    const { game_password, admins, ...settings } = req;
    const details = auditDetails(req, before);
    this.#saving.add(serverId);
    let answer: GameSettingsAnswer;
    try {
      answer = await this.#d.agents.request(this.#agentOf.get(serverId)!, {
        type: 'settingsSet',
        settings,
        ...(game_password !== undefined && { game_password }),
        admins,
      }, { timeoutMs: SETTINGS_SET_MS });
    } catch (err) {
      const why = err instanceof AgentRefused ? err.message : `${name}'s Agent didn't answer: ${(err as Error).message}`;
      this.#d.hub.audit(by, 'game settings', serverId, `${details} (refused: ${why})`);
      this.#saving.delete(serverId);
      // An Agent that wrote the file but answered too late has pushed it meanwhile: its report is what holds.
      this.#announce(serverId, this.#reports.get(serverId)?.settings?.require_user_verification, null);
      throw new GameRefused(502, why);
    }
    this.#saving.delete(serverId);
    this.#d.hub.audit(by, 'game settings', serverId, details);
    // A file the hub never read held verification on as far as it knows (setup writes it on).
    if (!this.#verification.has(serverId)) this.#verification.set(serverId, true);
    this.#announce(serverId, req.require_user_verification, byName);
    this.#d.hub.publish(serverId, { kind: 'settings', severity: 'info' });
    return answer;
  }

  /**
   * User verification as the hub now knows it for a server: a change from what it knew is a notice (`by`: the
   * admin's name for a save, null for a report); the first value it learns is only kept.
   */
  #announce(serverId: string, on: boolean | undefined, by: string | null): void {
    if (on === undefined) return;
    const was = this.#verification.get(serverId);
    this.#verification.set(serverId, on);
    if (was === undefined || was === on) return;
    const name = this.#name(serverId);
    this.#d.hub.publish(serverId, on ? { kind: 'verificationOn', severity: 'good', name, by } : { kind: 'verificationOff', severity: 'warning', name, by });
  }

  /**
   * Keeps an Agent's report. A change goes on the stream; a `rolledBack` that changed from one the hub had heard (the
   * Agent sends it on every connect until the next save, and a restarted hub has heard none) is audited as
   * `hub:agent` and announced; so is user verification changed from what the hub knew (a rollback puts back the
   * previous file, password and verification included; or a hand edit), unless a save is under way.
   */
  #onReport(agentId: string, msg: Extract<AgentMsg, { type: 'settings' }>): void {
    const serverId = this.#serverOf.get(agentId);
    if (serverId === undefined) return;
    const { type: _, ...report } = msg;
    const before = this.#reports.get(serverId);
    if (before && JSON.stringify(before) === JSON.stringify(report)) return;
    this.#reports.set(serverId, report);
    if (before && report.rolledBack !== null && report.rolledBack !== before.rolledBack) {
      this.#d.hub.audit('hub:agent', 'game settings rollback', serverId, report.rolledBack);
      this.#d.hub.publish(serverId, { kind: 'settingsRolledBack', severity: 'problem', name: this.#name(serverId) });
    }
    // A save under way announces its own change (the Agent pushes right after its reply, which may be read first).
    if (!this.#saving.has(serverId)) this.#announce(serverId, report.settings?.require_user_verification, null);
    this.#d.hub.publish(serverId, { kind: 'settings', severity: 'info' });
  }

  /** Why a save is refused now; null: it can go. */
  #blocked(serverId: string): string | null {
    const name = this.#name(serverId);
    const agentId = this.#agentOf.get(serverId)!;
    const agent = this.#d.agents.get(agentId);
    if (beforeAgentRelease(agent?.version ?? null, SETTINGS_FLOOR)) {
      const version = /^agent-v/.test(agent!.version!) ? agent!.version : `agent-v${agent!.version}`;
      return `This server's Agent runs ${version}, which can't change game settings. Deploy ${SETTINGS_FLOOR} or later from the Host page (Releases).`;
    }
    if (!agent?.connected) return "The Agent isn't connected.";
    if (!this.#reports.has(serverId)) return `${name}'s Agent hasn't reported its game settings yet.`;
    if (this.#saving.has(serverId)) return `A save of ${name}'s game settings is under way.`;
    const update = this.#d.updating(serverId);
    if (update) return `A ${update} is running on ${name}.`;
    if (this.#d.restoring(serverId)) return `A restore is running on ${name}.`;
    const deploy = this.#d.deploying(agentId);
    if (deploy === 'hub') return 'A hub deploy is running.';
    if (deploy === 'agent') return `${name}'s Agent is being deployed.`;
    if (this.#d.restarts.pending(serverId)) return `A countdown is running on ${name}: cancel it first.`;
    if (MOVING.has(this.#d.services.ofServer(serverId)?.state ?? '')) return 'The server is starting or stopping: try again in a minute.';
    return null;
  }

  /** A server's name; 404 unless an Agent runs it. */
  #name(serverId: string): string {
    if (!this.has(serverId)) throw new GameRefused(404, 'No such server.');
    return this.#d.servers.find((s) => s.id === serverId)?.name ?? serverId;
  }
}

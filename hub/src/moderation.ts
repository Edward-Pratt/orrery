import { AgentRefused, beforeAgentRelease, type Agents } from './agents.ts';
import type { ModerateAnswer, ModerateRequest, ModerationState } from './api.ts';
import type { ServerSettings } from './config.ts';
import { GameRefused } from './factorio.ts';
import { GAME_SETTINGS, LIMITS } from './protocol.ts';
import type { ServerHub } from './servers.ts';
import type { ModerateAction, ModerateOutcome, PlayerLists } from './types.ts';

/** The first Agent release that moderates players (the repo's `agent-v0.0.0` counts as later). */
export const MODERATION_FLOOR = 'agent-v1.4.0';
/** A `playerLists` answer is reused this long, so dashboards asking at once cost one request. */
const LISTS_MS = 2_000;
/** Actions per server per minute. */
const PER_MINUTE = 20;
const ACTIONS: readonly ModerateAction[] = ['kick', 'ban', 'unban', 'promote', 'demote'];
/** What a reason may not hold: C0, DEL, C1, the line and paragraph separators, the bidi controls and the BOM (the Agent's `cleanReason` makes each a space). */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const OUTCOME_WORDS: Record<ModerateOutcome, string> = { done: 'done', already: 'already so', notOnline: 'not online', unconfirmed: 'sent, not confirmed' };

const bad = (why: string) => new GameRefused(400, why);

/** A `POST …/moderation` body, checked field by field (each refusal names the field, never the value). */
export function moderateRequest(body: Record<string, unknown>): ModerateRequest {
  const { action, player, reason } = body;
  if (typeof action !== 'string' || !ACTIONS.includes(action as ModerateAction)) throw bad(`action: one of ${ACTIONS.join(', ')}.`);
  if (typeof player !== 'string' || !GAME_SETTINGS.admin.test(player)) throw bad('player: 1 to 60 letters, digits, "_", "." or "-".');
  if (reason === undefined) return { action: action as ModerateAction, player };
  if (action !== 'kick' && action !== 'ban') throw bad('reason: only a kick or a ban takes one.');
  if (typeof reason !== 'string' || UNSAFE.test(reason) || reason.trim().length > LIMITS.reason) throw bad(`reason: one line of at most ${LIMITS.reason} characters.`);
  return reason.trim() ? { action, player, reason: reason.trim() } : { action, player };
}

export type ModerationDeps = {
  hub: Pick<ServerHub, 'get' | 'audit'>;
  agents: Pick<Agents, 'list' | 'get' | 'request'>;
  servers: Pick<ServerSettings, 'id' | 'name'>[];
};

/**
 * Moderation of the players of the servers an Agent runs (`has`; others 404, `GameRefused`): who is online (the
 * latest heartbeat), their bans and admins (the Agent's `playerLists`, one request per server at a time, reused for
 * 2 s), and kick, ban, unban, promote and demote through the Agent's `moderate`, one at a time per server and 20 a
 * minute, audited as the admin. Hub core.
 */
export class Moderation {
  #d: ModerationDeps;
  #agentOf = new Map<string, string>();
  #lists = new Map<string, { at: number; value: Promise<PlayerLists> }>();
  #acting = new Set<string>();
  #recent = new Map<string, number[]>();

  constructor(deps: ModerationDeps) {
    this.#d = deps;
    for (const a of deps.agents.list()) this.#agentOf.set(a.server, a.id);
  }

  has(serverId: string): boolean {
    return this.#agentOf.has(serverId);
  }

  async state(serverId: string): Promise<ModerationState> {
    this.#name(serverId);
    const online = [...(this.#d.hub.get(serverId)?.players ?? [])];
    const blocked = this.#blocked(serverId);
    const agent = this.#d.agents.get(this.#agentOf.get(serverId)!);
    if (!agent?.connected || this.#tooOld(serverId)) return { online, lists: null, blocked };
    const lists = await this.#playerLists(serverId).catch(() => null);
    return { online, lists, blocked };
  }

  /** One action: 400 bad input, 409 blocked or busy, 429 over the rate, 502 the Agent's refusal or silence. `by` is the audit's actor. */
  async act(serverId: string, body: Record<string, unknown>, by: string): Promise<ModerateAnswer> {
    const name = this.#name(serverId);
    const req = moderateRequest(body);
    const blocked = this.#blocked(serverId);
    if (blocked) throw new GameRefused(409, blocked);
    if (this.#acting.has(serverId)) throw new GameRefused(409, `A moderation request is already running on ${name}.`);
    const now = Date.now();
    const recent = (this.#recent.get(serverId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= PER_MINUTE) throw new GameRefused(429, `At most ${PER_MINUTE} moderation actions a minute on ${name}: wait a little.`);
    this.#recent.set(serverId, [...recent, now]);
    this.#acting.add(serverId);
    const what = `${req.player}${req.reason ? ` (reason: ${req.reason})` : ''}`;
    try {
      const answer = await this.#d.agents.request(this.#agentOf.get(serverId)!, { type: 'moderate', ...req });
      this.#d.hub.audit(by, `player ${req.action}`, serverId, `${what}: ${OUTCOME_WORDS[answer.outcome]}`);
      this.#lists.set(serverId, { at: Date.now(), value: Promise.resolve(answer.lists) });
      return answer;
    } catch (err) {
      const why =
        err instanceof AgentRefused
          ? /unknown type/.test(err.message)
            ? `${name}'s Agent can't moderate players (${err.message}): deploy ${MODERATION_FLOOR} or later.`
            : err.message
          : `${name}'s Agent didn't answer: ${(err as Error).message}`;
      this.#d.hub.audit(by, `player ${req.action}`, serverId, `${what}: failed: ${why}`);
      throw new GameRefused(502, why);
    } finally {
      this.#acting.delete(serverId);
    }
  }

  #playerLists(serverId: string): Promise<PlayerLists> {
    const kept = this.#lists.get(serverId);
    if (kept && Date.now() - kept.at < LISTS_MS) return kept.value;
    const value = this.#d.agents.request(this.#agentOf.get(serverId)!, { type: 'playerLists' });
    this.#lists.set(serverId, { at: Date.now(), value });
    value.catch(() => this.#lists.get(serverId)?.value === value && this.#lists.delete(serverId));
    return value;
  }

  #tooOld(serverId: string): boolean {
    return beforeAgentRelease(this.#d.agents.get(this.#agentOf.get(serverId)!)?.version ?? null, MODERATION_FLOOR);
  }

  /** Why actions are refused now: an Agent too old, one not connected, the server not online (no RCON). */
  #blocked(serverId: string): string | null {
    const agent = this.#d.agents.get(this.#agentOf.get(serverId)!);
    if (this.#tooOld(serverId)) {
      const version = /^agent-v/.test(agent!.version!) ? agent!.version : `agent-v${agent!.version}`;
      return `This server's Agent runs ${version}, which can't moderate players. Deploy ${MODERATION_FLOOR} or later from the Host page (Releases).`;
    }
    if (!agent?.connected) return "The Agent isn't connected.";
    if (!this.#d.hub.get(serverId)?.online) return `${this.#name(serverId)} is stopped: start it to kick, ban, unban or change admins here.`;
    return null;
  }

  /** A server's name; 404 unless an Agent runs it. */
  #name(serverId: string): string {
    if (!this.has(serverId)) throw new GameRefused(404, 'No such server.');
    return this.#d.servers.find((s) => s.id === serverId)?.name ?? serverId;
  }
}

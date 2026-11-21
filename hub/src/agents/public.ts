// What `agents.ts` exports besides the `Agents` class, re-exported from there: `AgentsOptions` (shorter timings,
// `handshakeMs` too, and the line budget, for tests), the typed events (`AgentEvents`), requests (`AgentCall`,
// `AgentAnswer`) and registry rows (`AgentStatus`), `AgentRefused` (its `error`: an `ok: false` reply). `AGENT_FLOOR`
// (`agent-v1.1.0`, the first Agent release with game updates and its own deploys) and `beforeAgentFloor(version)` (a
// hello's `agentVersion` older than it; the repo's `agent-v0.0.0`, the dev loop, is not), for `Deploys` and
// `GameUpdates`; `beforeAgentRelease(version, floor)`, the same against another floor (`GameSettings`'
// `SETTINGS_FLOOR`). Hub core.

import type { AgentMsg, AgentReplyData, AgentRequest } from '../protocol.ts';
import type { Rate } from './budgets.ts';

/** Shorter timings, for tests. */
export type AgentsOptions = {
  /** How long a connection may wait before its first line (5 s). */
  helloTimeoutMs?: number;
  /** How long an Agent connection may go without a line before its Agent is lost (20 s; it pings every 10 s). */
  silenceMs?: number;
  /** How long a request waits for its reply (30 s). */
  requestTimeoutMs?: number;
  /** How often the listener asks for its address again while that isn't on this machine yet (10 s). */
  bindRetryMs?: number;
  /**
   * How soon after its last welcome an Agent connection, or a game connection for the same server, may be welcomed
   * again (`HANDSHAKE_MS`, 5 s); one sooner is refused and the live one stays.
   */
  handshakeMs?: number;
  /**
   * Every connection's line budget (`LINES`: 20 lines a second, in bursts of up to 100): lines over it are dropped, and
   * a connection still over it `overMs` (10 s) on is closed. The per-type budgets (`TYPES`) and the host sample cadence
   * (`SAMPLE_MS`) are not options.
   */
  rate?: Rate;
};

/** What an Agent pushes on its own, put on the `Agents` emitter as it came (a copy of only its schema's fields). */
export type Pushed = Exclude<AgentMsg, { type: 'ping' | 'bye' | 'hostSample' | 'events' | 'reply' }>;

/**
 * `Agents`' events, each with the Agent's id: `agentUp` (its Agent connection was welcomed, every time), `agentLost`
 * (it went silent, or closed without `bye`) and `agentBack` (it connected again after that), and what it pushes.
 */
export type AgentEvents = { agentUp: [agentId: string]; agentLost: [agentId: string]; agentBack: [agentId: string] } & {
  [T in Pushed['type']]: [agentId: string, msg: Extract<Pushed, { type: T }>];
};

/** A request without its id, which `request` adds. */
export type AgentCall = AgentRequest extends infer R ? (R extends AgentRequest ? Omit<R, 'id'> : never) : never;
/** What a request's promise resolves to: its reply's checked `data`, for the requests that answer with data. */
export type AgentAnswer<T extends AgentRequest['type']> = T extends keyof AgentReplyData ? AgentReplyData[T] : void;

/**
 * An Agent as the registry knows it: `version` is what its latest `agentHello` announced, kept after it leaves; `node`
 * its Node as that hello named it (null when it named none: an Agent older than `node`).
 */
export type AgentStatus = { id: string; name: string; server: string; connected: boolean; version: string | null; node: string | null };

/**
 * The first Agent release with game updates and its own deploys (release 2, `docs/ROADMAP.md`): `agent-v1.0.0` has
 * neither, and updates only by the friend re-running `setup-agent-host.sh` at a newer `agent-v` tag.
 */
export const AGENT_FLOOR = 'agent-v1.1.0';

/**
 * Whether an Agent's release (its hello's `agentVersion`, `agent-vX.Y.Z` or a bare version) is older than
 * `AGENT_FLOOR`. `agent-v0.0.0` is the repo's own version (the dev loop, which has both) and is not; nor is anything
 * that isn't a version.
 */
export function beforeAgentFloor(version: string | null): boolean {
  return beforeAgentRelease(version, AGENT_FLOOR);
}

/** Whether an Agent's release is older than `floor` (an `agent-vX.Y.Z` tag), by `beforeAgentFloor`'s rules. */
export function beforeAgentRelease(version: string | null, floor: string): boolean {
  const m = version === null ? null : /^(?:agent-v)?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return false;
  const v = m.slice(1).map(Number);
  if (v.every((n) => n === 0)) return false;
  const f = floor.slice('agent-v'.length).split('.').map(Number);
  return v[0]! - f[0]! < 0 || (v[0] === f[0] && (v[1]! - f[1]! < 0 || (v[1] === f[1] && v[2]! < f[2]!)));
}

/** A request the Agent answered with `ok: false`: it got it and said no (not a timeout or a dropped connection). */
export class AgentRefused extends Error {}

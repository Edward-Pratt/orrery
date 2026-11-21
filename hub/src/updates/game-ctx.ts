// What the game update flows outside the class share with `GameUpdates` (`GameCtx`): its deps and options, its maps
// and sets (by reference: each server's Agent and back, what each server's Agent last reported in `installed`, the
// running jobs, the starts under way, the late ends awaited, the Agents to tell `updateCancel` when they connect, the
// halts) and whether the hub is closing (read and written here, so `stop()` reaches a running update); and the
// lookups they all use: a server's name (`nameOf`, 404 unless an Agent runs it: `has`), an Agent's running job
// (`jobOf`) and why an update can't start now (`blockedReason`, `GameState.blocked`: an update running, its Agent not
// connected or not reported yet (an Agent on a release below `AGENT_FLOOR` never reports: it has no game updates, and
// the reason names the setup re-run), a restore on it, a save of its game settings (`settingsSaving`,
// `GameSettings.busy`), a hub deploy or its Agent's own (until its `deployResult`), a countdown). Hub core.

import { AGENT_FLOOR, beforeAgentFloor } from '../agents/agents.ts';
import type { FactorioMod } from '../types.ts';
import { GameRefused } from './factorio.ts';
import type { Job } from './game-job.ts';
import type { GameUpdatesDeps, GameUpdatesOptions } from './game-updates.ts';

export type Installed = { factorio: string; mods: FactorioMod[] };
/**
 * An update the hub closed before the Agent said how it ended: its later `updateDone` is recorded on the row. `update`
 * null: its id went with the last hub, until the Agent echoes one in a step (it sends its latest on connecting).
 */
export type Late = { row: number; update: string | null; from: string; to: string; started: number };

/** What the game update flows need of `GameUpdates`: see the header. */
export type GameCtx = {
  d: GameUpdatesDeps;
  o: Required<GameUpdatesOptions>;
  // The class's own, by reference: see `GameUpdates`.
  agentOf: Map<string, string>;
  serverOf: Map<string, string>;
  installed: Map<string, Installed>;
  jobs: Map<string, Job>;
  starting: Set<string>;
  late: Map<string, Late>;
  cancelOnConnect: Set<string>;
  halts: Set<() => void>;
  closed: boolean;
};

/** Whether a server has game updates: an Agent runs it. */
export function has(c: GameCtx, serverId: string): boolean {
  return c.agentOf.has(serverId);
}

/** A server's name; 404 unless it has game updates. */
export function nameOf(c: GameCtx, serverId: string): string {
  if (!has(c, serverId)) throw new GameRefused(404, 'No such server.');
  return c.d.servers.find((s) => s.id === serverId)?.name ?? serverId;
}

export function jobOf(c: GameCtx, agentId: string): Job | undefined {
  const serverId = c.serverOf.get(agentId);
  return serverId === undefined ? undefined : c.jobs.get(serverId);
}

/** Why an update can't start on the server now; null: it can. `starting`: the caller's own start is under way. */
export function blockedReason(c: GameCtx, serverId: string, starting = false): string | null {
  const name = nameOf(c, serverId);
  if (c.jobs.has(serverId) || (!starting && c.starting.has(serverId))) return `A game update is running on ${name}.`;
  const agent = c.d.agents.get(c.agentOf.get(serverId)!);
  if (!agent?.connected) return `${name}'s Agent isn't connected.`;
  if (!c.installed.has(serverId)) {
    // A release-1 Agent never says: it has no game updates.
    if (beforeAgentFloor(agent.version)) return `${name}'s Agent runs ${agent.version}, which has no game updates: the friend re-runs setup-agent-host.sh at ${AGENT_FLOOR} or later.`;
    return `${name}'s Agent hasn't said what it runs yet.`;
  }
  if (c.d.restoring(serverId)) return `A restore is running on ${name}.`;
  if (c.d.settingsSaving?.(serverId)) return `A save of ${name}'s game settings is under way.`;
  const deploy = c.d.deploying(c.agentOf.get(serverId)!);
  if (deploy === 'hub') return 'A hub deploy is running.';
  if (deploy === 'agent') return `${name}'s Agent is being deployed.`;
  if (c.d.restarts.pending(serverId)) return `A countdown is running on ${name}: cancel it first.`;
  return null;
}

// An Agent's deploy, for `Deploys`: refused (`DeployRefused`, 409) for an Agent that isn't connected or with a game
// update, a restore, a save of its game settings (`settingsSaving`, `GameSettings.busy`) or a countdown on its server,
// and for an Agent whose hello names a release below `AGENT_FLOOR` (`beforeAgentFloor`: it can't deploy itself; the
// refusal names the setup re-run at the floor, with no row). An Agent deploys itself: its `deploy` request
// (`Agents.request`; the reply means its deploy unit started, and a refusal or no answer is the error, the row
// failed), then ok once its next `agentHello` names the tag; its `deployResult` for the tag records any other end
// (`rolled back`: the old release came back; `failed`; an `ok` while its hello names another release is failed),
// once, also after that hello closed the row ok (its unit gates after the hello): a `rolled back` or `failed` then
// amends the row (`amendDeploy`) and is announced again, an `ok` stores its log, and a repeat (the Agent resends it
// until its write went out) changes nothing; failed after `AGENT_DEPLOY_MS` (20 min, over its unit's
// `TimeoutStartSec=15min`, so the hub never stops waiting while that unit runs) without either. The deploy runs until
// that result, or 20 min after the hello (its unit holds the Agent's deploy lock): every deploy is refused meanwhile,
// naming the Agent and tag, and `agentBusy` stays true. Hub core.

import { beforeAgentFloor } from '../agents/agents.ts';
import type { AgentMsg, DeployOutcome, DeployRow, Release } from '../types.ts';
import { amend, begin, finish, later, type DeployCtx } from './deploy-rows.ts';
import { DeployRefused, FLOOR } from './release-rules.ts';
import { runningRelease } from './running-release.ts';

/**
 * How long the hub waits for an Agent's deploy: for the tag's `agentHello` or its `deployResult` after the `deploy`
 * reply, and for that result after the hello (20 min). Longer than its deploy unit may run (`TimeoutStartSec=15min`
 * in `deploy/orrery-agent-deploy@.service`), so the hub never stops waiting, and lets other work start on the Agent,
 * while the unit still runs.
 */
export const AGENT_DEPLOY_MS = 20 * 60_000;

/**
 * An Agent deploys itself: its `deploy` request starts its own deploy unit (the reply means started), which restarts
 * it. Ok once it says hello again as the tag; its `deployResult` for the tag records any other end (`rolled back`:
 * it came back on the old release; `failed`), also after that hello closed the row ok (the unit's gate failed after
 * it), once; failed when neither comes in time. The Agent is busy until its result, or `agentTimeoutMs` after that
 * hello.
 */
export async function deployAgent(c: DeployCtx, release: Release, agentId: string, from: string | null, by: string): Promise<number> {
  const agents = c.d.agents!; // it found the Agent
  const agent = agents.get(agentId)!;
  const name = c.d.hub.get(agent.server)?.name ?? agent.server;
  if (!agent.connected) throw new DeployRefused(409, `${agent.name} isn't connected.`);
  const updating = c.d.updating(agent.server);
  if (updating) throw new DeployRefused(409, `A ${updating} is running on ${name}: deploy the Agent once it is done.`);
  if (c.d.restoring(agent.server)) throw new DeployRefused(409, `A restore is running on ${name}: deploy the Agent once it is done.`);
  if (c.d.settingsSaving?.(agent.server)) throw new DeployRefused(409, `A save of ${name}'s game settings is under way: deploy the Agent once it is done.`);
  if (c.d.restarts.pending(agent.server)) throw new DeployRefused(409, `A countdown is running on ${name}: cancel it first.`);
  // A release from before the Agent's deploys refuses `deploy`: say what works instead of failing a row.
  if (beforeAgentFloor(from)) {
    throw new DeployRefused(409, `${agent.name} runs ${from}, which can't deploy itself: the friend re-runs setup-agent-host.sh at ${FLOOR.agent} or later.`);
  }
  const { tag } = release;
  let row!: DeployRow;
  let open = true; // the row; its listeners stay on until the result
  let timeout: NodeJS.Timeout | undefined;
  const arm = (fn: () => void) => {
    clearTimeout(timeout);
    if (timeout) c.timers.delete(timeout);
    timeout = later(c, fn, c.agentTimeoutMs);
  };
  const up = (id: string) => {
    if (!open || id !== agentId || runningRelease(c.d, 'agent', agentId) !== tag) return;
    open = false;
    finish(c, row, 'ok', `${agent.name} runs ${tag}`);
    arm(stop); // its unit gates on after this hello: its result may still say otherwise
  };
  const result = (id: string, msg: Extract<AgentMsg, { type: 'deployResult' }>) => {
    if (id !== agentId || msg.tag !== tag) return;
    const running = runningRelease(c.d, 'agent', agentId);
    // Ok only when its hello named the tag, whatever its deploy says.
    const unshown = msg.outcome === 'ok' && running !== tag;
    const outcome = unshown ? 'failed' : msg.outcome;
    const log = unshown ? `${msg.log}\n${agent.name} says ok, but runs ${running ?? 'an unknown release'}` : msg.log;
    if (open) return done(outcome, log);
    stop(); // one result per deploy: a repeat, or an older deploy's, changes nothing
    amend(c, row, outcome, log);
  };
  const off = () => {
    agents.off('agentUp', up);
    agents.off('deployResult', result);
  };
  const stop = () => {
    off();
    c.listeners.delete(off);
    clearTimeout(timeout);
    if (timeout) c.timers.delete(timeout);
    c.agentDeploys.delete(agentId);
  };
  const done = (outcome: Exclude<DeployOutcome, 'running'>, log: string) => {
    if (!open) return;
    open = false;
    stop();
    finish(c, row, outcome, log);
  };
  c.starting = true;
  try {
    row = begin(c, 'agent', agentId, from, tag, by);
    c.agentDeploys.set(agentId, tag);
    agents.on('agentUp', up);
    agents.on('deployResult', result);
    c.listeners.add(off);
    try {
      await agents.request(agentId, { type: 'deploy', tag });
    } catch (err) {
      done('failed', `the Agent didn't start it: ${(err as Error).message}`);
      throw err;
    }
  } finally {
    c.starting = false;
  }
  if (open) arm(() => done('failed', `${agent.name} didn't come back with ${tag} in time`));
  return row.id;
}

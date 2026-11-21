// The Agent deploy tests' shared setup (`test/updates/agent-deploy*.test.ts`): GitHub's releases through a fake reader
// (the deployed tag `TAG`), `gameConfig`'s hub with GitHub on (`deployConfig`), a whole hub with the deploys' routes
// and its deploy notices (`deployHub`), and the Agent's steps: connected as a release (`connected`), taking the deploy
// (`started`), and leaving and coming back as a release (`restarted`).

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import type { DeploysAnswer, LiveEvent, TargetEvent } from '../../src/api.ts';
import type { Config } from '../../src/config.ts';
import type { GitHub, GitHubRelease } from '../../src/updates/deploys.ts';
import type { AgentsOptions } from '../../src/agents/agents.ts';
import { agentUp, eventually, gameConfig, gameHub } from '../fake-agent.ts';

const release = (tag: string, publishedAt: number): GitHubRelease => ({
  tag,
  draft: false,
  prerelease: false,
  publishedAt,
  assets: [`orrery-${tag}.tar.gz`, `orrery-${tag}.tar.gz.sha256`],
});
/**
 * GitHub's releases: Agent ones (two below the floor: agent-v1.0.0, release 1's, has no deploy handler), the Factorio
 * mod's (never deployed here) and a hub one.
 */
const github: GitHub = {
  releases: async () => [
    release('agent-v1.1.0', 2),
    release('agent-v1.2.0', 3),
    release('agent-v1.0.0', 1),
    release('agent-v0.9.0', 1),
    release('factorio-v1.0.0', 3),
    release('hub-v2.7.0', 3),
  ],
  download: async () => assert.fail('an Agent downloads its own release'),
};
export const TAG = 'agent-v1.2.0';

/** `gameConfig`'s hub (Agent `vm` runs the factorio server `space`) with GitHub on. */
export function deployConfig(t: TestContext): Config {
  const cfg = gameConfig(t);
  const root = dirname(cfg.dbPath);
  cfg.integrations.github = {
    repo: 'Edward-Pratt/orrery',
    newerAfterDays: 14,
    deploys: { root, hubUnit: 'orrery-hub.service', hubTemplate: 'orrery-deploy', webTemplate: 'orrery-deploy-web', webDir: join(root, 'www') },
  };
  return cfg;
}

/**
 * A whole hub with the Agent deploys' routes, its deploy notices kept, once it has asked GitHub. `agentTimeoutMs`: how
 * long a deploy waits for the Agent's hello, then for its result.
 */
export async function deployHub(t: TestContext, cfg = deployConfig(t), agentTimeoutMs = 300, agents?: AgentsOptions) {
  const h = await gameHub(t, { cfg, releases: github, deploys: { watchMs: 10, agentTimeoutMs }, ...(agents && { agents }) });
  const notices: TargetEvent[] = [];
  h.live.on('event', (_, { at: _at, ...e }: LiveEvent) => {
    if ('target' in e && e.target === 'deploy') notices.push(e);
  });
  const answer = () => h.json<DeploysAnswer>(h.req('GET', '/api/deploys'));
  await eventually(async () => (await answer()).checkedAt !== null);
  const deploy = (body: object) => h.req('POST', '/api/deploys', body);
  const refused = async (body: object) => {
    const res = await deploy(body);
    return [res.status, await res.text()];
  };
  const rows = async () => (await answer()).history.map(({ part, target, from, to, by, outcome, log }) => ({ part, target, from, to, by, outcome, log }));
  return { ...h, notices, answer, deploy, refused, rows };
}

/** The Agent connected as `version`, as the deploys answer shows it. */
export async function connected(h: Awaited<ReturnType<typeof deployHub>>, o: Parameters<typeof agentUp>[1] = {}) {
  const a = await agentUp(h.agentPort, { unit: 'inactive', ...o });
  await eventually(async () => (await h.answer()).agent.hosts[0]?.running === (o.version ?? 'agent-v1.1.0') && (await h.game()).installed !== null);
  return a;
}

/** Deploys `TAG` onto Agent `vm`, which takes the request: answers 202. */
export async function started(h: Awaited<ReturnType<typeof deployHub>>, a: Awaited<ReturnType<typeof agentUp>>) {
  const res = h.deploy({ part: 'agent', tag: TAG, host: 'vm' });
  const sent = await a.answer();
  assert.deepEqual({ ...sent, id: typeof sent.id }, { type: 'deploy', id: 'string', tag: TAG });
  assert.equal((await res).status, 202);
}

/** The Agent leaves as its deploy restarts it (`bye`), and comes back as `version`. */
export async function restarted(h: Awaited<ReturnType<typeof deployHub>>, a: Awaited<ReturnType<typeof agentUp>>, version: string) {
  a.agent.send({ type: 'bye' });
  await a.agent.closed;
  return connected(h, { version });
}

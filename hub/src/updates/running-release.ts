// What each part runs, for `Deploys` (its `answer()`, and the running tag a deploy refuses): the hub, the name
// `<root>/current` resolves to, else `dev`; the dashboard, the `<webDir>.release` stamp, else the newest ok `web`
// deploy; a Mod, for each minecraft server, `mod-v` + its hello's `modVersion`; an Agent, for each one (`agent.hosts`,
// with its server; none without the agents integration), the `agentVersion` its latest `agentHello` named,
// `agent-vX.Y.Z`, a bare version prefixed. Null: unknown. Hub core.

import { readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DeployPart } from '../types.ts';
import type { DeploysDeps } from './deploys.ts';
import { TAG } from './release-rules.ts';

/** What a part runs (`on`: the Mod's server, or the Agent's id); null: unknown. */
export function runningRelease(d: Pick<DeploysDeps, 'config' | 'db' | 'agents' | 'hub'>, part: DeployPart, on?: string): string | null {
  const { root, webDir } = d.config.deploys;
  if (part === 'hub') {
    try {
      const name = basename(realpathSync(join(root, 'current')));
      if (name.startsWith('hub-v') && TAG.test(name)) return name;
    } catch {}
    return 'dev';
  }
  if (part === 'web') {
    // The stamp first: install-web.sh writes it on every install, a deploy's or one by hand.
    try {
      const stamp = readFileSync(`${webDir}.release`, 'utf8').trim();
      if (stamp.startsWith('web-v') && TAG.test(stamp)) return stamp;
    } catch {}
    return d.db.deploys(1, { part: 'web', outcome: 'ok' })[0]?.to ?? null;
  }
  if (part === 'agent') {
    // Its hello names its release (`agent-vX.Y.Z`); a bare version gets the prefix, as a Mod's does.
    const v = d.agents?.get(on!)?.version ?? null;
    return v !== null && /^\d+\.\d+\.\d+$/.test(v) ? `agent-v${v}` : v;
  }
  const v = d.hub.modVersion(on!);
  if (v === undefined) return null;
  return /^\d+\.\d+\.\d+$/.test(v) ? `mod-v${v}` : v;
}

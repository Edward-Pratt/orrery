// The release rules of `Deploys`: which tags count (`hub-v`/`web-v`/`mod-v`/`agent-v` + three numbers; drafts,
// prereleases and every other tag are left out, the Factorio mod's `factorio-v` too: a game update installs it), their
// order (newest first, by version), the first hub, dashboard and Agent releases that can deploy (`FLOOR`; for an Agent
// `AGENT_FLOOR`, `agent-v1.1.0`: `agent-v1.0.0` has no `deploy` handler), a Mod release's jar names (a renamed
// release's `orrery-<mc>-<version>.jar` builds, one per Minecraft target; 1.7.10 for a server without a pack in the
// library; every `gtnhdiscord-*.jar` and `orrery-*.jar` is a Mod jar) and why a deploy is refused (`DeployRefused`:
// 404/409). Pure. Hub core.

import { AGENT_FLOOR } from '../agents/agents.ts';
import type { Release } from '../types.ts';

/** Why a deploy wasn't started: 404 (no such release or server) or 409 (not now, or not this one). */
export class DeployRefused extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** A release's tag; a Factorio mod's `factorio-v` ones aren't deployed here (a game update installs the mod). */
export const TAG = /^(hub|web|mod|agent)-v(\d+)\.(\d+)\.(\d+)$/;
export const version = (tag: string) => TAG.exec(tag)!.slice(2).map(Number);
/** Newest first, by version. */
export const newestFirst = (a: Release, b: Release) => {
  const [x, y] = [version(a.tag), version(b.tag)];
  return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
};
/**
 * The first hub, dashboard and Agent releases that can deploy: an older one would take the deploy flow away
 * (`agent-v1.0.0` has no `deploy` handler: an Agent on it updates by a setup re-run).
 */
export const FLOOR = { hub: 'hub-v2.6.0', web: 'web-v0.5.0', agent: AGENT_FLOOR } as const;
/** A renamed Mod release's builds, one per Minecraft target: `orrery-<mc>-<version>.jar`. */
export const MOD_BUILD = /^orrery-(.+)-(\d+\.\d+\.\d+)\.jar$/;
/** The Minecraft version of a server without a pack (or whose pack isn't in the library). */
export const MC = '1.7.10';
/** Every Mod jar in `mods/`, from before the rename (`gtnhdiscord-`) and after. */
export const MOD_JAR = /^(gtnhdiscord|orrery)-.*\.jar$/;

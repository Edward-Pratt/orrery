// `Deploys`: GitHub's published releases (through the injected `GitHub`, `github.ts`), asked at start, hourly and on
// `check()`, kept by the release rules (`release-rules.ts`: drafts, prereleases and other tags left out, newest
// first); `answer()` gives each part's running release (`running-release.ts`), latest and list, and the history.
// `deploy(part, tag, by, on?)` (`on`: the Mod's server, or the Agent's id): one at a time (an Agent's until its
// `deployResult`, `deploy-agent.ts`), only a listed tag, refusing (`DeployRefused`: 404/409) an unknown server or
// Agent, the running tag (an Agent's: what its hello named), a hub deploy while a restore runs, the hub, dashboard and
// Agent below `FLOOR`, and a hub deploy while any pack or game update (`updating()`, which names the kind), a library
// add (`Library.busy()`) or a New server install (`Packs.installRunning()`) runs, a Mod deploy while an update runs on
// its server (`answer().packing` lists the servers a pack or game update runs on); a Mod's own refusals and its jar
// swap are `deploy-mod.ts`'s, an Agent's `deploy-agent.ts`'s. The hub (after a database copy) and the dashboard:
// `systemctl start --no-block <template>@<tag>.service` through `Run`, then the unit is watched to its end
// (`deploy-rows.ts`, which also keeps the rows, the audit and the notices). A hub restart closes a
// running Mod or Agent deploy as interrupted, and a later `deployResult` is ignored. `modBuild(mc)`: the newest Mod
// release with an `orrery-<mc>-*.jar` build, and `download(tag, asset)` (a New server's Mod); `busy()`: a hub deploy
// runs (for `Restores`, `Packs` and `GameUpdates`); `modBusy(id)`: a Mod deploy onto a server runs (for `Packs`);
// `agentBusy(id)`: an Agent's deploy runs, until its result (for `GameUpdates` and `Restores`). Hub core.

import { join } from 'node:path';
import type { Agents } from '../agents/agents.ts';
import type { Environment, GithubIntegration, ServerSettings } from '../config.ts';
import type { Db } from '../stats/db.ts';
import type { RestartScheduler } from '../servers/restarts.ts';
import type { ServerHub } from '../servers/servers.ts';
import type { Run } from '../services/services.ts';
import type { DeployPart, Release } from '../types.ts';
import type { DeploysAnswer, PartReleases } from '../api.ts';
import { AGENT_DEPLOY_MS, deployAgent } from './deploy-agent.ts';
import { deployMod } from './deploy-mod.ts';
import { begin, finish, HISTORY, unit, watch, type DeployCtx } from './deploy-rows.ts';
import type { GitHub } from './github.ts';
import { DeployRefused, FLOOR, MOD_BUILD, newestFirst, TAG } from './release-rules.ts';
import { runningRelease } from './running-release.ts';

export { AGENT_DEPLOY_MS } from './deploy-agent.ts';
export { githubReader, type GitHub, type GitHubRelease } from './github.ts';
export { DeployRefused, FLOOR } from './release-rules.ts';

type Hub = Pick<ServerHub, 'get' | 'list' | 'on' | 'off' | 'publishTarget' | 'audit' | 'runCommand' | 'modVersion'>;

export type DeploysDeps = {
  hub: Hub;
  db: Db;
  restarts: RestartScheduler;
  github: GitHub;
  run: Run;
  config: GithubIntegration;
  /** The target of this hub's own and its dashboard's deploys. */
  environment: Environment;
  servers: Pick<ServerSettings, 'id' | 'dir'>[];
  /** Whether a server has a Mod token. */
  hasMod: (serverId: string) => boolean;
  /** Only with the agents integration: each Agent, the version it said it runs, its requests and events. */
  agents?: Pick<Agents, 'get' | 'list' | 'request' | 'on' | 'off'>;
  /** Whether a restore runs on a server (undefined: on any; a hub deploy's restart would kill it). */
  restoring: (serverId?: string) => boolean;
  /** What update runs on a server (undefined: on any): `pack update` or `game update`; null: none. */
  updating: (serverId?: string) => string | null;
  /** Whether a save of a server's game settings is under way (`GameSettings.busy`): its Agent's deploy would cut it short. */
  settingsSaving?: (serverId: string) => boolean;
  /** Whether a library add runs (a hub deploy's restart would lose it). */
  libraryAdding: () => boolean;
  /** Whether a New server install runs (likewise). */
  installing: () => boolean;
  /** The Minecraft version of a server's pack, from its library entry; undefined: none known. */
  mcOf: (serverId: string) => string | undefined;
  /** Where the database copy before a hub deploy goes. */
  dbCopies: string;
};

/** Shortened in tests. */
export type DeploysOptions = { pollMs?: number; watchMs?: number; modTimeoutMs?: number; agentTimeoutMs?: number; countdownMinutes?: number };

/**
 * Releases and deploys: GitHub's published releases (asked hourly and on `check`) against what each part runs, and
 * deploying one, one at a time, recorded in the `deploys` history, audited and announced as `deploy` target notices.
 * The hub and dashboard deploy through their environment's templated units (`<template>@<tag>.service`, only for a
 * tag GitHub listed), whose outcome comes back in `deploy-status.json`; a Mod deploy puts the jar in place itself,
 * at the end of the server's countdown when it runs; an Agent deploys itself (`deploy`), ok once it says hello as
 * the new release. Hub core.
 */
export class Deploys {
  #d: DeploysDeps;
  #c: DeployCtx; // what the deploy flows share with this (`deploy-rows.ts`)
  #pollMs: number;
  #releases: Release[] = [];
  #checkedAt: number | null = null;
  #error: string | null = null;
  #timers = new Set<NodeJS.Timeout>();
  /** Takes each listener of a running Mod or Agent deploy off again. */
  #listeners = new Set<() => void>();
  /**
   * Each Agent whose deploy runs, by its tag: from the row's start until its `deployResult` (or its time is up), so
   * also after its hello closed the row ok, while its deploy unit still gates and may roll back.
   */
  #agentDeploys = new Map<string, string>();

  constructor(
    deps: DeploysDeps,
    { pollMs = 3_600_000, watchMs = 5_000, modTimeoutMs = 10 * 60_000, agentTimeoutMs = AGENT_DEPLOY_MS, countdownMinutes = 5 }: DeploysOptions = {},
  ) {
    this.#d = deps;
    this.#pollMs = pollMs;
    this.#c = {
      d: deps,
      watchMs,
      modTimeoutMs,
      agentTimeoutMs,
      countdownMinutes,
      starting: false,
      timers: this.#timers,
      listeners: this.#listeners,
      agentDeploys: this.#agentDeploys,
    };
  }

  /** Asks GitHub now and every hour, and picks up deploys left running by the hub before this one. */
  start(): void {
    void this.check();
    const poll = setInterval(() => void this.check(), this.#pollMs);
    poll.unref();
    this.#timers.add(poll);
    for (const row of this.#d.db.deploys(HISTORY, { running: true })) {
      // A Mod deploy's countdown, and the wait for an Agent's hello, lived in the hub that started it.
      if (row.part === 'mod' || row.part === 'agent') finish(this.#c, row, 'failed', 'interrupted: the hub restarted');
      else watch(this.#c, row);
    }
  }

  stop(): void {
    for (const t of this.#timers) clearTimeout(t);
    for (const off of this.#listeners) off();
  }

  /** Asks GitHub for its releases now; a failure keeps the last list and is reported in `answer`. */
  async check(): Promise<void> {
    try {
      this.#releases = (await this.#d.github.releases())
        .filter((r) => !r.draft && !r.prerelease && TAG.test(r.tag))
        .map(({ tag, publishedAt, assets }) => ({ tag, publishedAt, assets }))
        .sort(newestFirst);
      this.#error = null;
    } catch (err) {
      this.#error = (err as Error).message;
    }
    this.#checkedAt = Date.now();
  }

  /** Whether a hub deploy runs (a restore must wait for it). */
  busy(): boolean {
    return this.#d.db.deploys(HISTORY, { running: true }).some((r) => r.part === 'hub');
  }

  /** The newest Mod release with a build for a Minecraft version (a New server's Mod): its tag and asset; undefined: none. */
  modBuild(mc: string): { tag: string; asset: string } | undefined {
    for (const r of this.#of('mod')) {
      const asset = r.assets.find((a) => MOD_BUILD.exec(a)?.[1] === mc && !a.includes('/'));
      if (asset) return { tag: r.tag, asset };
    }
    return undefined;
  }

  /** A release asset's bytes. */
  download(tag: string, asset: string): Promise<Uint8Array> {
    return this.#d.github.download(tag, asset);
  }

  /** Whether a Mod deploy onto a server runs (a pack update must wait for it). */
  modBusy(serverId: string): boolean {
    return this.#d.db.deploys(HISTORY, { running: true }).some((r) => r.part === 'mod' && r.target === serverId);
  }

  /** Whether an Agent's deploy runs, until its `deployResult` (a game update or a restore of its server must wait for it). */
  agentBusy(agentId: string): boolean {
    return this.#agentDeploys.has(agentId);
  }

  /** What runs against what is published, and the history newest first, 50 rows older than `before`. */
  answer(before?: number): DeploysAnswer {
    const part = (p: 'hub' | 'web'): PartReleases => {
      const releases = this.#of(p);
      return { running: runningRelease(this.#d, p), latest: releases[0]?.tag ?? null, releases };
    };
    const mod = this.#of('mod');
    const agent = this.#of('agent');
    const history = this.#d.db.deploys(HISTORY + 1, { before });
    return {
      hub: part('hub'),
      web: part('web'),
      mod: {
        latest: mod[0]?.tag ?? null,
        releases: mod,
        // Only a minecraft server runs the Mod.
        servers: this.#d.hub
          .list()
          .filter((s) => s.game === 'minecraft')
          .map((s) => ({ id: s.id, name: s.name, running: runningRelease(this.#d, 'mod', s.id) })),
      },
      agent: {
        latest: agent[0]?.tag ?? null,
        releases: agent,
        hosts: (this.#d.agents?.list() ?? []).map((a) => ({ id: a.id, name: a.name, server: a.server, running: runningRelease(this.#d, 'agent', a.id) })),
      },
      checkedAt: this.#checkedAt,
      error: this.#error,
      newerAfterDays: this.#d.config.newerAfterDays,
      history: history.slice(0, HISTORY),
      older: history.length > HISTORY,
      packing: this.#d.hub.list().flatMap((s) => (this.#d.updating(s.id) ? [s.id] : [])),
    };
  }

  /**
   * Starts deploying a listed release (`on`: the Mod's server, or the Agent's id; `by` to the audit log, `byName` to
   * players) and resolves with its history row's id once it is under way; the outcome comes as a `deployFinished`
   * notice. Rejects with `DeployRefused`, or another error if systemctl, the download or the Agent's `deploy` fails
   * (the row then closes failed).
   */
  async deploy(part: DeployPart, tag: string, by: string, on?: string, byName = by): Promise<number> {
    // The tag goes into a unit name (the Agent's too): only one GitHub listed for this part, which also matches TAG.
    const release = this.#releases.find((r) => r.tag === tag && tag.startsWith(`${part}-v`));
    if (!release) throw new DeployRefused(404, `No published release ${tag}.`);
    const server = part === 'mod' ? this.#d.hub.get(on ?? '') : undefined;
    if (part === 'mod' && !server) throw new DeployRefused(404, 'No such server.');
    const agent = part === 'agent' ? this.#d.agents?.get(on ?? '') : undefined;
    if (part === 'agent' && !agent) throw new DeployRefused(404, 'No such Agent.');
    if (this.#c.starting || this.#d.db.deploys(1, { running: true }).length) throw new DeployRefused(409, 'Another deploy is running.');
    // One at a time still: an Agent's deploy unit runs on after its hello closed the row, holding its deploy lock.
    const [finishing, finishingTag] = [...this.#agentDeploys][0] ?? [];
    if (finishing !== undefined) {
      throw new DeployRefused(409, `${this.#d.agents?.get(finishing)?.name ?? finishing}'s deploy of ${finishingTag} hasn't reported its end yet: deploy once it has.`);
    }
    const from = runningRelease(this.#d, part, on);
    if (from === tag) throw new DeployRefused(409, `${tag} is already running.`);
    if (part === 'hub' && this.#d.restoring()) throw new DeployRefused(409, 'A restore is running: deploy the hub once it is done.');
    const updating = part === 'hub' ? this.#d.updating() : null;
    if (updating) throw new DeployRefused(409, `A ${updating} is running: deploy the hub once it is done.`);
    if (part === 'hub' && this.#d.libraryAdding()) throw new DeployRefused(409, 'A library add is running: deploy the hub once it is done.');
    if (part === 'hub' && this.#d.installing()) throw new DeployRefused(409, 'A New server install is running: deploy the hub once it is done.');
    const onServer = server ? this.#d.updating(server.id) : null;
    if (server && onServer) throw new DeployRefused(409, `A ${onServer} is running on ${server.name}: deploy the Mod once it is done.`);
    if (part !== 'mod' && newestFirst(release, { tag: FLOOR[part], publishedAt: 0, assets: [] }) > 0) {
      throw new DeployRefused(409, `${tag} is older than ${FLOOR[part]}, the first release that can deploy.`);
    }
    if (server) return deployMod(this.#c, release, server.id, server.name, from, by, byName);
    if (agent) return deployAgent(this.#c, release, agent.id, from, by);

    this.#c.starting = true;
    try {
      if (part === 'hub') this.#d.db.copyTo(join(this.#d.dbCopies, `hub-before-${tag}-${Date.now()}.db`));
      const row = begin(this.#c, part, this.#d.environment, from, tag, by);
      try {
        await this.#d.run('systemctl', ['start', '--no-block', '--', unit(this.#c, row)]);
      } catch (err) {
        finish(this.#c, row, 'failed', `systemctl failed: ${(err as Error).message}`);
        throw err;
      }
      // Not at once: systemd may answer `show` before it has dispatched the queued start (still inactive).
      watch(this.#c, row, this.#c.watchMs);
      return row.id;
    } finally {
      this.#c.starting = false;
    }
  }

  #of(part: DeployPart): Release[] {
    return this.#releases.filter((r) => r.tag.startsWith(`${part}-v`));
  }
}

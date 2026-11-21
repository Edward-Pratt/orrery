// `startHub(config, { startFrontend, get, host, run, restore, github, deploys, download, packs, uploadIdleMs, hub,
// agents, portal, nodeIndex, factorioAccount, gameUpdates })` (`deploys`, `packs`, `uploadIdleMs`, `hub`
// (`HubOptions`), `agents` (`AgentsOptions`), `gameUpdates` (`GameUpdatesOptions`): shorter timings for tests;
// `download`: the library's HTTP requests, default `fetch`; `portal`: factorio.com's and the mod portal's, default
// `fetch`; `githubToken`: for Actions artifacts; `nodeIndex`: nodejs.org's request, for the Node check;
// `factorioAccount`: `FACTORIO_USERNAME`/`FACTORIO_TOKEN`, for mod links): wires and starts a whole hub (`get` serves
// the health ping and checks), switching on each integration whose config section is present (Minecraft: `listen`;
// agents: `Agents`, each Agent's Host added to `Hosts`, its port not awaited, and given to `Services`, `Stats` and the
// web API, and with `nodeIndex` the nightly Node check; Discord: `startFrontend`; web: `Roles`, `Users` and the HTTP
// API); its handle has the `LiveFeed`, `Hosts` (the seam for another host's samples) and the Agent port's `agentPort`
// promise, and its `close` stops everything in order (open event streams included). The seam for whole-hub tests. It
// keeps the order of construction, starts and awaits, the checks and `Services`; the parts are built by
// `start-core.ts` (database, `ServerHub` and its listeners, `updating`, `Late`), `start-backups.ts` (`Stats`, Backup
// watchdogs, `Restores`), `start-game.ts` (game updates, mod updates, moderation, game settings, save uploads),
// `start-deploys.ts` (`Deploys`) and `start-packs.ts` (uploads, library, packs). Nothing from `agents.start()` to
// `startFrontend` awaits, so `GameUpdates` and `GameSettings` listen before any Agent can connect.

import { dirname, join } from 'node:path';
import { Agents, type AgentsOptions } from './agents/agents.ts';
import { Checks } from './services/checks.ts';
import type { DeploysOptions, GitHub } from './updates/deploys.ts';
import type { FactorioAccount, PortalFetch } from './updates/factorio.ts';
import type { ModUpdatesOptions } from './updates/mod-updates.ts';
import type { GameUpdatesOptions } from './updates/game-updates.ts';
import { Hosts, type HostReaders } from './agents/host.ts';
import { startNodeCheck, type NodeFetch } from './agents/node-check.ts';
import type { Fetch } from './packs/library.ts';
import type { PacksOptions } from './packs/packs.ts';
import type { RunRestore } from './backups/restore.ts';
import { Services, type Run } from './services/services.ts';
import type { Config, DiscordConfig } from './config.ts';
import { everyDay } from './daily.ts';
import { startPinger, type Get } from './services/health.ts';
import type { Links } from './servers/links.ts';
import type { LiveFeed } from './stats/live.ts';
import type { RestartScheduler } from './servers/restarts.ts';
import type { ServerHub, HubOptions } from './servers/servers.ts';
import type { Stats } from './stats/stats.ts';
import { scheduleSummaries } from './stats/summary.ts';
import { Roles } from './users/roles.ts';
import { Users } from './users/users.ts';
import { serveWebApi, webApi, type WebApi } from './web/web.ts';
import { buildCore, type Late } from './start-core.ts';
import { buildRestores, watchBackups } from './start-backups.ts';
import { buildSaveUploads, startGame } from './start-game.ts';
import { startDeploys } from './start-deploys.ts';
import { buildPacks } from './start-packs.ts';

/** What the hub needs from a frontend once it is running. */
export type Frontend = { stop: () => void };

/** The outside world the hub touches, passed in so tests need no network. */
export type HubDeps = {
  startFrontend: (
    hub: ServerHub,
    stats: Stats,
    restarts: RestartScheduler,
    links: Links,
    cfg: DiscordConfig,
  ) => Promise<Frontend>;
  /** The HTTP GET of the health ping and of checks. */
  get: Get;
  /** Readers of this machine's CPU, memory and disks; needed only with the host integration. */
  host?: HostReaders;
  /** Runs systemctl and journalctl; needed only with the systemd integration. */
  run?: Run;
  /** Runs the restore script; without it (or systemd) the dashboard can't restore a server folder's backups. */
  restore?: RunRestore;
  /** GitHub's releases; needed only with the GitHub integration (which also needs `run`). */
  github?: GitHub;
  /** Shorter deploy timings, for tests. */
  deploys?: DeploysOptions;
  /** The library's download requests (default: `fetch`); redirects, the token and resuming are the hub's. */
  download?: Fetch;
  /** `GITHUB_TOKEN`, for Actions artifacts in the library: sent only to api.github.com. */
  githubToken?: string;
  /** Shorter pack update timings, for tests. */
  packs?: PacksOptions;
  /** factorio.com's and the mod portal's requests, for game updates (default: `fetch`). */
  portal?: PortalFetch;
  /** nodejs.org's request, for the nightly check of each Agent's Node; without it (tests), no check runs. */
  nodeIndex?: NodeFetch;
  /**
   * `FACTORIO_USERNAME` and `FACTORIO_TOKEN`: the mods' download links are asked with them, of mods.factorio.com only.
   * Without them a game update is refused at that step (each has mods: `orrery` at least); everything else works.
   */
  factorioAccount?: FactorioAccount;
  /** Shorter game update timings, for tests. */
  gameUpdates?: GameUpdatesOptions;
  /** The portal mod update check's timings and clock, for tests. */
  modUpdates?: ModUpdatesOptions;
  /** How long an upload is kept after its last chunk (default an hour), for tests. */
  uploadIdleMs?: number;
  /** Shorter liveness timings of the game connections, for tests. */
  hub?: Omit<HubOptions, 'audit'>;
  /** Shorter Agent port timings, for tests. */
  agents?: AgentsOptions;
};

export type HubHandle = {
  /** The mod port; undefined when the Minecraft integration is off. */
  port: number | undefined;
  /**
   * The Agent port once it listens (it may wait for its address: the hub doesn't); undefined when the agents
   * integration is off.
   */
  agentPort?: Promise<number>;
  /** The HTTP API, its port and its `Users` (tests make their first owner with it); undefined when the web integration is off. */
  web?: { port: number; app: WebApi; users: Users };
  /** Every hub event, numbered, with recent ones buffered for replay. */
  live: LiveFeed;
  /** Every Host the hub knows: the hub's own with the host integration, and any other added to it. */
  hosts: Hosts;
  /** Stops everything in order; resolves once the socket and database are closed. */
  close: () => Promise<void>;
};

/** Wires and starts a whole hub from a config. */
export async function startHub(config: Config, deps: HubDeps): Promise<HubHandle> {
  const { minecraft, discord, web, checks: checkList, host: hostCfg, systemd, github, agents: agentsCfg } = config.integrations;
  if (hostCfg && !deps.host) throw new Error('integrations.host needs host readers');
  if (systemd && !deps.run) throw new Error('integrations.systemd needs a systemctl runner');
  if (github && !(deps.github && deps.run)) throw new Error('integrations.github needs a GitHub reader and a systemctl runner');
  const late: Late = {};
  const { db, touch, hub, live, updating, restarts, playtime, lag, quests, links } = buildCore(config, deps, late);

  const port = minecraft ? await hub.listen(minecraft.listenPort) : undefined;
  console.log(port === undefined ? '[hub] Minecraft integration off: no mod port' : `[hub] listening on 127.0.0.1:${port}`);
  hub.start(); // hung detection and the grace period, for Agents' game connections too
  playtime.start();
  lag.start();
  quests.start();

  const checks = checkList && new Checks(hub, checkList, deps.get);
  checks?.start();
  const hosts = new Hosts(hub, db);
  const host = hostCfg && hosts.add(hostCfg);
  host?.start(deps.host!); // checked above
  // Each Agent's Host: sampled by the Agent, with its own limits.
  for (const a of agentsCfg?.agents ?? []) hosts.add({ id: a.id, mounts: [], ...a.host });
  const agents = agentsCfg && new Agents(hub, hosts, agentsCfg, deps.agents);
  const agentPort = agents?.start();
  agentPort?.then(
    (p) => console.log(`[hub] Agent port on ${agentsCfg!.listen.host}:${p}`),
    (err) => console.error('[hub] Agent port failed, no Agent can connect:', err),
  );
  const stopNodeCheck = agents && deps.nodeIndex ? startNodeCheck({ agents, hub, fetch: deps.nodeIndex }) : () => {};
  const agentOf = new Map((agentsCfg?.agents ?? []).map((a) => [a.server, a.id]));
  const { stats, backups } = watchBackups(config, hub, db, agents, agentOf);
  const services = systemd && new Services(hub, restarts, systemd, config.servers, checkList ?? [], deps.run!, agents); // checked above
  late.services = services;
  services?.start();
  const restores = buildRestores(config, deps, { hub, services, agents, agentOf, stats, updating, late });
  const { gameUpdates, modUpdates, moderation, gameSettings } = startGame(config, deps, { hub, db, agents, services, restarts, restores, updating, late });
  const dbCopies = join(dirname(config.dbPath), 'db-backups');
  const deploys = startDeploys(config, deps, { hub, db, restarts, agents, restores, updating, gameSettings, dbCopies, late });
  const { uploads, library, packs } = buildPacks(config, deps, { hub, db, services, restarts, restores, deploys, agents, port, late });
  const saveUploads = buildSaveUploads({ hub, agents, uploads, agentOf, updating, gameSettings, restores, deploys });
  const frontend = discord ? await deps.startFrontend(hub, stats, restarts, links, discord) : undefined;
  const stopPing = config.healthcheckUrl ? startPinger(config.healthcheckUrl, 60_000, deps.get) : () => {};
  const stopSummaries = scheduleSummaries(hub, stats, config.servers); // throws on a bad time
  const DB_UPKEEP_TIME = '04:00'; // local; before the usual 06:00 daily restart
  const upkeep = everyDay(DB_UPKEEP_TIME, 0, (target) => db.maintain(dbCopies, target));
  await uploads?.start();
  await library?.start();
  await packs?.start(); // after the frontend: it hears every notice from the start
  const roles = web && new Roles(db.users, (entry) => db.audit(entry));
  const users = roles && new Users(db.users, roles, (entry) => db.audit(entry), { knownServer: (id) => config.servers.some((s) => s.id === id) });
  const app = web && roles && users && webApi(web, { db, users, roles, live, hub, stats, restarts, lag, checks, hosts: hostCfg || agentsCfg ? hosts : undefined, agents, services, restores, deploys, packs, gameUpdates, modUpdates, moderation, gameSettings, saveUploads, uploads, library, integrations: config.integrations });
  const http = app && web ? await serveWebApi(app, web.listenPort) : undefined;
  if (http) console.log(`[hub] web API on 127.0.0.1:${http.port}`);

  return {
    port,
    agentPort,
    live,
    hosts,
    web: app && http && users && { port: http.port, app, users },
    close: () => {
      restarts.stop();
      backups.stop();
      playtime.stop();
      lag.stop();
      quests.flush(); // don't lose a pending roll-up
      quests.stop();
      checks?.stop();
      host?.stop();
      services?.stop();
      deploys?.stop();
      packs?.stop();
      gameUpdates?.stop();
      modUpdates?.stop();
      library?.stop();
      uploads?.stop();
      stopSummaries();
      upkeep();
      stopNodeCheck();
      stopPing();
      frontend?.stop();
      return Promise.all([hub.close(), agents?.close(), http?.close()]).then(() => {}).finally(() => {
        clearInterval(touch);
        db.close();
      });
    },
  };
}

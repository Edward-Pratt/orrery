import { dirname, join } from 'node:path';
import { Agents, type AgentsOptions } from './agents.ts';
import { BackupWatcher } from './backups.ts';
import { Checks } from './checks.ts';
import { Deploys, type DeploysOptions, type GitHub } from './deploys.ts';
import { FactorioCatalog, type FactorioAccount, type PortalFetch } from './factorio.ts';
import { GameUpdates, type GameUpdatesOptions } from './game-updates.ts';
import { Hosts, type HostReaders } from './host.ts';
import { Library, type Fetch } from './library.ts';
import { Packs, type PacksOptions } from './packs.ts';
import { agentRestore, folderRestore, Restores, type RestoreSource, type RunRestore } from './restore.ts';
import { Services, type Run } from './services.ts';
import type { Config, DiscordConfig } from './config.ts';
import { everyDay } from './daily.ts';
import { Db } from './db.ts';
import { startPinger, type Get } from './health.ts';
import { LagMonitor } from './lag.ts';
import { Links } from './links.ts';
import { LiveFeed } from './live.ts';
import { PlaytimeTracker } from './playtime.ts';
import { QuestAnnouncer } from './quests.ts';
import { RestartScheduler } from './restarts.ts';
import { ServerHub, type HubOptions } from './servers.ts';
import { Stats } from './stats.ts';
import { scheduleSummaries } from './summary.ts';
import { Uploads } from './uploads.ts';
import { serveWebApi, webApi, type OAuth, type WebApi } from './web.ts';

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
  /** Discord OAuth for dashboard logins; needed only with the web integration. */
  oauth?: OAuth;
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
  /**
   * `FACTORIO_USERNAME` and `FACTORIO_TOKEN`: the mods' download links are asked with them, of mods.factorio.com only.
   * Without them a game update with mods is refused at that step; everything else works.
   */
  factorioAccount?: FactorioAccount;
  /** Shorter game update timings, for tests. */
  gameUpdates?: GameUpdatesOptions;
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
  /** The HTTP API and its port; undefined when the web integration is off. */
  web?: { port: number; app: WebApi };
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
  if (web && !deps.oauth) throw new Error('integrations.web needs Discord OAuth');
  if (hostCfg && !deps.host) throw new Error('integrations.host needs host readers');
  if (systemd && !deps.run) throw new Error('integrations.systemd needs a systemctl runner');
  if (github && !(deps.github && deps.run)) throw new Error('integrations.github needs a GitHub reader and a systemctl runner');
  const db = new Db(config.dbPath);
  db.markHubRestart(config.servers.map((s) => s.id)); // also ends sessions left open when the hub last stopped
  const touch = setInterval(() => db.touch(), 60_000);

  const hub = new ServerHub(
    config.servers.map((s) => ({ id: s.id, name: s.name, game: s.game, token: minecraft?.tokens[s.id] })),
    { ...deps.hub, audit: (entry) => db.audit(entry) },
  );
  hub.on('event', (e) => db.recordLifecycle(e.serverId, e.type));
  const live = new LiveFeed(hub, db);

  let deploys: Deploys | undefined;
  let packs: Packs | undefined;
  let gameUpdates: GameUpdates | undefined;
  let library: Library | undefined;
  let services: Services | undefined;
  // The one check of an update running (on a server, or any): what kind, for each refusal's words.
  const updating = (id?: string) => (packs?.busy(id) ? 'pack update' : gameUpdates?.busy(id) ? 'game update' : null);
  const serviceOf = new Map(config.servers.flatMap((s) => (s.service ? [[s.id, s.service]] : [])));
  const restarts = new RestartScheduler(hub, {
    // A daily countdown during an update would clash with its stop; the update restarts the server anyway.
    paused: (id) => {
      const what = updating(id);
      return what && `a ${what} is running`;
    },
    // A factorio server's countdown ends in its service's restart (config gives it one, and systemd), looked up late:
    // Services is built after RestartScheduler, which it counts down with.
    restart: async (id, by) => {
      const service = serviceOf.get(id);
      if (!services || service === undefined) throw new Error(`${id} has no service to restart`);
      await services.now(service, 'restart', by);
    },
  });
  for (const s of config.servers) if (s.dailyRestart) restarts.daily(s.id, s.dailyRestart); // throws on a bad time
  const playtime = new PlaytimeTracker(hub, db);
  const lag = new LagMonitor(hub, db, Object.fromEntries(config.servers.map((s) => [s.id, s.lag])));
  const quests = new QuestAnnouncer(hub, Object.fromEntries(config.servers.map((s) => [s.id, s.quests])));
  const links = new Links(db, hub);
  hub.on('event', (e) => {
    if (e.type === 'quest') quests.add(e.serverId, e.player, e.quests);
  });

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
  const agentOf = new Map((agentsCfg?.agents ?? []).map((a) => [a.server, a.id]));
  // Before anything that reads Backups: each server's Backup source (its folder, or its Agent's saves) is Stats'.
  const stats = new Stats(hub, db, config.servers, agents);
  const backups = new BackupWatcher(
    hub,
    (serverId) => stats.backupSource(serverId)?.list() ?? Promise.resolve([]),
    (serverId) => stats.backupSource(serverId)?.free() ?? Promise.resolve(null),
  );
  for (const s of config.servers) {
    if (!stats.backupSource(s.id)) continue;
    // An Agent saves only after play, so its saves are overdue only once someone has played since the newest.
    const played = agentOf.has(s.id) ? (since: number) => db.sessionsSince(s.id, since).length > 0 : undefined;
    backups.watchdog(s.id, { maxAgeHours: s.backupMaxAgeHours, minFreeGB: s.backupMinFreeGB, played });
  }
  services = systemd && new Services(hub, restarts, systemd, config.servers, checkList ?? [], deps.run!, agents); // checked above
  services?.start();
  // A restore source per server: its Agent's restore, or its folder's script.
  const restoreSources = new Map<string, RestoreSource>();
  for (const s of config.servers) {
    const agentId = agentOf.get(s.id);
    if (agents && agentId !== undefined) restoreSources.set(s.id, agentRestore(agents, agentId, stats.backupSource(s.id)!.list));
    else if (deps.restore && s.dir && s.backupDir) restoreSources.set(s.id, folderRestore(deps.restore, s.dir, s.backupDir));
  }
  const restores =
    services && restoreSources.size
      ? new Restores(hub, services, restoreSources, {
          deploying: () => deploys?.busy() ?? false,
          updating,
          restored: (id) => packs?.restored(id),
        })
      : undefined;
  // Game updates, with an Agent's server: started (its interrupted rows closed, the Agents heard) before any can connect.
  gameUpdates =
    agents &&
    services &&
    new GameUpdates(
      {
        hub,
        db,
        agents,
        services,
        restarts,
        catalog: new FactorioCatalog(deps.portal ?? fetch, deps.factorioAccount),
        servers: config.servers,
        restoring: (id) => restores?.busy(id) ?? false,
        deploying: (agentId) => (deploys?.busy() ? 'hub' : deploys?.agentBusy(agentId) ? 'agent' : null),
      },
      deps.gameUpdates,
    );
  gameUpdates?.start();
  const dbCopies = join(dirname(config.dbPath), 'db-backups');
  deploys =
    github &&
    new Deploys(
      {
        hub,
        db,
        restarts,
        github: deps.github!, // checked above
        run: deps.run!,
        config: github,
        environment: config.environment,
        servers: config.servers,
        hasMod: (id) => Boolean(minecraft?.tokens[id]),
        agents,
        restoring: (id) => restores?.busy(id) ?? false,
        updating,
        libraryAdding: () => library?.busy() ?? false,
        installing: () => packs?.installRunning() ?? false,
        mcOf: (id) => {
          const libraryId = db.pack(id)?.libraryId;
          return libraryId ? db.library().find((e) => e.id === libraryId)?.mc : undefined;
        },
        dbCopies,
      },
      deps.deploys,
    );
  deploys?.start();
  // Packs need the server's service (systemd) and its Mod (Minecraft): which servers have both, `Packs.has` says.
  const uploads = services && minecraft ? new Uploads(join(dirname(config.dbPath), 'uploads'), deps.uploadIdleMs) : undefined;
  // The library takes uploads and is one per Environment: on whenever packs are.
  library =
    uploads &&
    new Library({
      hub,
      db,
      uploads,
      root: dirname(config.dbPath),
      download: deps.download ?? fetch,
      githubToken: deps.githubToken,
      installing: (id) => packs?.installing(id) ?? [],
      installRunning: () => packs?.installRunning() ?? false,
    });
  packs =
    services &&
    minecraft &&
    uploads &&
    new Packs(
      {
        hub,
        db,
        services,
        restarts,
        servers: config.servers,
        hasMod: (id) => Boolean(minecraft.tokens[id]),
        uploads,
        library: library!, // on whenever uploads are
        dataDir: dirname(config.dbPath),
        restoring: (id) => restores?.busy(id) ?? false,
        deploying: (id) => (deploys?.busy() ? 'hub' : deploys?.modBusy(id) ? 'mod' : null),
        // New server: the Mod comes from GitHub's releases, and the setup command names the hub's unit.
        install: deploys && {
          mods: deploys,
          hubUnit: github!.deploys.hubUnit,
          hubPort: port!, // Minecraft is on with packs
          unitExists: async (unit) => /^LoadState=(?!not-found$)\S+$/m.test(await deps.run!('systemctl', ['show', '--property=LoadState', '--', unit])),
        },
      },
      deps.packs,
    );

  const frontend = discord ? await deps.startFrontend(hub, stats, restarts, links, discord) : undefined;
  const stopPing = config.healthcheckUrl ? startPinger(config.healthcheckUrl, 60_000, deps.get) : () => {};
  const stopSummaries = scheduleSummaries(hub, stats, config.servers); // throws on a bad time
  const DB_UPKEEP_TIME = '04:00'; // local; before the usual 06:00 daily restart
  const upkeep = everyDay(DB_UPKEEP_TIME, 0, (target) => db.maintain(dbCopies, target));
  await uploads?.start();
  await library?.start();
  await packs?.start(); // after the frontend: it hears every notice from the start
  const app =
    web && deps.oauth
      ? webApi(web, deps.oauth, { db, live, hub, stats, restarts, lag, checks, hosts: hostCfg || agentsCfg ? hosts : undefined, services, restores, deploys, packs, gameUpdates, uploads, library, integrations: config.integrations, environment: config.environment })
      : undefined;
  const http = app && web ? await serveWebApi(app, web.listenPort) : undefined;
  if (http) console.log(`[hub] web API on 127.0.0.1:${http.port}`);

  return {
    port,
    agentPort,
    live,
    hosts,
    web: app && http && { port: http.port, app },
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
      library?.stop();
      uploads?.stop();
      stopSummaries();
      upkeep();
      stopPing();
      frontend?.stop();
      return Promise.all([hub.close(), agents?.close(), http?.close()]).then(() => {}).finally(() => {
        clearInterval(touch);
        db.close();
      });
    },
  };
}

import { dirname, join } from 'node:path';
import { BackupWatcher, freeBytes, listBackups } from './backups.ts';
import { Checks } from './checks.ts';
import { Deploys, type DeploysOptions, type GitHub } from './deploys.ts';
import { HostMonitor, type HostReaders } from './host.ts';
import { Library, type Fetch } from './library.ts';
import { Packs, type PacksOptions } from './packs.ts';
import { Restores, type RunRestore } from './restore.ts';
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
import { ServerHub } from './servers.ts';
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
  /** Runs the restore script; without it (or systemd) the dashboard can't restore backups. */
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
  /** How long an upload is kept after its last chunk (default an hour), for tests. */
  uploadIdleMs?: number;
};

export type HubHandle = {
  /** The mod port; undefined when the Minecraft integration is off. */
  port: number | undefined;
  /** The HTTP API and its port; undefined when the web integration is off. */
  web?: { port: number; app: WebApi };
  /** Every hub event, numbered, with recent ones buffered for replay. */
  live: LiveFeed;
  /** Stops everything in order; resolves once the socket and database are closed. */
  close: () => Promise<void>;
};

/** Wires and starts a whole hub from a config. */
export async function startHub(config: Config, deps: HubDeps): Promise<HubHandle> {
  const { minecraft, discord, web, checks: checkList, host: hostCfg, systemd, github } = config.integrations;
  if (web && !deps.oauth) throw new Error('integrations.web needs Discord OAuth');
  if (hostCfg && !deps.host) throw new Error('integrations.host needs host readers');
  if (systemd && !deps.run) throw new Error('integrations.systemd needs a systemctl runner');
  if (github && !(deps.github && deps.run)) throw new Error('integrations.github needs a GitHub reader and a systemctl runner');
  const backupDirs: Record<string, string> = Object.fromEntries(
    config.servers.flatMap((s) => (s.backupDir ? [[s.id, s.backupDir]] : [])),
  );

  const db = new Db(config.dbPath);
  db.markHubRestart(config.servers.map((s) => s.id)); // also ends sessions left open when the hub last stopped
  const touch = setInterval(() => db.touch(), 60_000);

  const hub = new ServerHub(
    config.servers.map((s) => ({ id: s.id, name: s.name, token: minecraft?.tokens[s.id] })),
    { audit: (entry) => db.audit(entry) },
  );
  hub.on('event', (e) => db.recordLifecycle(e.serverId, e.type));
  const live = new LiveFeed(hub);

  let deploys: Deploys | undefined;
  let packs: Packs | undefined;
  let library: Library | undefined;
  // A daily countdown during a pack update would clash with its Stop; the update restarts the server anyway.
  const restarts = new RestartScheduler(hub, { paused: (id) => (packs?.busy(id) ? 'a pack update is running' : null) });
  for (const s of config.servers) if (s.dailyRestart) restarts.daily(s.id, s.dailyRestart); // throws on a bad time
  const backups = new BackupWatcher(
    hub,
    (serverId) => listBackups(backupDirs[serverId] ?? ''),
    (serverId) => freeBytes(backupDirs[serverId] ?? ''),
  );
  for (const s of config.servers) {
    if (s.backupDir) {
      backups.watchdog(s.id, { maxAgeHours: s.backupMaxAgeHours, minFreeGB: s.backupMinFreeGB });
    }
  }
  const playtime = new PlaytimeTracker(hub, db);
  const lag = new LagMonitor(hub, db, Object.fromEntries(config.servers.map((s) => [s.id, s.lag])));
  const quests = new QuestAnnouncer(hub, Object.fromEntries(config.servers.map((s) => [s.id, s.quests])));
  const links = new Links(db, hub);
  hub.on('event', (e) => {
    if (e.type === 'quest') quests.add(e.serverId, e.player, e.quests);
  });

  const port = minecraft ? await hub.listen(minecraft.listenPort) : undefined;
  console.log(port === undefined ? '[hub] Minecraft integration off: no mod port' : `[hub] listening on 127.0.0.1:${port}`);
  playtime.start();
  lag.start();
  quests.start();

  const checks = checkList && new Checks(hub, checkList, deps.get);
  checks?.start();
  const host = hostCfg && new HostMonitor(hub, db, hostCfg, deps.host!); // checked above
  host?.start();
  const services = systemd && new Services(hub, restarts, systemd, config.servers, checkList ?? [], deps.run!); // checked above
  services?.start();
  const restores =
    services &&
    deps.restore &&
    new Restores(hub, services, config.servers, deps.restore, {
      deploying: () => deploys?.busy() ?? false,
      packing: (id) => packs?.busy(id) ?? false,
      restored: (id) => packs?.restored(id),
    });
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
        restoring: () => restores?.busy() ?? false,
        packing: (id) => packs?.busy(id) ?? false,
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

  const stats = new Stats(hub, db, config.servers);
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
      ? webApi(web, deps.oauth, { db, live, hub, stats, restarts, lag, checks, host, services, restores, deploys, packs, uploads, library, integrations: config.integrations, environment: config.environment })
      : undefined;
  const http = app && web ? await serveWebApi(app, web.listenPort) : undefined;
  if (http) console.log(`[hub] web API on 127.0.0.1:${http.port}`);

  return {
    port,
    live,
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
      library?.stop();
      uploads?.stop();
      stopSummaries();
      upkeep();
      stopPing();
      frontend?.stop();
      return Promise.all([hub.close(), http?.close()]).then(() => {}).finally(() => {
        clearInterval(touch);
        db.close();
      });
    },
  };
}

import { dirname, join } from 'node:path';
import { BackupWatcher, freeBytes, listBackups } from './backups.ts';
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
  /** The health ping's HTTP GET. */
  get: Get;
  /** Discord OAuth for dashboard logins; needed only with the web integration. */
  oauth?: OAuth;
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
  const { minecraft, discord, web } = config.integrations;
  if (web && !deps.oauth) throw new Error('integrations.web needs Discord OAuth');
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

  const restarts = new RestartScheduler(hub);
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

  const stats = new Stats(hub, db, config.servers);
  const frontend = discord ? await deps.startFrontend(hub, stats, restarts, links, discord) : undefined;
  const stopPing = config.healthcheckUrl ? startPinger(config.healthcheckUrl, 60_000, deps.get) : () => {};
  const stopSummaries = scheduleSummaries(hub, stats, config.servers); // throws on a bad time
  const DB_UPKEEP_TIME = '04:00'; // local; before the usual 06:00 daily restart
  const dbCopies = join(dirname(config.dbPath), 'db-backups');
  const upkeep = everyDay(DB_UPKEEP_TIME, 0, (target) => db.maintain(dbCopies, target));
  const app = web && deps.oauth ? webApi(db, web, deps.oauth, live) : undefined;
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

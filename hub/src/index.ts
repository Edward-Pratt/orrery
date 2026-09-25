import { dirname, join } from 'node:path';
import { backupNotice, backupStats, BackupWatcher, freeBytes, listBackups } from './backups.ts';
import { loadConfig } from './config.ts';
import { everyDay } from './daily.ts';
import { Db } from './db.ts';
import { startDiscord } from './discord.ts';
import { startPinger } from './health.ts';
import { LagMonitor } from './lag.ts';
import { Links } from './links.ts';
import { PlaytimeTracker } from './playtime.ts';
import { QuestAnnouncer, type QuestBatch } from './quests.ts';
import { RestartScheduler } from './restarts.ts';
import { ServerHub } from './servers.ts';
import { Stats } from './stats.ts';
import { buildSummary } from './summary.ts';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is not set');
const config = loadConfig(process.argv[2] ?? 'config.json');
const backupDirs: Record<string, string> = Object.fromEntries(
  config.servers.flatMap((s) => (s.backupDir ? [[s.id, s.backupDir]] : [])),
);

const db = new Db(config.dbPath);
db.markHubRestart(config.servers.map((s) => s.id)); // also ends sessions left open when the hub last stopped
setInterval(() => db.touch(), 60_000);

const hub = new ServerHub(config.servers);
hub.on('event', (e) => db.recordLifecycle(e.serverId, e.type));

// Hub-core output goes to Discord, which is connected below; until then it goes nowhere.
let notice: (serverId: string, text: string) => void = () => {};
let postQuests: (batch: QuestBatch) => void = () => {};
let postLinked: (serverId: string, player: string, discordId: string) => void = () => {};
const notify = (serverId: string, text: string) => notice(serverId, text);
const restarts = new RestartScheduler(hub, notify);
for (const s of config.servers) if (s.dailyRestart) restarts.daily(s.id, s.dailyRestart); // throws on a bad time
const backups = new BackupWatcher(
  (serverId) => listBackups(backupDirs[serverId] ?? ''),
  (serverId) => freeBytes(backupDirs[serverId] ?? ''),
  notify,
);
for (const s of config.servers) {
  if (s.backupDir) {
    backups.watchdog(s.id, { maxAgeHours: s.backupMaxAgeHours, minFreeGB: s.backupMinFreeGB });
  }
}
const playtime = new PlaytimeTracker(hub, db);
const lag = new LagMonitor(hub, db, Object.fromEntries(config.servers.map((s) => [s.id, s.lag])), notify);
const quests = new QuestAnnouncer(
  Object.fromEntries(config.servers.map((s) => [s.id, s.quests])),
  (batch) => postQuests(batch),
);
const links = new Links(db, hub, (serverId, player, discordId) => postLinked(serverId, player, discordId));
hub.on('event', (e) => {
  if (e.type === 'quest') quests.add(e.serverId, e.player, e.quests);
  else if (e.type === 'backup') notify(e.serverId, backupNotice(e.ok, e.detail));
});

const port = await hub.listen(config.listenPort);
console.log(`[hub] listening on 127.0.0.1:${port}`);
playtime.start();
lag.start();
quests.start();

const discord = await startDiscord(
  hub,
  db,
  new Stats(hub, db),
  restarts,
  links,
  {
    guildId: config.guildId,
    adminRoleId: config.adminRoleId,
    channels: Object.fromEntries(config.servers.map((s) => [s.id, s.channelId])),
    dirs: Object.fromEntries(config.servers.flatMap((s) => (s.dir ? [[s.id, s.dir]] : []))),
    backupDirs,
  },
  token,
);
notice = discord.notice;
postQuests = discord.quests;
postLinked = discord.linked;
const stopPing = config.healthcheckUrl ? startPinger(config.healthcheckUrl, discord.connected) : () => {};
const summaries = config.servers.flatMap((s) =>
  s.dailySummary
    ? [
        everyDay(s.dailySummary, 0, (target) => {
          const summary = buildSummary(db, s.id, target);
          const dir = s.backupDir;
          void (dir ? backupStats(dir) : Promise.resolve(null)).then((backups) =>
            discord.summary(s.id, { ...summary, backups: backups ?? undefined }),
          );
        }),
      ]
    : [],
);
const DB_UPKEEP_TIME = '04:00'; // local; before the usual 06:00 daily restart
const dbCopies = join(dirname(config.dbPath), 'db-backups');
const upkeep = everyDay(DB_UPKEEP_TIME, 0, (target) => db.maintain(dbCopies, target));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    restarts.stop();
    backups.stop();
    playtime.stop();
    lag.stop();
    quests.flush(); // don't lose a pending roll-up
    quests.stop();
    for (const cancel of summaries) cancel();
    upkeep();
    stopPing();
    void discord.client.destroy();
    void hub.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}

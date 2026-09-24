import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupNotice, BackupWatcher, listBackups } from './backups.ts';
import { everyDay, parseDaily } from './daily.ts';
import { Db, type State } from './db.ts';
import { startDiscord } from './discord.ts';
import { DEFAULT_LAG, LagMonitor, type LagConfig } from './lag.ts';
import { Links } from './links.ts';
import { PlaytimeTracker } from './playtime.ts';
import { QUEST_MODES, QuestAnnouncer, type QuestBatch, type QuestMode } from './quests.ts';
import { RestartScheduler } from './restarts.ts';
import { ServerHub, type Lifecycle, type ServerConfig } from './servers.ts';
import { buildSummary } from './summary.ts';

type Config = {
  listenPort: number;
  dbPath: string;
  guildId: string;
  adminRoleId: string;
  servers: (ServerConfig & {
    channelId: string;
    dir?: string;
    dailyRestart?: string;
    dailySummary?: string;
    backupDir?: string;
    backupMaxAgeHours?: number;
    lagTps?: number;
    lagMinutes?: number;
    lagAlerts?: boolean;
    quests?: QuestMode;
  })[];
};

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is not set');
const config = JSON.parse(readFileSync(process.argv[2] ?? 'config.json', 'utf8')) as Config;
for (const s of config.servers) {
  if (s.dailySummary !== undefined && !parseDaily(s.dailySummary)) {
    throw new Error(`server "${s.id}": dailySummary must be HH:MM (24-hour), got "${s.dailySummary}"`);
  }
  if (s.quests !== undefined && !QUEST_MODES.includes(s.quests)) {
    throw new Error(`server "${s.id}": quests must be one of ${QUEST_MODES.join(', ')}, got "${s.quests}"`);
  }
  if (s.lagTps !== undefined && !(s.lagTps > 0 && s.lagTps <= 20)) throw new Error(`server "${s.id}": lagTps must be 1–20`);
  if (s.lagMinutes !== undefined && !(Number.isInteger(s.lagMinutes) && s.lagMinutes >= 1)) {
    throw new Error(`server "${s.id}": lagMinutes must be a whole number of at least 1`);
  }
}
const lagConfigs: Record<string, LagConfig> = Object.fromEntries(
  config.servers.map((s) => [
    s.id,
    { tps: s.lagTps ?? DEFAULT_LAG.tps, minutes: s.lagMinutes ?? DEFAULT_LAG.minutes, enabled: s.lagAlerts ?? true },
  ]),
);
const backupDirs: Record<string, string> = Object.fromEntries(
  config.servers.flatMap((s) => {
    const dir = s.backupDir ?? (s.dir ? join(s.dir, 'backups') : undefined);
    return dir ? [[s.id, dir]] : [];
  }),
);

const db = new Db(config.dbPath);
db.markHubRestart(config.servers.map((s) => s.id)); // also ends sessions left open when the hub last stopped
setInterval(() => db.touch(), 60_000);

const hub = new ServerHub(config.servers);
const STATES = new Map<Lifecycle, State>([
  ['connected', 'up'],
  ['started', 'up'],
  ['recovered', 'up'],
  ['stopped', 'down'],
  ['crashed', 'down'],
  ['hung', 'down'],
  ['offline', 'down'],
]);
hub.on('event', (e) => {
  const state = STATES.get(e.type as Lifecycle);
  if (state) db.record(e.serverId, state, e.type);
});

// Hub-core output goes to Discord, which is connected below; until then it goes nowhere.
let notice: (serverId: string, text: string) => void = () => {};
let postQuests: (batch: QuestBatch) => void = () => {};
let postLinked: (serverId: string, player: string, discordId: string) => void = () => {};
const notify = (serverId: string, text: string) => notice(serverId, text);
const restarts = new RestartScheduler(hub, notify);
for (const s of config.servers) if (s.dailyRestart) restarts.daily(s.id, s.dailyRestart); // throws on a bad time
const backups = new BackupWatcher((serverId) => listBackups(backupDirs[serverId] ?? ''), notify);
for (const s of config.servers) {
  if (s.backupMaxAgeHours && backupDirs[s.id]) backups.watchdog(s.id, s.backupMaxAgeHours);
}
const playtime = new PlaytimeTracker(hub, db);
const lag = new LagMonitor(hub, db, lagConfigs, notify);
const quests = new QuestAnnouncer(
  Object.fromEntries(config.servers.map((s) => [s.id, s.quests ?? 'batched'])),
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
const summaries = config.servers.flatMap((s) =>
  s.dailySummary ? [everyDay(s.dailySummary, 0, (target) => discord.summary(s.id, buildSummary(db, s.id, target)))] : [],
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    restarts.stop();
    backups.stop();
    playtime.stop();
    lag.stop();
    quests.flush(); // don't lose a pending roll-up
    quests.stop();
    for (const cancel of summaries) cancel();
    void discord.client.destroy();
    void hub.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}

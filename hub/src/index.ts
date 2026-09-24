import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BackupWatcher, listBackups } from './backups.ts';
import { everyDay, parseDaily } from './daily.ts';
import { Db, type State } from './db.ts';
import { startDiscord } from './discord.ts';
import { PlaytimeTracker } from './playtime.ts';
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
  })[];
};

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is not set');
const config = JSON.parse(readFileSync(process.argv[2] ?? 'config.json', 'utf8')) as Config;
for (const s of config.servers) {
  if (s.dailySummary !== undefined && !parseDaily(s.dailySummary)) {
    throw new Error(`server "${s.id}": dailySummary must be HH:MM (24-hour), got "${s.dailySummary}"`);
  }
}
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

// Hub-core notices go to Discord, which is connected below; until then they go nowhere.
let notice: (serverId: string, text: string) => void = () => {};
const notify = (serverId: string, text: string) => notice(serverId, text);
const restarts = new RestartScheduler(hub, notify);
for (const s of config.servers) if (s.dailyRestart) restarts.daily(s.id, s.dailyRestart); // throws on a bad time
const backups = new BackupWatcher((serverId) => listBackups(backupDirs[serverId] ?? ''), notify);
for (const s of config.servers) {
  if (s.backupMaxAgeHours && backupDirs[s.id]) backups.watchdog(s.id, s.backupMaxAgeHours);
}
const playtime = new PlaytimeTracker(hub, db);

const port = await hub.listen(config.listenPort);
console.log(`[hub] listening on 127.0.0.1:${port}`);
playtime.start();

const discord = await startDiscord(
  hub,
  db,
  restarts,
  backups,
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
const summaries = config.servers.flatMap((s) =>
  s.dailySummary ? [everyDay(s.dailySummary, 0, (target) => discord.summary(s.id, buildSummary(db, s.id, target)))] : [],
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    restarts.stop();
    backups.stop();
    playtime.stop();
    for (const cancel of summaries) cancel();
    void discord.client.destroy();
    void hub.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}

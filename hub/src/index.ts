import { loadConfig } from './config.ts';
import { startDiscord } from './discord.ts';
import { httpGet } from './health.ts';
import { startHub } from './start.ts';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is not set');
const config = loadConfig(process.argv[2] ?? 'config.json');

const handle = await startHub(config, {
  startFrontend: async (hub, stats, restarts, links) => {
    const discord = await startDiscord(
      hub,
      stats,
      restarts,
      links,
      {
        guildId: config.guildId,
        adminRoleId: config.adminRoleId,
        channels: Object.fromEntries(config.servers.map((s) => [s.id, s.channelId])),
      },
      token,
    );
    return { connected: discord.connected, stop: () => void discord.client.destroy() };
  },
  get: httpGet,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void handle.close().finally(() => process.exit(0)));
}

import { loadConfig } from './config.ts';
import { startDiscord } from './discord.ts';
import { httpGet } from './health.ts';
import { startHub } from './start.ts';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is not set');
const config = loadConfig(process.argv[2] ?? 'config.json');

const handle = await startHub(config, {
  startFrontend: async (hub, stats, restarts, links, cfg) => {
    const discord = await startDiscord(hub, stats, restarts, links, cfg, token);
    return { connected: discord.connected, stop: () => void discord.client.destroy() };
  },
  get: httpGet,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void handle.close().finally(() => process.exit(0)));
}

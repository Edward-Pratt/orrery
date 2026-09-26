import { loadConfig } from './config.ts';
import { startDiscord } from './discord.ts';
import { httpGet } from './health.ts';
import { startHub } from './start.ts';

const config = loadConfig(process.argv[2] ?? 'config.json');
const token = process.env.DISCORD_TOKEN;
if (config.integrations.discord && !token) {
  console.error('integrations.discord is configured but DISCORD_TOKEN is not set');
  process.exit(1);
}

const handle = await startHub(config, {
  startFrontend: async (hub, stats, restarts, links, cfg) => {
    const discord = await startDiscord(hub, stats, restarts, links, cfg, token ?? '');
    return { stop: () => void discord.client.destroy() };
  },
  get: httpGet,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void handle.close().finally(() => process.exit(0)));
}

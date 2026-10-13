import net from 'node:net';
import { loadConfig } from './config.ts';
import { githubReader } from './deploys.ts';
import { startDiscord } from './discord.ts';
import { httpGet } from './health.ts';
import { localHost } from './host.ts';
import { execRestore } from './restore.ts';
import { execRun } from './services.ts';
import { startHub } from './start.ts';
import { discordOAuth } from './web.ts';

// fetch tries a name's addresses in turn, giving each only 250 ms by default. One lost SYN (resent after 1 s) on every
// IPv4 address then fails the connect with ETIMEDOUT, within ~0.5 s on a host without IPv6, whose attempts fail at once.
net.setDefaultAutoSelectFamilyAttemptTimeout(2_500);

const config = loadConfig(process.argv[2] ?? 'config.json');
const token = process.env.DISCORD_TOKEN;
if (config.integrations.discord && !token) {
  console.error('integrations.discord is configured but DISCORD_TOKEN is not set');
  process.exit(1);
}
const { web } = config.integrations;
const clientSecret = process.env.DISCORD_CLIENT_SECRET;
if (web && !clientSecret) {
  console.error('integrations.web is configured but DISCORD_CLIENT_SECRET is not set');
  process.exit(1);
}

const { github } = config.integrations;
const githubToken = process.env.GITHUB_TOKEN;
if (github && !githubToken) {
  console.error('integrations.github is configured but GITHUB_TOKEN is not set');
  process.exit(1);
}

const handle = await startHub(config, {
  startFrontend: async (hub, stats, restarts, links, cfg) => {
    const discord = await startDiscord(hub, stats, restarts, links, cfg, token ?? '');
    return { stop: () => void discord.client.destroy() };
  },
  get: httpGet,
  host: localHost,
  run: execRun,
  restore: execRestore,
  github: github && githubToken ? githubReader(github.repo, githubToken) : undefined,
  githubToken: githubToken || undefined,
  oauth: web && clientSecret ? discordOAuth(web.clientId, clientSecret) : undefined,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void handle.close().finally(() => process.exit(0)));
}

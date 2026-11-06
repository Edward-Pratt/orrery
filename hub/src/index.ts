// Entry point: raises Node's per-address connect attempt to 2.5 s (a lost SYN at 250 ms failed whole fetches with
// ETIMEDOUT), reads config and env (`FACTORIO_USERNAME` and `FACTORIO_TOKEN` are optional: without both, with agents
// on, a warning, and only game updates are refused: each has `orrery`, a portal mod), starts the hub with the real
// Discord frontend, HTTP get and GitHub reader, wires signals. Dashboard logins are local Users: no Discord secret.

import net from 'node:net';
import { loadConfig } from './config.ts';
import { githubReader } from './updates/deploys.ts';
import { startDiscord } from './discord/discord.ts';
import { httpGet } from './services/health.ts';
import { localHost } from './agents/host.ts';
import { execRestore } from './backups/restore.ts';
import { execRun } from './services/services.ts';
import { startHub } from './start.ts';

// fetch tries a name's addresses in turn, giving each only 250 ms by default. One lost SYN (resent after 1 s) on every
// IPv4 address then fails the connect with ETIMEDOUT, within ~0.5 s on a host without IPv6, whose attempts fail at once.
net.setDefaultAutoSelectFamilyAttemptTimeout(2_500);

const config = loadConfig(process.argv[2] ?? 'config.json');
const token = process.env.DISCORD_TOKEN;
if (config.integrations.discord && !token) {
  console.error('integrations.discord is configured but DISCORD_TOKEN is not set');
  process.exit(1);
}
const { github } = config.integrations;
const githubToken = process.env.GITHUB_TOKEN;
if (github && !githubToken) {
  console.error('integrations.github is configured but GITHUB_TOKEN is not set');
  process.exit(1);
}

// The owner's factorio.com account, for the mods' download links in game updates (/etc/orrery-factorio-account.env,
// read only by the hub's unit). Without it the hub runs; only game updates are refused (each has mods: orrery at least), saying why.
const factorioUsername = process.env.FACTORIO_USERNAME;
const factorioToken = process.env.FACTORIO_TOKEN;
const factorioAccount = factorioUsername && factorioToken ? { username: factorioUsername, token: factorioToken } : undefined;
if (config.integrations.agents && !factorioAccount) {
  console.warn('[hub] FACTORIO_USERNAME and FACTORIO_TOKEN are not set: game updates are refused');
}

const handle = await startHub(config, {
  startFrontend: async (hub, stats, restarts, links, cfg) => {
    const discord = await startDiscord(hub, stats, restarts, links, cfg, token ?? '');
    return { stop: () => discord.stop() };
  },
  get: httpGet,
  host: localHost,
  run: execRun,
  restore: execRestore,
  github: github && githubToken ? githubReader(github.repo, githubToken) : undefined,
  githubToken: githubToken || undefined,
  factorioAccount,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void handle.close().finally(() => process.exit(0)));
}

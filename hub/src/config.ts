// The config's entry point: `loadConfig`, which returns `ServerSettings` per server with every default applied (game
// `minecraft`, lag 15 TPS (50 UPS for factorio)/2 min, quests `batched`, 10 GB free, 7-day web sessions, web's guild
// and admin role from `discord`) and the Backup folder derived (`backupDir`, else `<dir>/backups`), after
// `validateConfig` (`config-validate.ts`) finds no problem. The per-server defaults, a Host's limits and production's
// deploy targets are in `config-defaults.ts`; `loadConfig` itself defaults `newerAfterDays` and a Host's
// `mounts`, and `resolveWeb` (`web/web-config.ts`) the web ones. The shape and its types are in `config-types.ts`. Every caller imports from here: it re-exports the types,
// `PRODUCTION_DEPLOYS` and `validateConfig`. Used by startup and `check-config`. Hub core.

import { readFileSync } from 'node:fs';
import { HOST_LIMITS, PRODUCTION_DEPLOYS, resolve } from './config-defaults.ts';
import type { Config, HostIntegration, HostLimits, ServerEntry } from './config-types.ts';
import { validateConfig } from './config-validate.ts';
import { resolveWeb } from './web/web-config.ts';

export type {
  AgentConfig,
  AgentsIntegration,
  CheckConfig,
  Config,
  DeployTargets,
  DiscordConfig,
  GithubIntegration,
  HostIntegration,
  HostLimits,
  MinecraftIntegration,
  ServerSettings,
  ServiceConfig,
  WebIntegration,
} from './config-types.ts';
export { PRODUCTION_DEPLOYS } from './config-defaults.ts';
export { validateConfig } from './config-validate.ts';

/** Reads, parses, validates and resolves a config file; throws one error listing every problem. */
export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
  const errors = validateConfig(raw);
  if (errors.length) {
    throw new Error(`${path} has ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n- ${errors.join('\n- ')}`);
  }
  const c = raw as Omit<Config, 'servers'> & { servers: ServerEntry[] };
  const integrations = { ...c.integrations };
  const { web, host, github, agents } = integrations;
  if (github) {
    integrations.github = {
      ...github,
      newerAfterDays: github.newerAfterDays ?? 14,
      deploys: { ...PRODUCTION_DEPLOYS, ...github.deploys },
    };
  }
  if (host) integrations.host = { mounts: ['/'], ...HOST_LIMITS, ...(host as Partial<HostIntegration> & { id: string }) };
  if (agents) {
    integrations.agents = {
      ...agents,
      agents: agents.agents.map((a) => ({ ...a, host: { ...HOST_LIMITS, ...(a.host as Partial<HostLimits> | undefined) } })),
    };
  }
  if (web) integrations.web = resolveWeb(web);
  return { ...c, servers: c.servers.map(resolve), integrations };
}

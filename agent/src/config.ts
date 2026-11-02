// `loadConfig(path, env, root)`: `/etc/orrery-agent/config.json` (`{ id, hub: { host, port }, server: { id, unit,
// install, data, rconPort, factorioUdpPort, agentUdpPort }, mounts }`) and the secrets from the environment, checked
// strictly (every problem listed, no secret printed; unknown keys ignored, since setup can be newer than the agent):
// the hub's Agent id rule, an IPv4 hub, ports, a `.service` unit name, absolute normalised folders outside the
// agent's own (`/srv/orrery-agent`, which also holds `state/`) and not holding it, 1 to 32 mounts,
// `ORRERY_AGENT_TOKEN` 32 to 256 characters, `RCON_PASSWORD` set.

import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { posix } from 'node:path';
import { LIMITS } from './wire.ts';

/** Where setup writes the agent's config (root-owned, mode 644, no secrets). */
export const CONFIG_PATH = '/etc/orrery-agent/config.json';
/** The agent's own folder: its releases, `state/` and the `connected` file. The container never mounts it. */
export const AGENT_ROOT = '/srv/orrery-agent';

/** The Factorio server the agent runs: its id in the hub's config, its unit, its folders and its local ports. */
export type ServerConfig = {
  id: string;
  unit: string;
  /** The game's releases and `current` (mounted read-only into the container). */
  install: string;
  /** Saves, mods, config and logs (the container writes it all). */
  data: string;
  rconPort: number;
  factorioUdpPort: number;
  agentUdpPort: number;
};

export type Config = {
  id: string;
  hub: { host: string; port: number };
  server: ServerConfig;
  /** The mounts whose disk space each host sample reports. */
  mounts: string[];
  /** `ORRERY_AGENT_TOKEN`, from the environment: the hub's token for this agent, both connections. */
  token: string;
  /** `RCON_PASSWORD`, from the environment: the one factorio.service starts with. */
  rconPassword: string;
  root: string;
  /** The agent's bookkeeping, under `root`: never under the container's folders. */
  state: string;
};

export class ConfigError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The hub's rule for an Agent's id, which is also its Host's. */
const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** A plain service unit name: it goes to systemctl after `--`, and never starts with a dash anyway. */
const UNIT = /^\w[\w:.@\\-]*\.service$/;

/** An absolute path as written: normalised, no trailing slash, not `/`. */
const isPath = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= LIMITS.text && posix.isAbsolute(v) && posix.normalize(v) === v && v !== '/' && !v.endsWith('/');
/** `a` is `b` or inside it. */
const within = (a: string, b: string) => a === b || a.startsWith(b + '/');

/**
 * The config at `path` and the two secrets from `env`, checked strictly; throws `ConfigError` listing every problem.
 * Unknown keys are ignored, like the hub's config: setup may be newer than the agent it runs. Never prints a secret.
 */
export function loadConfig(path = CONFIG_PATH, env: NodeJS.ProcessEnv = process.env, root = AGENT_ROOT): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`can't read ${path}: ${(err as Error).message}`);
  }
  const result = checkConfig(raw, env, root);
  if ('errors' in result) throw new ConfigError(`${path}:\n  ${result.errors.join('\n  ')}`);
  return result.config;
}

/** As `loadConfig`, for an already parsed config: the config, or every problem with it. */
export function checkConfig(raw: unknown, env: NodeJS.ProcessEnv, root = AGENT_ROOT): { config: Config } | { errors: string[] } {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);
  const port = (o: Obj, key: string, where: string): number => {
    const v = o[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535) return v;
    err(`${where}"${key}" must be a port number (1-65535)`);
    return 0;
  };
  if (!isObj(raw)) return { errors: ['the config must be a JSON object'] };
  if (!isPath(root)) return { errors: [`the agent's folder ${JSON.stringify(root)} must be an absolute path, normalised, not /`] };

  const id = raw.id;
  if (typeof id !== 'string' || !AGENT_ID.test(id)) err('"id" must be lower-case letters, digits and dashes, starting with a letter, at most 32 characters');

  const hub = isObj(raw.hub) ? raw.hub : null;
  if (!hub) err('"hub" must be an object with "host" and "port"');
  else {
    if (typeof hub.host !== 'string' || !isIPv4(hub.host)) err('hub: "host" must be an IPv4 address');
    port(hub, 'port', 'hub: ');
  }

  const s = isObj(raw.server) ? raw.server : null;
  if (!s) err('"server" must be an object');
  else {
    if (typeof s.id !== 'string' || s.id === '' || s.id.length > LIMITS.text) err(`server: "id" must be a server id (1 to ${LIMITS.text} characters)`);
    if (typeof s.unit !== 'string' || s.unit.length > LIMITS.text || !UNIT.test(s.unit)) err('server: "unit" must be a unit name ending in .service');
    for (const key of ['install', 'data']) {
      const v = s[key];
      if (!isPath(v)) err(`server: "${key}" must be an absolute path, normalised, not /`);
      else if (within(v, root) || within(root, v)) err(`server: "${key}" must be outside ${root}, the agent's own folder, and not hold it`);
    }
    if (isPath(s.install) && isPath(s.data) && (within(s.install, s.data) || within(s.data, s.install))) {
      err('server: "install" and "data" must be separate folders');
    }
    port(s, 'rconPort', 'server: ');
    const game = port(s, 'factorioUdpPort', 'server: ');
    const agent = port(s, 'agentUdpPort', 'server: ');
    if (game !== 0 && game === agent) err('server: "agentUdpPort" must differ from "factorioUdpPort"');
  }

  const mounts = raw.mounts;
  if (!Array.isArray(mounts) || mounts.length === 0 || mounts.length > LIMITS.disks) err(`"mounts" must be a list of 1 to ${LIMITS.disks} paths`);
  else {
    for (const m of mounts) {
      if (typeof m !== 'string' || m.length > LIMITS.text || !posix.isAbsolute(m) || posix.normalize(m) !== m) err(`"mounts": ${JSON.stringify(m)} is not an absolute path`);
    }
    if (new Set(mounts).size !== mounts.length) err('"mounts" lists a mount twice');
  }

  const token = env.ORRERY_AGENT_TOKEN;
  if (typeof token !== 'string' || token.length < 32 || token.length > LIMITS.text) err(`ORRERY_AGENT_TOKEN must be set, 32 to ${LIMITS.text} characters`);
  const rconPassword = env.RCON_PASSWORD;
  if (typeof rconPassword !== 'string' || rconPassword === '') err('RCON_PASSWORD must be set');

  if (errors.length > 0) return { errors };
  return {
    config: {
      id: id as string,
      hub: { host: hub!.host as string, port: hub!.port as number },
      server: {
        id: s!.id as string,
        unit: s!.unit as string,
        install: s!.install as string,
        data: s!.data as string,
        rconPort: s!.rconPort as number,
        factorioUdpPort: s!.factorioUdpPort as number,
        agentUdpPort: s!.agentUdpPort as number,
      },
      mounts: [...(mounts as string[])],
      token: token!,
      rconPassword: rconPassword!,
      root,
      state: posix.join(root, 'state'),
    },
  };
}

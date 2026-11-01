import { readFileSync, statSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { parseDaily } from './daily.ts';
import { GAMES, rateOf, type LagConfig } from './lag.ts';
import { LIMITS } from './protocol.ts';
import { QUEST_MODES, type QuestMode } from './quests.ts';
import type { Game } from './types.ts';

/** A server entry as written in config.json. */
type ServerEntry = {
  id: string;
  name: string;
  game?: Game;
  dir?: string;
  dailyRestart?: string;
  dailySummary?: string;
  backupDir?: string;
  backupMaxAgeHours?: number;
  backupMinFreeGB?: number;
  lagTps?: number;
  lagMinutes?: number;
  lagAlerts?: boolean;
  quests?: QuestMode;
  service?: string;
  keep?: string[];
};

/** What a server is configured to do, with every default applied. */
export type ServerSettings = {
  id: string;
  name: string;
  /** Default `minecraft`. */
  game: Game;
  dir?: string;
  /** `backupDir`, else `<dir>/backups`, else none (no Backup features). */
  backupDir?: string;
  dailyRestart?: string;
  dailySummary?: string;
  /** Unset: no missing-Backup check. */
  backupMaxAgeHours?: number;
  backupMinFreeGB: number;
  lag: LagConfig;
  quests: QuestMode;
  /** The id of the service (in `integrations.systemd`) this server runs as. */
  service?: string;
  /** Paths in `dir` a pack update never deletes or overwrites, besides the built-in ones. */
  keep?: string[];
};

/** The bot's guild, the role allowed to run admin commands, and a channel per server id. */
export type DiscordConfig = {
  guildId: string;
  adminRoleId: string;
  /** serverId -> channelId. A server with no channel gets no chat or posts in Discord. */
  channels: Record<string, string>;
  /** Where notices about the host, services and checks go; unset: they aren't posted. */
  alertsChannel?: string;
};

/** The mod port and a token per server id. */
export type MinecraftIntegration = { listenPort: number; tokens: Record<string, string> };

/**
 * The HTTP API: localhost port, the public URL (OAuth redirect is derived from it), the Discord OAuth app, and the
 * guild whose admin role may log in (its own, else the bot's).
 */
export type WebIntegration = {
  listenPort: number;
  publicUrl: string;
  clientId: string;
  guildId: string;
  adminRoleId: string;
  sessionDays: number;
};

/** A URL requested every `intervalSeconds`; up means HTTP 2xx within the request timeout. May name its service. */
export type CheckConfig = { id: string; url: string; intervalSeconds: number; service?: string };

/** A systemd unit the hub may see (and later control), by id. Only listed units exist to the hub. */
export type ServiceConfig = { id: string; unit: string };

/**
 * The machine the hub runs on, by id: the mounts whose disk is watched, and when to warn: memory use at or over
 * `memoryMaxPercent` for `memoryMinutes`, and a mount under `diskMinFreeGB` free.
 */
export type HostIntegration = { id: string; mounts: string[]; memoryMaxPercent: number; memoryMinutes: number; diskMinFreeGB: number };

/** When to warn about a Host an Agent reports (its mounts are the Agent's own config): as `HostIntegration`'s. */
export type HostLimits = Omit<HostIntegration, 'id' | 'mounts'>;

/**
 * An Agent on a remote Host, by id (also its Host's id): its name, its token (32 to 256 characters), the tailnet
 * address it must connect from, the factorio server it runs (`server`; that server's `service` is then backed by
 * this Agent), and its Host's warning limits (defaulted like `integrations.host`'s).
 */
export type AgentConfig = { id: string; name: string; token: string; address: string; server: string; host: HostLimits };

/** The Agent port (`listen`: an IPv4 address, normally the hub's tailnet one, and a port) and the Agents allowed on it. */
export type AgentsIntegration = { listen: { host: string; port: number }; agents: AgentConfig[] };

/**
 * Where an environment's deploys go: its root (`releases/`, `current`, `config.json`, `hub.db`, `deploy.lock`,
 * `deploy-status.json`), its hub's unit, the templates of its hub and dashboard deploy units (`<template>@<tag>.service`)
 * and where its dashboard is served from.
 */
export type DeployTargets = { root: string; hubUnit: string; hubTemplate: string; webTemplate: string; webDir: string };

/**
 * GitHub: the repo (`owner/name`) whose published releases the hub offers, how many days a newer one waits before
 * it needs attention, and this environment's deploy targets. The token comes from `GITHUB_TOKEN`, never config.
 */
export type GithubIntegration = { repo: string; newerAfterDays: number; deploys: DeployTargets };

/** Production's deploy targets; staging sets its own. */
export const PRODUCTION_DEPLOYS: DeployTargets = {
  root: '/home/opc/orrery',
  hubUnit: 'orrery-hub.service',
  hubTemplate: 'orrery-deploy',
  webTemplate: 'orrery-deploy-web',
  webDir: '/var/www/orrery',
};

/** Which Environment a hub is: a label only, shown by the dashboard; what a hub can do comes from its integrations. */
export const ENVIRONMENTS = ['production', 'staging'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export type Config = {
  /** Default production. */
  environment: Environment;
  dbPath: string;
  healthcheckUrl?: string;
  servers: ServerSettings[];
  /** Each integration is on when its section is present; none is required. */
  integrations: {
    minecraft?: MinecraftIntegration;
    discord?: DiscordConfig;
    web?: WebIntegration;
    checks?: CheckConfig[];
    host?: HostIntegration;
    systemd?: ServiceConfig[];
    github?: GithubIntegration;
    agents?: AgentsIntegration;
  };
};

/** A Host's warning limits when its config leaves them out. */
const HOST_LIMITS: HostLimits = { memoryMaxPercent: 90, memoryMinutes: 5, diskMinFreeGB: 10 };

/** The default `lagTps` per game. */
const LAG_TPS: Record<Game, number> = { minecraft: 15, factorio: 50 };

function resolve(s: ServerEntry): ServerSettings {
  const { lagTps, lagMinutes, lagAlerts, ...rest } = s;
  const game = s.game ?? 'minecraft';
  return {
    ...rest,
    game,
    backupDir: s.backupDir ?? (s.dir ? join(s.dir, 'backups') : undefined),
    backupMinFreeGB: s.backupMinFreeGB ?? 10,
    lag: { tps: lagTps ?? LAG_TPS[game], minutes: lagMinutes ?? 2, enabled: lagAlerts ?? true },
    quests: s.quests ?? 'batched',
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const SNOWFLAKE = /^\d{17,20}$/;
/** An Agent's id, which is also its Host's. */
const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** A systemd unit name (with systemd's `\x2d`-style escapes); never an option, since it is passed to systemctl. */
const UNIT = /^\w[\w:.@\\-]*\.(service|socket|timer|target|path|mount)$/;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every problem with a parsed config.json, each prefixed with where it is; empty if it's valid. Offline. */
export function validateConfig(raw: unknown): string[] {
  if (!isObj(raw)) return ['config must be a JSON object'];
  const errors: string[] = [];
  const err = (where: string, msg: string) => errors.push(where ? `${where}: ${msg}` : msg);
  const str = (o: Obj, key: string, where: string, required = true): string | undefined => {
    const v = o[key];
    if (v === undefined) {
      if (required) err(where, `"${key}" is required`);
      return undefined;
    }
    if (typeof v !== 'string' || v === '') {
      err(where, `"${key}" must be a non-empty string`);
      return undefined;
    }
    return v;
  };
  const id = (o: Obj, key: string, where: string, required = true) => {
    const v = str(o, key, where, required);
    if (v !== undefined && !SNOWFLAKE.test(v)) err(where, `"${key}" must be a Discord ID (17–20 digits)`);
  };
  const num = (o: Obj, key: string, where: string, ok: (n: number) => boolean, rule: string) => {
    const v = o[key];
    if (v !== undefined && (typeof v !== 'number' || !ok(v))) err(where, `"${key}" must be ${rule}`);
  };

  const port = (o: Obj, where: string, key = 'listenPort') => {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
      err(where, `"${key}" must be a port number (1–65535)`);
    }
  };
  /** A Host's warning limits, in `integrations.host` and an Agent's `host`. */
  const hostLimits = (o: Obj, where: string) => {
    num(o, 'memoryMaxPercent', where, (n) => n >= 1 && n <= 100, 'a number from 1 to 100');
    num(o, 'memoryMinutes', where, (n) => Number.isInteger(n) && n >= 1, 'a whole number of at least 1');
    num(o, 'diskMinFreeGB', where, (n) => n > 0, 'a positive number');
  };
  /** A map keyed by server id: reports unknown ids and returns its entries. */
  const byServer = (o: Obj, key: string, where: string, ids: Set<string> | undefined): [string, unknown][] => {
    const v = o[key];
    if (!isObj(v)) {
      err(where, `"${key}" must be an object keyed by server id`);
      return [];
    }
    const entries = Object.entries(v);
    if (ids) for (const [sid] of entries) if (!ids.has(sid)) err(`${where}.${key}`, `"${sid}" is not a server id`);
    return entries;
  };

  /** An optional http(s) URL. */
  const httpUrl = (o: Obj, key: string, where: string, required = false) => {
    const url = str(o, key, where, required);
    if (url !== undefined && !/^https?:$/.test(URL.parse(url)?.protocol ?? '')) err(where, `"${key}" must be an http(s) URL`);
  };
  /** An integration's list of entries, each with its own id; `each` checks the rest of an entry. Returns the ids. */
  const list = (o: Obj, key: string, what: string, each: (e: Obj, where: string) => void, at = 'integrations'): Set<string> => {
    const seen = new Set<string>();
    const v = o[key];
    if (!Array.isArray(v)) {
      err(at, `"${key}" must be a list`);
      return seen;
    }
    for (const [i, e] of v.entries()) {
      if (!isObj(e)) {
        err(`${key}[${i}]`, 'must be an object');
        continue;
      }
      const eid = str(e, 'id', `${key}[${i}]`);
      const where = eid === undefined ? `${key}[${i}]` : `${what} "${eid}"`;
      each(e, where);
      if (eid !== undefined) {
        if (seen.has(eid)) err(where, 'duplicate id');
        seen.add(eid);
      }
    }
    return seen;
  };

  if (raw.environment !== undefined && !ENVIRONMENTS.includes(raw.environment as Environment)) {
    err('', `"environment" must be ${ENVIRONMENTS.join(' or ')}`);
  }
  str(raw, 'dbPath', '');
  httpUrl(raw, 'healthcheckUrl', '');

  let ids: Set<string> | undefined;
  const games = new Map<string, Game>();
  if (!Array.isArray(raw.servers) || raw.servers.length === 0) {
    err('', '"servers" must be a non-empty list');
  } else {
    ids = new Set<string>();
    for (const [i, s] of (raw.servers as unknown[]).entries()) {
      if (!isObj(s)) {
        err(`servers[${i}]`, 'must be an object');
        continue;
      }
      const sid = str(s, 'id', `servers[${i}]`);
      // The wire's cap: a longer id never gets past a hello.
      if (sid !== undefined && sid.length > LIMITS.text) err(`servers[${i}]`, `"id" must be at most ${LIMITS.text} characters`);
      const where = sid === undefined ? `servers[${i}]` : `server "${sid}"`;
      str(s, 'name', where);
      for (const key of ['dailyRestart', 'dailySummary']) {
        const time = str(s, key, where, false);
        if (time !== undefined && !parseDaily(time)) err(where, `"${key}" must be HH:MM (24-hour), got "${time}"`);
      }
      if (s.quests !== undefined && !QUEST_MODES.includes(s.quests as QuestMode)) {
        err(where, `"quests" must be one of ${QUEST_MODES.join(', ')}`);
      }
      let game: Game = 'minecraft';
      if (s.game !== undefined) {
        if (GAMES.includes(s.game as Game)) game = s.game as Game;
        else err(where, `"game" must be ${GAMES.join(' or ')}`);
      }
      if (sid !== undefined) games.set(sid, game);
      const { max } = rateOf(game);
      num(s, 'lagTps', where, (n) => n >= 1 && n <= max, `a number from 1 to ${max}`);
      num(s, 'lagMinutes', where, (n) => Number.isInteger(n) && n >= 1, 'a whole number of at least 1');
      num(s, 'backupMaxAgeHours', where, (n) => n > 0, 'a positive number');
      num(s, 'backupMinFreeGB', where, (n) => n > 0, 'a positive number');
      if (s.lagAlerts !== undefined && typeof s.lagAlerts !== 'boolean') err(where, '"lagAlerts" must be true or false');
      if (game === 'factorio') {
        // A factorio server runs on its Agent's machine: the hub has no folder of it, and its saves are its Backups.
        for (const key of ['dir', 'backupDir', 'keep']) {
          if (s[key] !== undefined) err(where, `"${key}" is only for minecraft servers: a factorio server has no folder on the hub's machine`);
        }
        if (s.service === undefined) err(where, '"service" is required for a factorio server: its Agent starts and stops it');
      } else {
        for (const key of ['dir', 'backupDir']) {
          const path = str(s, key, where, false);
          if (path !== undefined && !isDir(path)) err(where, `"${key}" is not an existing folder: ${path}`);
        }
      }
      if (s.keep !== undefined && game === 'minecraft') {
        if (!Array.isArray(s.keep)) err(where, '"keep" must be a list of paths in the server folder');
        else {
          for (const k of s.keep) {
            if (typeof k !== 'string' || k === '' || isAbsolute(k) || k.split(/[/\\]/).includes('..')) {
              err(where, `"keep" entries must be relative paths without "..", got ${JSON.stringify(k)}`);
            }
          }
        }
      }
      // Last, so a duplicate's own problems read first.
      if (sid !== undefined) {
        if (ids.has(sid)) err(where, 'duplicate id');
        ids.add(sid);
      }
    }
  }

  // An old-shape config gets its moves plus every other problem, so fixing it is one edit.
  const moves = oldShapeMoves(raw);
  if (moves.length) return [...moves, ...errors];

  const integrations = raw.integrations === undefined ? {} : raw.integrations;
  if (!isObj(integrations)) {
    err('', '"integrations" must be an object');
    return errors;
  }
  /** Every token so far, Mod and Agent: each must be unique. */
  const seen = new Set<string>();
  const mc = integrations.minecraft;
  if (mc !== undefined && !isObj(mc)) err('integrations', '"minecraft" must be an object');
  else if (mc) {
    const where = 'integrations.minecraft';
    port(mc, where);
    for (const [sid, token] of byServer(mc, 'tokens', where, ids)) {
      if (games.get(sid) === 'factorio') err(`${where}.tokens`, `"${sid}" is a factorio server: only minecraft servers have a Mod token`);
      else if (typeof token !== 'string' || token.length < 16 || token.length > LIMITS.text) err(`${where}.tokens`, `"${sid}" must be 16 to ${LIMITS.text} characters`);
      else if (seen.has(token)) err(`${where}.tokens`, `"${sid}" is the same as another server's`);
      else seen.add(token);
    }
    if (isObj(mc.tokens)) {
      for (const sid of ids ?? []) if (games.get(sid) === 'minecraft' && !Object.hasOwn(mc.tokens, sid)) err(`${where}.tokens`, `server "${sid}" has no token`);
    }
  }
  const discord = integrations.discord;
  if (discord !== undefined && !isObj(discord)) err('integrations', '"discord" must be an object');
  else if (discord) {
    const where = 'integrations.discord';
    id(discord, 'guildId', where);
    id(discord, 'adminRoleId', where);
    id(discord, 'alertsChannel', where, false);
    for (const [sid, channel] of byServer(discord, 'channels', where, ids)) {
      if (typeof channel !== 'string' || !SNOWFLAKE.test(channel)) {
        err(`${where}.channels`, `"${sid}" must be a Discord ID (17–20 digits)`);
      }
    }
  }
  let services = new Set<string>();
  if (integrations.systemd !== undefined) {
    const units = new Set<string>();
    services = list(integrations, 'systemd', 'service', (s, where) => {
      const unit = str(s, 'unit', where);
      if (unit === undefined) return;
      if (!UNIT.test(unit)) err(where, '"unit" must be a systemd unit name, like gtnh.service');
      else if (units.has(unit)) err(where, `"${unit}" is listed already`);
      units.add(unit);
    });
  }
  const linked = new Map<string, string>(); // service id -> server id
  for (const s of Array.isArray(raw.servers) ? raw.servers : []) {
    if (!isObj(s) || s.service === undefined || typeof s.id !== 'string') continue;
    const where = `server "${s.id}"`;
    if (!services.has(s.service as string)) err(where, '"service" must be the id of a service in integrations.systemd');
    else if (linked.has(s.service as string)) err(where, `service "${s.service}" is linked to server "${linked.get(s.service as string)}" already`);
    else linked.set(s.service as string, s.id);
  }
  if (integrations.checks !== undefined) {
    list(integrations, 'checks', 'check', (c, where) => {
      httpUrl(c, 'url', where, true);
      if (c.service !== undefined && !services.has(c.service as string)) {
        err(where, '"service" must be the id of a service in integrations.systemd');
      }
      const n = c.intervalSeconds;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 30) err(where, '"intervalSeconds" must be a whole number of at least 30');
    });
  }
  const host = integrations.host;
  if (host !== undefined && !isObj(host)) err('integrations', '"host" must be an object');
  else if (host) {
    const where = 'integrations.host';
    str(host, 'id', where);
    const mounts = host.mounts;
    if (mounts !== undefined) {
      for (const m of Array.isArray(mounts) ? mounts : []) {
        if (typeof m === 'string' && m !== '' && !isDir(m)) err(where, `mount "${m}" is not an existing folder`);
      }
      if (!Array.isArray(mounts) || !mounts.length || !mounts.every((m) => typeof m === 'string' && m !== '')) {
        err(where, '"mounts" must be a non-empty list of folders');
      }
    }
    hostLimits(host, where);
  }
  const web = integrations.web;
  if (web !== undefined && !isObj(web)) err('integrations', '"web" must be an object');
  else if (web) {
    const where = 'integrations.web';
    port(web, where);
    const url = str(web, 'publicUrl', where);
    const parsed = url === undefined ? undefined : URL.parse(url);
    if (url !== undefined && (parsed?.protocol !== 'https:' || parsed.pathname !== '/')) {
      err(where, '"publicUrl" must be an https URL with no path');
    }
    id(web, 'clientId', where);
    num(web, 'sessionDays', where, (n) => n > 0, 'a positive number');
    for (const key of ['guildId', 'adminRoleId']) {
      if (web[key] !== undefined) id(web, key, where);
      else if (!isObj(discord) || discord[key] === undefined) {
        err(where, `"${key}" is required (or set integrations.discord.${key})`);
      }
    }
  }
  const agents = integrations.agents;
  /** Factorio server id -> the Agents that name it. */
  const served = new Map<string, string[]>();
  if (agents !== undefined && !isObj(agents)) err('integrations', '"agents" must be an object');
  else if (agents) {
    const where = 'integrations.agents';
    const listen = agents.listen;
    if (!isObj(listen)) err(where, '"listen" must be an object with "host" and "port"');
    else {
      const at = `${where}.listen`;
      if (typeof listen.host !== 'string' || !isIPv4(listen.host)) err(at, '"host" must be an IPv4 address');
      port(listen, at, 'port');
      for (const [name, other] of [['minecraft', mc], ['web', web]] as const) {
        if (isObj(other) && other.listenPort === listen.port) err(at, `"port" must differ from integrations.${name}.listenPort`);
      }
    }
    const hubHost = isObj(host) ? host.id : undefined;
    list(agents, 'agents', 'agent', (a, at) => {
      const aid = a.id;
      if (typeof aid === 'string' && aid !== '') {
        if (!AGENT_ID.test(aid)) err(at, '"id" must be lower-case letters, digits and dashes, starting with a letter, at most 32 characters');
        else if (aid === hubHost) err(at, '"id" must differ from integrations.host.id: it is also its Host\'s id');
      }
      str(a, 'name', at);
      const token = a.token;
      if (typeof token !== 'string' || token.length < 32 || token.length > LIMITS.text) err(at, `"token" must be 32 to ${LIMITS.text} characters`);
      else if (seen.has(token)) err(at, '"token" is the same as another token');
      else seen.add(token);
      const address = str(a, 'address', at);
      if (address !== undefined && !isIPv4(address)) err(at, '"address" must be an IPv4 address');
      const sid = str(a, 'server', at);
      if (sid !== undefined) {
        if (ids && !ids.has(sid)) err(at, `"server" "${sid}" is not a server id`);
        else if (games.get(sid) !== undefined && games.get(sid) !== 'factorio') err(at, `"server" "${sid}" must be a factorio server`);
        else served.set(sid, [...(served.get(sid) ?? []), typeof aid === 'string' ? aid : '?']);
      }
      if (a.host !== undefined && !isObj(a.host)) err(at, '"host" must be an object');
      else if (a.host) hostLimits(a.host, at);
    }, where);
  }
  for (const [sid, game] of games) {
    if (game !== 'factorio') continue;
    const by = served.get(sid) ?? [];
    if (by.length === 0) err(`server "${sid}"`, 'a factorio server must be the "server" of an agent in integrations.agents');
    else if (by.length > 1) err(`server "${sid}"`, `a factorio server is run by one agent only, not by ${by.map((a) => `"${a}"`).join(', ')}`);
  }
  const github = integrations.github;
  if (github !== undefined && !isObj(github)) err('integrations', '"github" must be an object');
  else if (github) {
    const where = 'integrations.github';
    const repo = str(github, 'repo', where);
    if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) err(where, '"repo" must be owner/name');
    num(github, 'newerAfterDays', where, (n) => n > 0, 'a positive number');
    const deploys = github.deploys;
    if (deploys !== undefined && !isObj(deploys)) err(where, '"deploys" must be an object');
    else if (deploys) {
      const at = `${where}.deploys`;
      // Not checked to exist: the root is made by the one-time move, after the config is written.
      for (const key of ['root', 'webDir']) {
        const path = str(deploys, key, at, false);
        if (path !== undefined && !isAbsolute(path)) err(at, `"${key}" must be an absolute path`);
      }
      const unit = str(deploys, 'hubUnit', at, false);
      if (unit !== undefined && !UNIT.test(unit)) err(at, '"hubUnit" must be a systemd unit name, like orrery-hub.service');
      for (const key of ['hubTemplate', 'webTemplate']) {
        const t = str(deploys, key, at, false);
        if (t !== undefined && (t.includes('@') || !UNIT.test(`${t}@hub-v0.0.0.service`))) {
          err(at, `"${key}" must be a unit template's name, like orrery-deploy`);
        }
      }
    }
    // One root per Environment (docs/adr/0003): hub.db sits directly in the deploys' root (production's when unset),
    // never under `current/` or `releases/`, which every hub deploy replaces with a fresh clone.
    const root = isObj(deploys) && typeof deploys.root === 'string' ? deploys.root : PRODUCTION_DEPLOYS.root;
    if (isAbsolute(root) && typeof raw.dbPath === 'string' && resolvePath(root) !== resolvePath(dirname(raw.dbPath))) {
      err(where, `"dbPath" must be a file directly in the deploys root ${resolvePath(root)} (like ${join(resolvePath(root), 'hub.db')}), not ${raw.dbPath}: a hub deploy replaces current/`);
    }
  }
  return errors;
}

/** The keys of a pre-orrery config.json, each with where it moves to; empty if there are none. */
function oldShapeMoves(raw: Obj): string[] {
  const moves: string[] = [];
  for (const [key, to] of [
    ['listenPort', 'integrations.minecraft.listenPort'],
    ['guildId', 'integrations.discord.guildId'],
    ['adminRoleId', 'integrations.discord.adminRoleId'],
  ]) {
    if (Object.hasOwn(raw, key)) moves.push(`old config shape: move "${key}" to ${to}`);
  }
  if (Array.isArray(raw.servers)) {
    for (const [i, s] of (raw.servers as unknown[]).entries()) {
      if (!isObj(s)) continue;
      const sid = typeof s.id === 'string' ? s.id : `<id of servers[${i}]>`;
      if (Object.hasOwn(s, 'token')) moves.push(`old config shape: move server "${sid}"'s "token" to integrations.minecraft.tokens.${sid}`);
      if (Object.hasOwn(s, 'channelId')) moves.push(`old config shape: move server "${sid}"'s "channelId" to integrations.discord.channels.${sid}`);
    }
  }
  return moves;
}

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
  const c = raw as Omit<Config, 'servers' | 'environment'> & { environment?: Environment; servers: ServerEntry[] };
  const integrations = { ...c.integrations };
  const { web, discord, host, github, agents } = integrations;
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
  if (web) {
    integrations.web = {
      ...web,
      guildId: web.guildId ?? discord!.guildId, // validated: one of them is set
      adminRoleId: web.adminRoleId ?? discord!.adminRoleId,
      sessionDays: web.sessionDays ?? 7,
    };
  }
  return { ...c, environment: c.environment ?? 'production', servers: c.servers.map(resolve), integrations };
}

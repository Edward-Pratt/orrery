import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseDaily } from './daily.ts';
import type { LagConfig } from './lag.ts';
import { QUEST_MODES, type QuestMode } from './quests.ts';

/** A server entry as written in config.json. */
type ServerEntry = {
  id: string;
  name: string;
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
};

/** What a server is configured to do, with every default applied. */
export type ServerSettings = {
  id: string;
  name: string;
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

export type Config = {
  dbPath: string;
  healthcheckUrl?: string;
  servers: ServerSettings[];
  /** Each integration is on when its section is present; none is required. */
  integrations: { minecraft?: MinecraftIntegration; discord?: DiscordConfig; web?: WebIntegration; checks?: CheckConfig[]; host?: HostIntegration; systemd?: ServiceConfig[] };
};

function resolve(s: ServerEntry): ServerSettings {
  const { lagTps, lagMinutes, lagAlerts, ...rest } = s;
  return {
    ...rest,
    backupDir: s.backupDir ?? (s.dir ? join(s.dir, 'backups') : undefined),
    backupMinFreeGB: s.backupMinFreeGB ?? 10,
    lag: { tps: lagTps ?? 15, minutes: lagMinutes ?? 2, enabled: lagAlerts ?? true },
    quests: s.quests ?? 'batched',
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const SNOWFLAKE = /^\d{17,20}$/;
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

  const port = (o: Obj, where: string) => {
    const v = o.listenPort;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
      err(where, '"listenPort" must be a port number (1–65535)');
    }
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
  const list = (o: Obj, key: string, what: string, each: (e: Obj, where: string) => void): Set<string> => {
    const seen = new Set<string>();
    const v = o[key];
    if (!Array.isArray(v)) {
      err('integrations', `"${key}" must be a list`);
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

  str(raw, 'dbPath', '');
  httpUrl(raw, 'healthcheckUrl', '');

  let ids: Set<string> | undefined;
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
      const where = sid === undefined ? `servers[${i}]` : `server "${sid}"`;
      str(s, 'name', where);
      for (const key of ['dailyRestart', 'dailySummary']) {
        const time = str(s, key, where, false);
        if (time !== undefined && !parseDaily(time)) err(where, `"${key}" must be HH:MM (24-hour), got "${time}"`);
      }
      if (s.quests !== undefined && !QUEST_MODES.includes(s.quests as QuestMode)) {
        err(where, `"quests" must be one of ${QUEST_MODES.join(', ')}`);
      }
      num(s, 'lagTps', where, (n) => n >= 1 && n <= 20, 'a number from 1 to 20');
      num(s, 'lagMinutes', where, (n) => Number.isInteger(n) && n >= 1, 'a whole number of at least 1');
      num(s, 'backupMaxAgeHours', where, (n) => n > 0, 'a positive number');
      num(s, 'backupMinFreeGB', where, (n) => n > 0, 'a positive number');
      if (s.lagAlerts !== undefined && typeof s.lagAlerts !== 'boolean') err(where, '"lagAlerts" must be true or false');
      for (const key of ['dir', 'backupDir']) {
        const path = str(s, key, where, false);
        if (path !== undefined && !isDir(path)) err(where, `"${key}" is not an existing folder: ${path}`);
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
  const mc = integrations.minecraft;
  if (mc !== undefined && !isObj(mc)) err('integrations', '"minecraft" must be an object');
  else if (mc) {
    const where = 'integrations.minecraft';
    port(mc, where);
    const seen = new Set<string>();
    for (const [sid, token] of byServer(mc, 'tokens', where, ids)) {
      if (typeof token !== 'string' || token.length < 16) err(`${where}.tokens`, `"${sid}" must be at least 16 characters`);
      else if (seen.has(token)) err(`${where}.tokens`, `"${sid}" is the same as another server's`);
      else seen.add(token);
    }
    if (isObj(mc.tokens)) {
      for (const sid of ids ?? []) if (!Object.hasOwn(mc.tokens, sid)) err(`${where}.tokens`, `server "${sid}" has no token`);
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
    num(host, 'memoryMaxPercent', where, (n) => n >= 1 && n <= 100, 'a number from 1 to 100');
    num(host, 'memoryMinutes', where, (n) => Number.isInteger(n) && n >= 1, 'a whole number of at least 1');
    num(host, 'diskMinFreeGB', where, (n) => n > 0, 'a positive number');
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
  const c = raw as Omit<Config, 'servers'> & { servers: ServerEntry[] };
  const integrations = { ...c.integrations };
  const { web, discord, host } = integrations;
  if (host) {
    const defaults = { mounts: ['/'], memoryMaxPercent: 90, memoryMinutes: 5, diskMinFreeGB: 10 };
    integrations.host = { ...defaults, ...(host as Partial<HostIntegration> & { id: string }) };
  }
  if (web) {
    integrations.web = {
      ...web,
      guildId: web.guildId ?? discord!.guildId, // validated: one of them is set
      adminRoleId: web.adminRoleId ?? discord!.adminRoleId,
      sessionDays: web.sessionDays ?? 7,
    };
  }
  return { ...c, servers: c.servers.map(resolve), integrations };
}

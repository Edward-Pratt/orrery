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
};

/** The bot's guild, the role allowed to run admin commands, and a channel per server id. */
export type DiscordConfig = {
  guildId: string;
  adminRoleId: string;
  /** serverId -> channelId */
  channels: Record<string, string>;
};

/** The mod port and a token per server id. */
export type MinecraftIntegration = { listenPort: number; tokens: Record<string, string> };

export type Config = {
  dbPath: string;
  healthcheckUrl?: string;
  servers: ServerSettings[];
  integrations: { minecraft: MinecraftIntegration; discord: DiscordConfig };
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
  const id = (o: Obj, key: string, where: string) => {
    const v = str(o, key, where);
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

  const moves = oldShapeMoves(raw);
  if (moves.length) return moves;

  str(raw, 'dbPath', '');
  const url = str(raw, 'healthcheckUrl', '', false);
  if (url !== undefined && !/^https?:$/.test(URL.parse(url)?.protocol ?? '')) err('', '"healthcheckUrl" must be an http(s) URL');

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

  const integrations = raw.integrations;
  if (!isObj(integrations)) {
    err('', '"integrations" is required');
    return errors;
  }
  const mc = integrations.minecraft;
  if (!isObj(mc)) err('integrations', '"minecraft" is required');
  else {
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
  if (!isObj(discord)) err('integrations', '"discord" is required');
  else {
    const where = 'integrations.discord';
    id(discord, 'guildId', where);
    id(discord, 'adminRoleId', where);
    for (const [sid, channel] of byServer(discord, 'channels', where, ids)) {
      if (typeof channel !== 'string' || !SNOWFLAKE.test(channel)) {
        err(`${where}.channels`, `"${sid}" must be a Discord ID (17–20 digits)`);
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
  return { ...c, servers: c.servers.map(resolve) };
}

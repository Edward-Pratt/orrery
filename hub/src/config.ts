import { readFileSync, statSync } from 'node:fs';
import { parseDaily } from './daily.ts';
import { QUEST_MODES, type QuestMode } from './quests.ts';
import type { ServerConfig } from './servers.ts';

export type ServerEntry = ServerConfig & {
  channelId: string;
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

export type Config = {
  listenPort: number;
  dbPath: string;
  guildId: string;
  adminRoleId: string;
  healthcheckUrl?: string;
  servers: ServerEntry[];
};

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

  const port = raw.listenPort;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    err('', '"listenPort" must be a port number (1–65535)');
  }
  str(raw, 'dbPath', '');
  id(raw, 'guildId', '');
  id(raw, 'adminRoleId', '');
  const url = str(raw, 'healthcheckUrl', '', false);
  if (url !== undefined && !/^https?:$/.test(URL.parse(url)?.protocol ?? '')) err('', '"healthcheckUrl" must be an http(s) URL');

  if (!Array.isArray(raw.servers) || raw.servers.length === 0) {
    err('', '"servers" must be a non-empty list');
    return errors;
  }
  const ids = new Set<string>();
  const tokens = new Set<string>();
  raw.servers.forEach((s: unknown, i: number) => {
    if (!isObj(s)) return err(`servers[${i}]`, 'must be an object');
    const sid = str(s, 'id', `servers[${i}]`);
    const where = sid === undefined ? `servers[${i}]` : `server "${sid}"`;
    str(s, 'name', where);
    id(s, 'channelId', where);
    for (const key of ['dailyRestart', 'dailySummary']) {
      const time = str(s, key, where, false);
      if (time !== undefined && !parseDaily(time)) err(where, `"${key}" must be HH:MM (24-hour), got "${time}"`);
    }
    if (s.quests !== undefined && !QUEST_MODES.includes(s.quests as QuestMode)) {
      err(where, `"quests" must be one of ${QUEST_MODES.join(', ')}`);
    }
    num(s, 'lagTps', where, (n) => n > 0 && n <= 20, 'a number from 1 to 20');
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
    const token = str(s, 'token', where);
    if (token !== undefined) {
      if (token.length < 16) err(where, '"token" must be at least 16 characters');
      else if (tokens.has(token)) err(where, '"token" is the same as another server\'s');
      tokens.add(token);
    }
  });
  return errors;
}

/** Reads, parses and validates a config file; throws one error listing every problem. */
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
  return raw as Config;
}

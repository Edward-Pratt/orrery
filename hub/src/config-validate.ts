// `validateConfig` (every error at once, offline; the pre-2.0 shape gets a list of keys to move): every problem with a
// parsed config.json, each prefixed with where it is. The top-level keys first, then `servers[]` (`config-servers.ts`),
// then the old shape's moves (`oldShapeMoves`; with any, it returns them ahead of the rest), then each integration's
// section and the links between them (`integrations.web`'s own check is `checkWeb` in `web-config.ts`). Hub core.

import { isIPv4 } from 'node:net';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { checks, isDir, isObj, SNOWFLAKE, type Obj } from './config-check.ts';
import { PRODUCTION_DEPLOYS } from './config-defaults.ts';
import { checkServers } from './config-servers.ts';
import { ENVIRONMENTS, type Environment } from './config-types.ts';
import { checkWeb } from './web/web-config.ts';
import { LIMITS } from './protocol.ts';

/** An Agent's id, which is also its Host's. */
const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** A systemd unit name (with systemd's `\x2d`-style escapes); never an option, since it is passed to systemctl. */
const UNIT = /^\w[\w:.@\\-]*\.(service|socket|timer|target|path|mount)$/;

/** Every problem with a parsed config.json, each prefixed with where it is; empty if it's valid. Offline. */
export function validateConfig(raw: unknown): string[] {
  if (!isObj(raw)) return ['config must be a JSON object'];
  const errors: string[] = [];
  const { err, str, id, num, port, hostLimits, byServer, httpUrl, list } = checks(errors);

  if (raw.environment !== undefined && !ENVIRONMENTS.includes(raw.environment as Environment)) {
    err('', `"environment" must be ${ENVIRONMENTS.join(' or ')}`);
  }
  str(raw, 'dbPath', '');
  httpUrl(raw, 'healthcheckUrl', '');

  const { ids, games } = checkServers(checks(errors), raw);

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
  checkWeb(checks(errors), web, ids);
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

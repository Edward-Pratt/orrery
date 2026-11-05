// `integrations.web`'s own check, called by `validateConfig`: an object with the port, an https `publicUrl` with no
// path, the OAuth `clientId`, positive `sessionDays`, `guildId` and `adminRoleId` (each a Discord ID, or taken from
// `integrations.discord`'s), and the optional `status` (`servers`: a non-empty list of server ids, each once). Hub
// core, offline.

import { isObj, type Checks } from '../config-check.ts';

/**
 * Checks `integrations.web` (`web`, undefined when it is off) against `discord`, the raw `integrations.discord`, and
 * the server ids (`ids`, undefined when `servers` itself is broken).
 */
export function checkWeb(c: Checks, web: unknown, discord: unknown, ids: Set<string> | undefined): void {
  const { err, str, id, num, port } = c;
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
    if (web.status !== undefined) checkStatus(c, web.status, ids);
  }
}

/** The Status page's list: never a server by default, so every id must be a real one, listed once. */
function checkStatus({ err }: Checks, status: unknown, ids: Set<string> | undefined): void {
  const where = 'integrations.web.status';
  if (!isObj(status)) return void err('integrations.web', '"status" must be an object');
  const servers = status.servers;
  if (!Array.isArray(servers) || !servers.length || !servers.every((s) => typeof s === 'string' && s !== '')) {
    return void err(where, '"servers" must be a non-empty list of server ids');
  }
  const seen = new Set<string>();
  for (const sid of servers as string[]) {
    if (seen.has(sid)) err(where, `"${sid}" is listed twice`);
    else if (ids && !ids.has(sid)) err(where, `"${sid}" is not a server id`);
    seen.add(sid);
  }
}

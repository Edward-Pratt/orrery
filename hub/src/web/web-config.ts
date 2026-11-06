// `integrations.web`'s own check, called by `validateConfig`: an object with the port, an https `publicUrl` with no
// path, positive `sessionDays`, and the optional `status` (`servers`: a non-empty list of server ids, each once). The
// Discord login's keys (`OLD_KEYS`: `clientId`, `guildId`, `adminRoleId`) are ignored for one release, the Rollback
// window, with a warning from `resolveWeb` (which `loadConfig` calls, defaulting `sessionDays` to 7). Hub core, offline.

import { isObj, type Checks } from '../config-check.ts';
import type { WebIntegration } from '../config.ts';

/** The Discord login's keys: a hub rolled back to before Users still needs them, so they warn rather than fail. */
export const OLD_KEYS = ['clientId', 'guildId', 'adminRoleId'] as const;

/** `integrations.web` as the hub uses it, with a warning for each key of the Discord login left in. */
export function resolveWeb(web: WebIntegration, warn: (line: string) => void = console.warn): WebIntegration {
  for (const key of OLD_KEYS) {
    if (Object.hasOwn(web, key)) warn(`integrations.web: "${key}" is no longer used (dashboard logins are local Users): remove it after the Rollback window`);
  }
  return { listenPort: web.listenPort, publicUrl: web.publicUrl, sessionDays: web.sessionDays ?? 7, ...(web.status && { status: web.status }) };
}

/** Checks `integrations.web` (`web`, undefined when it is off) against the server ids (`ids`, undefined when `servers` itself is broken). */
export function checkWeb(c: Checks, web: unknown, ids: Set<string> | undefined): void {
  const { err, str, num, port } = c;
  if (web !== undefined && !isObj(web)) err('integrations', '"web" must be an object');
  else if (web) {
    const where = 'integrations.web';
    port(web, where);
    const url = str(web, 'publicUrl', where);
    const parsed = url === undefined ? undefined : URL.parse(url);
    if (url !== undefined && (parsed?.protocol !== 'https:' || parsed.pathname !== '/')) {
      err(where, '"publicUrl" must be an https URL with no path');
    }
    num(web, 'sessionDays', where, (n) => n > 0, 'a positive number');
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

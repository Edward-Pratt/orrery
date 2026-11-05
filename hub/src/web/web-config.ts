// `integrations.web`'s own check, called by `validateConfig`: an object with the port, an https `publicUrl` with no
// path, the OAuth `clientId`, positive `sessionDays`, and `guildId` and `adminRoleId` (each a Discord ID, or taken
// from `integrations.discord`'s). Hub core, offline.

import { isObj, type Checks } from '../config-check.ts';

/** Checks `integrations.web` (`web`, undefined when it is off) against `discord`, the raw `integrations.discord`. */
export function checkWeb({ err, str, id, num, port }: Checks, web: unknown, discord: unknown): void {
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
}

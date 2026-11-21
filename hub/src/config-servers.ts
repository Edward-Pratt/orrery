// `servers[]`'s own check, called by `validateConfig` before the integrations' sections: a non-empty list of objects,
// each with an `id` (at most 256 characters, the wire's cap; unique), a `name`, optional daily times, `quests`, `game`,
// lag and Backup limits; a factorio server is refused a `dir`, a `backupDir` and `keep` and needs a `service`; a
// minecraft server's folders must exist and its `keep` paths be relative, without `..`. `checkServers` pushes onto the
// same errors and returns the ids (unset when there is no list) and each server's game, for the integrations' checks.
// Hub core, offline.

import { isAbsolute } from 'node:path';
import { isDir, isObj, type Checks, type Obj } from './config-check.ts';
import { parseDaily } from './daily.ts';
import { GAMES, rateOf } from './servers/lag.ts';
import { LIMITS } from './protocol.ts';
import { QUEST_MODES, type QuestMode } from './servers/quests.ts';
import type { Game } from './types.ts';

/** `servers[]`'s problems, onto `c`'s errors; the server ids (unset when there is no list) and each one's game. */
export function checkServers(c: Checks, raw: Obj): { ids: Set<string> | undefined; games: Map<string, Game> } {
  const { err, str, num } = c;
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
  return { ids, games };
}

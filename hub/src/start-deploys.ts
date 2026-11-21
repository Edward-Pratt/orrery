// `startDeploys`, for `startHub`: `Deploys` with GitHub, given `Agents` for the Agents' releases and deploys, and
// `deploying` from it for `Packs` (a hub deploy or the server's Mod's) and `GameUpdates` (a hub deploy or the server's
// Agent's); built, set in `Late` and started. The library and packs are read from `Late` when called. `startHub`
// checks the GitHub reader and the systemctl runner first.

import type { Agents } from './agents/agents.ts';
import type { Config } from './config.ts';
import type { Db } from './stats/db.ts';
import { Deploys } from './updates/deploys.ts';
import type { GameSettings } from './servers/game-settings.ts';
import type { Restores } from './backups/restore.ts';
import type { RestartScheduler } from './servers/restarts.ts';
import type { ServerHub } from './servers/servers.ts';
import type { Late, Updating } from './start-core.ts';
import type { HubDeps } from './start.ts';

type DeploysParts = {
  hub: ServerHub;
  db: Db;
  restarts: RestartScheduler;
  agents: Agents | undefined;
  restores: Restores | undefined;
  updating: Updating;
  gameSettings: GameSettings | undefined;
  /** Where the database's copies go before a hub deploy. */
  dbCopies: string;
  late: Late;
};

/** Builds and starts `Deploys` with the GitHub integration; undefined otherwise. */
export function startDeploys(config: Config, deps: HubDeps, { hub, db, restarts, agents, restores, updating, gameSettings, dbCopies, late }: DeploysParts) {
  const { minecraft, github } = config.integrations;
  const deploys =
    github &&
    new Deploys(
      {
        hub,
        db,
        restarts,
        github: deps.github!, // checked above
        run: deps.run!,
        config: github,
        environment: config.environment,
        servers: config.servers,
        hasMod: (id) => Boolean(minecraft?.tokens[id]),
        agents,
        restoring: (id) => restores?.busy(id) ?? false,
        updating,
        settingsSaving: (id): boolean => gameSettings?.busy(id) ?? false,
        libraryAdding: () => late.library?.busy() ?? false,
        installing: () => late.packs?.installRunning() ?? false,
        mcOf: (id) => {
          const libraryId = db.pack(id)?.libraryId;
          return libraryId ? db.library().find((e) => e.id === libraryId)?.mc : undefined;
        },
        dbCopies,
      },
      deps.deploys,
    );
  late.deploys = deploys;
  deploys?.start();
  return deploys;
}

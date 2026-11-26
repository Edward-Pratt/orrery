// The Factorio game extras' wiring, for `startHub`. `startGame`: one `FactorioCatalog`, shared by `GameUpdates` and
// `ModUpdates` (which follows it, with its 6-hour check) and `ModsZip` so the mod browser's cache serves them all; `Moderation` with
// agents; `GameUpdates` with agents and systemd, built and started (the last hub's running rows closed, the Agents
// listened to) before the first await, so before any Agent can connect, and `GameSettings` beside it (its `updating`,
// restores and deploys the same; its `busy` given to `Restores` (through its `updating`), `GameUpdates` and `Deploys`
// as `settingsSaving`). Synchronous, so nothing between them awaits. Each sets its part in `Late` before starting it;
// deploys and game settings are read from `Late` when called. `buildSaveUploads`: `SaveUploads`, with agents and uploads.

import type { Agents } from './agents/agents.ts';
import type { Config } from './config.ts';
import type { Db } from './stats/db.ts';
import type { Deploys } from './updates/deploys.ts';
import { FactorioCatalog } from './updates/factorio.ts';
import { GameSettings } from './servers/game-settings.ts';
import { GameUpdates } from './updates/game-updates.ts';
import { ModUpdates } from './updates/mod-updates.ts';
import { ModsZip } from './updates/mods-zip.ts';
import { Moderation } from './servers/moderation.ts';
import type { Restores } from './backups/restore.ts';
import type { RestartScheduler } from './servers/restarts.ts';
import { SaveUploads } from './backups/save-uploads.ts';
import type { ServerHub } from './servers/servers.ts';
import type { Services } from './services/services.ts';
import type { Uploads } from './packs/uploads.ts';
import type { Late, Updating } from './start-core.ts';
import type { HubDeps } from './start.ts';

type GameParts = {
  hub: ServerHub;
  db: Db;
  agents: Agents | undefined;
  services: Services | undefined;
  restarts: RestartScheduler;
  restores: Restores | undefined;
  updating: Updating;
  late: Late;
};

/** Builds and starts game updates, portal mod updates and game settings, and builds moderation; each only with its integrations. */
export function startGame(config: Config, deps: HubDeps, { hub, db, agents, services, restarts, restores, updating, late }: GameParts) {
  // One catalog: game updates, the mod browser and portal mod updates share its caches.
  const catalog = new FactorioCatalog(deps.portal ?? fetch, deps.factorioAccount);
  // Game updates, with an Agent's server: started (its interrupted rows closed, the Agents heard) before any can connect.
  const gameUpdates =
    agents &&
    services &&
    new GameUpdates(
      {
        hub,
        db,
        agents,
        services,
        restarts,
        catalog,
        servers: config.servers,
        restoring: (id) => restores?.busy(id) ?? false,
        deploying: (agentId) => (late.deploys?.busy() ? 'hub' : late.deploys?.agentBusy(agentId) ? 'agent' : null),
        settingsSaving: (id): boolean => late.gameSettings?.busy(id) ?? false,
      },
      deps.gameUpdates,
    );
  late.gameUpdates = gameUpdates;
  gameUpdates?.start();
  const modUpdates = gameUpdates && new ModUpdates({ hub, db, catalog, gameUpdates, servers: config.servers.map((s) => s.id) }, deps.modUpdates);
  modUpdates?.start();
  const modsZip = gameUpdates && new ModsZip({ catalog, fetch: deps.portal ?? fetch, gameUpdates });
  const moderation = agents && new Moderation({ hub, agents, servers: config.servers });
  // Game settings, with an Agent's server: listening before any Agent can connect.
  const gameSettings =
    agents &&
    services &&
    new GameSettings({
      hub,
      agents,
      services,
      restarts,
      servers: config.servers,
      updating,
      restoring: (id) => restores?.busy(id) ?? false,
      deploying: (agentId) => (late.deploys?.busy() ? 'hub' : late.deploys?.agentBusy(agentId) ? 'agent' : null),
    });
  late.gameSettings = gameSettings;
  gameSettings?.start();
  return { gameUpdates, modUpdates, modsZip, moderation, gameSettings };
}

type SaveUploadsParts = {
  hub: ServerHub;
  agents: Agents | undefined;
  uploads: Uploads | undefined;
  agentOf: Map<string, string>;
  updating: Updating;
  gameSettings: GameSettings | undefined;
  restores: Restores | undefined;
  deploys: Deploys | undefined;
};

/** Builds `SaveUploads` with agents and uploads; undefined otherwise. */
export function buildSaveUploads({ hub, agents, uploads, agentOf, updating, gameSettings, restores, deploys }: SaveUploadsParts) {
  // Saves uploaded from the dashboard, sent to an Agent's server: not while it updates, restores, saves its game settings or deploys its Agent.
  return (
    agents &&
    uploads &&
    new SaveUploads({
      hub,
      agents,
      uploads,
      busy: (id) => {
        const kind = updating(id);
        if (kind) return `a ${kind} is running`;
        if (gameSettings?.busy(id)) return 'a game settings save is running';
        if (restores?.busy(id)) return 'a restore is running';
        if (agentOf.has(id) && deploys?.agentBusy(agentOf.get(id)!)) return "the server's Agent is being deployed";
        return null;
      },
    })
  );
}

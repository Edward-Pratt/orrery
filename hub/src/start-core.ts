// `buildCore(config, deps, late)`, called first by `startHub`: the database (the hub's restart marked, touched each
// minute), `ServerHub` (its lifecycle events recorded), the `LiveFeed`, `RestartScheduler` (each server's daily
// restart), `PlaytimeTracker`, `LagMonitor`, `QuestAnnouncer` and `Links`, built and not started. `RestartScheduler`'s
// `restart` looks `Services` up late, as it is built first; one `updating(id?)`, a pack update (`Packs.busy`) or a game
// update (`GameUpdates.busy`) by kind, for every busy check: `RestartScheduler`'s `paused`, `Restores`, `Deploys` and
// `DeploysAnswer.packing`. `Late` holds the parts built after closures that read them: each wiring function sets its
// own once built, and every closure reads them only when called.

import type { Config } from './config.ts';
import type { Deploys } from './updates/deploys.ts';
import type { GameSettings } from './servers/game-settings.ts';
import type { GameUpdates } from './updates/game-updates.ts';
import type { Library } from './packs/library.ts';
import type { Packs } from './packs/packs.ts';
import type { Services } from './services/services.ts';
import { Db } from './stats/db.ts';
import { LagMonitor } from './servers/lag.ts';
import { Links } from './servers/links.ts';
import { LiveFeed } from './stats/live.ts';
import { PlaytimeTracker } from './servers/playtime.ts';
import { QuestAnnouncer } from './servers/quests.ts';
import { RestartScheduler } from './servers/restarts.ts';
import { ServerHub } from './servers/servers.ts';
import type { HubDeps } from './start.ts';

/** The parts built after closures that read them; never destructure it, or a closure reads a part before it is built. */
export type Late = {
  services?: Services;
  deploys?: Deploys;
  packs?: Packs;
  gameUpdates?: GameUpdates;
  gameSettings?: GameSettings;
  library?: Library;
};

/** The kind of update running on a server (or any), or null. */
export type Updating = (id?: string) => 'pack update' | 'game update' | null;

/** Builds the database, the game connections' `ServerHub` and what listens to it; starts none of them. */
export function buildCore(config: Config, deps: HubDeps, late: Late) {
  const { minecraft } = config.integrations;
  const db = new Db(config.dbPath);
  db.markHubRestart(config.servers.map((s) => s.id)); // also ends sessions left open when the hub last stopped
  const touch = setInterval(() => db.touch(), 60_000);

  const hub = new ServerHub(
    config.servers.map((s) => ({ id: s.id, name: s.name, game: s.game, token: minecraft?.tokens[s.id] })),
    { ...deps.hub, audit: (entry) => db.audit(entry) },
  );
  hub.on('event', (e) => db.recordLifecycle(e.serverId, e.type));
  const live = new LiveFeed(hub, db);

  // The one check of an update running (on a server, or any): what kind, for each refusal's words.
  const updating: Updating = (id) => (late.packs?.busy(id) ? 'pack update' : late.gameUpdates?.busy(id) ? 'game update' : null);
  const serviceOf = new Map(config.servers.flatMap((s) => (s.service ? [[s.id, s.service]] : [])));
  const restarts = new RestartScheduler(hub, {
    // A daily countdown during an update would clash with its stop; the update restarts the server anyway.
    paused: (id) => {
      const what = updating(id);
      return what && `a ${what} is running`;
    },
    // A factorio server's countdown ends in its service's restart (config gives it one, and systemd), looked up late:
    // Services is built after RestartScheduler, which it counts down with.
    restart: async (id, by) => {
      const service = serviceOf.get(id);
      if (!late.services || service === undefined) throw new Error(`${id} has no service to restart`);
      await late.services.now(service, 'restart', by);
    },
  });
  for (const s of config.servers) if (s.dailyRestart) restarts.daily(s.id, s.dailyRestart); // throws on a bad time
  const playtime = new PlaytimeTracker(hub, db);
  const lag = new LagMonitor(hub, db, Object.fromEntries(config.servers.map((s) => [s.id, s.lag])));
  const quests = new QuestAnnouncer(hub, Object.fromEntries(config.servers.map((s) => [s.id, s.quests])));
  const links = new Links(db, hub);
  hub.on('event', (e) => {
    if (e.type === 'quest') quests.add(e.serverId, e.player, e.quests);
  });
  return { db, touch, hub, live, updating, restarts, playtime, lag, quests, links };
}

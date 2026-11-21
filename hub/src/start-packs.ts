// `buildPacks`, for `startHub`: `Uploads`, the `Library` and `Packs`, each built and set in `Late`, none started
// (`startHub` starts them after the frontend). Packs need the server's service (systemd) and its Mod (Minecraft);
// Uploads serve packs and an Agent's server's uploaded saves; the library is on whenever packs are. New servers get
// their Mod from `Deploys` when GitHub is on. Packs is read from `Late` when the library calls it.

import { dirname, join } from 'node:path';
import type { Agents } from './agents/agents.ts';
import type { Config } from './config.ts';
import type { Db } from './stats/db.ts';
import type { Deploys } from './updates/deploys.ts';
import { Library } from './packs/library.ts';
import { Packs } from './packs/packs.ts';
import type { Restores } from './backups/restore.ts';
import type { RestartScheduler } from './servers/restarts.ts';
import type { ServerHub } from './servers/servers.ts';
import type { Services } from './services/services.ts';
import { Uploads } from './packs/uploads.ts';
import type { Late } from './start-core.ts';
import type { HubDeps } from './start.ts';

type PacksParts = {
  hub: ServerHub;
  db: Db;
  services: Services | undefined;
  restarts: RestartScheduler;
  restores: Restores | undefined;
  deploys: Deploys | undefined;
  agents: Agents | undefined;
  /** The mod port; set whenever Minecraft is on. */
  port: number | undefined;
  late: Late;
};

/** Builds uploads, the library and packs, each only with its integrations. */
export function buildPacks(config: Config, deps: HubDeps, { hub, db, services, restarts, restores, deploys, agents, port, late }: PacksParts) {
  const { minecraft, github } = config.integrations;
  // Packs need the server's service (systemd) and its Mod (Minecraft): which servers have both, `Packs.has` says.
  // Uploads: for packs (a server's service and Mod), and for an Agent's server's uploaded saves.
  const uploads = services && (minecraft || agents) ? new Uploads(join(dirname(config.dbPath), 'uploads'), deps.uploadIdleMs) : undefined;
  // The library takes uploads and is one per Environment: on whenever packs are.
  const library =
    uploads &&
    minecraft &&
    new Library({
      hub,
      db,
      uploads,
      root: dirname(config.dbPath),
      download: deps.download ?? fetch,
      githubToken: deps.githubToken,
      installing: (id) => late.packs?.installing(id) ?? [],
      installRunning: () => late.packs?.installRunning() ?? false,
    });
  late.library = library;
  const packs =
    services &&
    minecraft &&
    uploads &&
    new Packs(
      {
        hub,
        db,
        services,
        restarts,
        servers: config.servers,
        hasMod: (id) => Boolean(minecraft.tokens[id]),
        uploads,
        library: library!, // on whenever uploads are
        dataDir: dirname(config.dbPath),
        restoring: (id) => restores?.busy(id) ?? false,
        deploying: (id) => (deploys?.busy() ? 'hub' : deploys?.modBusy(id) ? 'mod' : null),
        // New server: the Mod comes from GitHub's releases, and the setup command names the hub's unit.
        install: deploys && {
          mods: deploys,
          hubUnit: github!.deploys.hubUnit,
          hubPort: port!, // Minecraft is on with packs
          unitExists: async (unit) => /^LoadState=(?!not-found$)\S+$/m.test(await deps.run!('systemctl', ['show', '--property=LoadState', '--', unit])),
        },
      },
      deps.packs,
    );
  late.packs = packs;
  return { uploads, library, packs };
}

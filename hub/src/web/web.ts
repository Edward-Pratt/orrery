// Web integration: the Hono HTTP API under `/api` (`webApi`), wired here in this order, which Hono's matching depends
// on: the reads without a session (`publicRoutes`, in `web-public.ts`), then the CSRF check, the login, invites and
// session check (`authRoutes`, in `auth.ts`), the permission each route needs (`permitRoutes`, `permit.ts`), the Users
// page (`usersRoutes`, `web-users.ts`), `/api/integrations` (with `agents`, and `library` and `newServer` as below),
// the deploys with GitHub on (`deploysRoutes`, `web-deploys.ts`), `/api/checks` only with checks on, the services'
// list, logs and actions only with systemd on (`servicesRoutes`, `web-services.ts`), the Hosts (`hostsRoutes`,
// `web-hosts.ts`), New server before `/servers/:id` (`newServerRoutes`, `web-packs.ts`), the servers' reads and the
// audit log (`serversRoutes`, `web-servers.ts`), then everything that works on a stopped server, before the online
// check: the restore (`restoreRoutes`, `web-actions.ts`), the uploads, library and packs (`packsRoutes`,
// `web-packs.ts`), game updates (`gameUpdatesRoutes`, `web-game.ts`), portal mod updates and moderation
// and the mods zip (`gameExtrasRoutes`, `web-game-extras.ts`), game settings and save uploads (`gameSettingsRoutes`, `web-game.ts`);
// then the online check and the actions behind it (`actionsRoutes`, `web-actions.ts`) and the event stream
// (`eventsRoutes`, `web-events.ts`). Each module's header holds its routes' contract. Every other route needs a
// session, and each write a permission. `serveWebApi` serves it on 127.0.0.1.

import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { CheckStatus, Integrations } from '../api.ts';
import type { Checks } from '../services/checks.ts';
import type { Deploys } from '../updates/deploys.ts';
import { authRoutes, sessionUser } from './auth.ts';
import { permitRoutes } from './permit.ts';
import { actor, jsonBody, type SessionUser } from './request.ts';
import { usersRoutes } from './web-users.ts';
import { gameExtrasRoutes } from './web-game-extras.ts';
import { publicRoutes } from './web-public.ts';
import { servicesRoutes } from './web-services.ts';
import { actionsRoutes, restoreRoutes } from './web-actions.ts';
import { deploysRoutes } from './web-deploys.ts';
import { eventsRoutes } from './web-events.ts';
import { gameSettingsRoutes, gameUpdatesRoutes } from './web-game.ts';
import { hostsRoutes } from './web-hosts.ts';
import { newServerRoutes, packsRoutes } from './web-packs.ts';
import { serversRoutes } from './web-servers.ts';
import type { Moderation } from '../servers/moderation.ts';
import type { ModUpdates } from '../updates/mod-updates.ts';
import type { ModsZip } from '../updates/mods-zip.ts';
import type { SaveUploads } from '../backups/save-uploads.ts';
import type { GameUpdates } from '../updates/game-updates.ts';
import type { GameSettings } from '../servers/game-settings.ts';
import type { Agents } from '../agents/agents.ts';
import type { Hosts } from '../agents/host.ts';
import type { Config, WebIntegration } from '../config.ts';
import type { Db } from '../stats/db.ts';
import { LoginLimit } from '../users/login-limit.ts';
import type { Roles } from '../users/roles.ts';
import type { Users } from '../users/users.ts';
import type { LagMonitor } from '../servers/lag.ts';
import type { Library } from '../packs/library.ts';
import type { LiveFeed } from '../stats/live.ts';
import type { Packs } from '../packs/packs.ts';
import type { Uploads } from '../packs/uploads.ts';
import type { RestartScheduler } from '../servers/restarts.ts';
import type { Restores } from '../backups/restore.ts';
import type { Services } from '../services/services.ts';
import type { ServerHub } from '../servers/servers.ts';
import type { Stats } from '../stats/stats.ts';

export type Env = { Variables: { user: SessionUser; session: string; permitted: boolean; body: Record<string, unknown> } };

/** What the API reads from; `db` only for its own sessions. The host, checks and services only when they are on. */
export type WebDeps = {
  db: Db;
  users: Users;
  roles: Roles;
  live: LiveFeed;
  hub: ServerHub;
  stats: Stats;
  restarts: RestartScheduler;
  lag: LagMonitor;
  /** Only with the checks integration. */
  checks?: Checks;
  /** Only with the host or agents integration: the hub's own Host and each Agent's. */
  hosts?: Hosts;
  /** Only with the agents integration: each Agent's Node, for its Host. */
  agents?: Agents;
  /** Only with the systemd integration. */
  services?: Services;
  /** Only with the systemd integration, and a server with a restore source: a folder and the restore script, or an Agent. */
  restores?: Restores;
  /** Only with the GitHub integration. */
  deploys?: Deploys;
  /** Only with the systemd and Minecraft integrations. */
  packs?: Packs;
  /** Only with the agents (and systemd) integrations. */
  gameUpdates?: GameUpdates;
  /** Only with the agents (and systemd) integrations. */
  gameSettings?: GameSettings;
  /** With game updates. */
  modUpdates?: ModUpdates;
  /** With game updates. */
  modsZip?: ModsZip;
  /** With the agents integration. */
  moderation?: Moderation;
  saveUploads?: SaveUploads;
  /** With packs. */
  uploads?: Uploads;
  /** With packs. */
  library?: Library;
  integrations: Config['integrations'];
};

/** The HTTP API under /api: logins, sessions, and every other route behind a session and its permissions. */
export function webApi(web: WebIntegration, { db, users, roles, live, hub, stats, restarts, lag, checks, hosts, agents, services, restores, deploys, packs, gameUpdates, modUpdates, modsZip, moderation, gameSettings, saveUploads, uploads, library, integrations }: WebDeps) {
  // New server installs a library pack (packs) with the Mod from GitHub's releases (deploys).
  const newServer = Boolean(packs && library && deploys);
  const app = new Hono<Env>().basePath('/api');

  publicRoutes(app, { status: web.status, hub, stats });
  authRoutes(app, web, { users, sessions: db.users, limit: new LoginLimit() });
  permitRoutes(app, (id) => services?.serverOf(id));
  usersRoutes(app, { users, roles, publicUrl: web.publicUrl });
  app.get('/integrations', (c) =>
    c.json({
      minecraft: !!integrations.minecraft,
      discord: !!integrations.discord,
      web: true,
      checks: !!integrations.checks,
      host: !!integrations.host,
      systemd: !!integrations.systemd,
      github: !!integrations.github,
      agents: !!integrations.agents,
      library: !!library,
      newServer,
    } satisfies Integrations),
  );
  if (deploys) deploysRoutes(app, { deploys, hub, integrations });
  if (checks) app.get('/checks', (c) => c.json(checks.list() satisfies CheckStatus[]));
  if (services) servicesRoutes(app, { services, actor });
  hostsRoutes(app, { hosts, agents, integrations });
  if (newServer) newServerRoutes(app, { packs });
  serversRoutes(app, { live, hub, stats, restarts, lag, services, packs, gameUpdates, gameSettings, saveUploads, integrations });
  // Restore needs the server down, so it comes before the online check below, with checks of its own.
  if (restores) restoreRoutes(app, { restores });
  // Packs work on a stopped server too (an update checks for itself), so they come before the online check below.
  packsRoutes(app, { uploads, library, packs });
  // Game updates start a stopped server too, so they come before the online check below.
  if (gameUpdates) gameUpdatesRoutes(app, { gameUpdates });
  gameExtrasRoutes(app, { modUpdates, modsZip, moderation, actor, body: (c) => jsonBody(c.req) });
  gameSettingsRoutes(app, { gameSettings, saveUploads });
  actionsRoutes(app, { hub, stats, restarts });
  eventsRoutes(app, { live, alive: (session) => sessionUser({ users, sessions: db.users }, session) !== undefined });
  return app;
}

export type WebApi = ReturnType<typeof webApi>;

/** Serves the API on 127.0.0.1 (0: any free port); resolves once listening. */
export function serveWebApi(app: WebApi, port: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) =>
      resolve({
        port: info.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            (server as Server).closeAllConnections(); // open event streams never end on their own
          }),
      }),
    );
    server.once('error', reject);
  });
}

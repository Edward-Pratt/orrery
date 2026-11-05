// The web API's reads without a session, registered by `webApi` before the login and the session check
// (`authRoutes`), so no cookie is read: `GET /api/environment` (`EnvironmentInfo`: the Environment's name only), and,
// with `integrations.web.status`, `GET /api/public/status` (`PublicStatus`: the listed servers, in order, built field
// by field, with `cache-control: public, max-age=15` and the answer kept 15 s, so a page left open on many phones
// reads uptime at most once per 15 s; no query string is read). Without the section the route isn't registered, so it
// falls to the session check like any unknown path (401 without a session).

import type { Hono } from 'hono';
import type { EnvironmentInfo, PublicServer, PublicState, PublicStatus } from '../api.ts';
import type { Config, WebIntegration } from '../config.ts';
import type { ServerHub, ServerState } from '../servers/servers.ts';
import type { Stats } from '../stats/stats.ts';
import type { Env } from './web.ts';

/** How long one Status page answer is kept and may be cached. */
const STATUS_MS = 15_000;

export type PublicDeps = { environment: Config['environment']; status: WebIntegration['status']; hub: ServerHub; stats: Stats };

/** A server's state as the Status page shows it. */
export function publicState(s: Pick<ServerState, 'online' | 'hung' | 'paused'>): PublicState {
  if (!s.online) return 'down';
  if (s.hung) return 'hung';
  return s.paused ? 'paused' : 'up';
}

/** One server for the Status page: each field picked on purpose, so a field added to the hub's state stays private. */
function publicServer(s: ServerState, stats: Stats, now: number): PublicServer {
  return {
    name: s.name,
    game: s.game,
    state: publicState(s),
    players: [...s.players],
    uptimeWeek: stats.uptime(s.id, 7, now),
    uptimeMonth: stats.uptime(s.id, 30, now),
  };
}

/** Registers the reads without a session on `app`. */
export function publicRoutes(app: Hono<Env>, { environment, status, hub, stats }: PublicDeps): void {
  app.get('/environment', (c) => c.json({ environment } satisfies EnvironmentInfo));
  if (!status) return;
  let kept: { at: number; answer: PublicStatus } | undefined;
  app.get('/public/status', (c) => {
    const now = Date.now();
    if (!kept || now - kept.at >= STATUS_MS) {
      const servers = status.servers.flatMap((id) => {
        const s = hub.get(id);
        return s ? [publicServer(s, stats, now)] : [];
      });
      kept = { at: now, answer: { servers } };
    }
    c.header('cache-control', `public, max-age=${STATUS_MS / 1000}`);
    return c.json(kept.answer satisfies PublicStatus);
  });
}

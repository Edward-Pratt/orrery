// `hostsRoutes`, registered by `webApi`: `/api/hosts` (every Host, the hub's own first, then each Agent's, its `node`
// from `Agents`) and `/api/hosts/:id/samples?hours=` (404 unknown id) with the host or agents on, and `/api/host` and
// `/api/host/samples?hours=`, the hub's own alone, only with the host on, kept for one release for an older
// dashboard; `hours` as `hoursOf` reads it (400 `BAD_HOURS` otherwise).

import type { Context, Hono } from 'hono';
import type { HostHistory, HostNow } from '../api.ts';
import type { HostMonitor } from '../agents/host.ts';
import { BAD_HOURS, hoursOf } from './request.ts';
import type { Env, WebDeps } from './web.ts';

/** Registers the Hosts' latest samples and history on `app`; each block only when its Host is there. */
export function hostsRoutes(app: Hono<Env>, { hosts, agents, integrations }: Pick<WebDeps, 'hosts' | 'agents' | 'integrations'>): void {
  const now = (h: HostMonitor): HostNow => ({ id: h.id, sample: h.latest(), node: agents?.get(h.id)?.node ?? null });
  const history = (h: HostMonitor, c: Context) => {
    const hours = hoursOf(c);
    return hours ? c.json(h.history(hours) satisfies HostHistory) : c.text(BAD_HOURS, 400);
  };
  if (hosts?.list().length) {
    app.get('/hosts', (c) => c.json(hosts.list().map(now) satisfies HostNow[]));
    app.get('/hosts/:id/samples', (c) => {
      const h = hosts.get(c.req.param('id'));
      return h ? history(h, c) : c.notFound();
    });
  }
  const host = integrations.host && hosts?.get(integrations.host.id);
  if (host) {
    // ponytail: the hub's own host, for a dashboard older than `/hosts`; drop a release after.
    app.get('/host', (c) => c.json(now(host)));
    app.get('/host/samples', (c) => history(host, c));
  }
}

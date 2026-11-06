// `servicesRoutes`, registered by `webApi` with the systemd integration on: `GET /api/services` (`ServiceStatus[]`),
// `GET /api/services/:id/logs` (`ServiceLogs`; 404 unlisted, 502 if journalctl, or the service's Agent, fails) and
// `POST /api/services/:id/start|stop|restart` (`ServiceActionAnswer`: when the action runs; 404 unlisted, 409 if a
// countdown is running, 502 if systemctl, or the service's Agent, fails), audited as the user.

import type { Hono } from 'hono';
import type { Me, ServiceActionAnswer, ServiceLogs, ServiceStatus } from '../api.ts';
import { CountdownRunning, VERBS, type Services } from '../services/services.ts';
import type { Env } from './web.ts';

/** Registers the services' list, logs and actions on `app`; `actor` names the user in the audit. */
export function servicesRoutes(app: Hono<Env>, { services, actor }: { services: Services; actor: (user: Me) => string }): void {
  app.get('/services', (c) => c.json(services.list() satisfies ServiceStatus[]));
  app.get('/services/:id/logs', async (c) => {
    try {
      const lines = await services.logs(c.req.param('id'));
      return lines ? c.json({ lines } satisfies ServiceLogs) : c.notFound();
    } catch (err) {
      return c.text(`journalctl failed: ${(err as Error).message}`, 502);
    }
  });
  for (const verb of VERBS) {
    app.post(`/services/:id/${verb}`, async (c) => {
      const id = c.req.param('id');
      if (!services.has(id)) return c.notFound();
      const user = c.get('user');
      try {
        return c.json({ at: await services.act(id, verb, actor(user), user.username) } satisfies ServiceActionAnswer);
      } catch (err) {
        if (err instanceof CountdownRunning) return c.text(`${err.message}: cancel it first.`, 409);
        return c.text(`systemctl failed: ${(err as Error).message}`, 502);
      }
    });
  }
}

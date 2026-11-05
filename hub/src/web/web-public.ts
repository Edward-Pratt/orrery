// The web API's reads without a session, registered by `webApi` before the login and the session check
// (`authRoutes`), so no cookie is read: `GET /api/environment` (`EnvironmentInfo`: the Environment's name only).

import type { Hono } from 'hono';
import type { EnvironmentInfo } from '../api.ts';
import type { Config } from '../config.ts';
import type { Env } from './web.ts';

/** Registers the reads without a session on `app`. */
export function publicRoutes(app: Hono<Env>, { environment }: { environment: Config['environment'] }): void {
  app.get('/environment', (c) => c.json({ environment } satisfies EnvironmentInfo));
}

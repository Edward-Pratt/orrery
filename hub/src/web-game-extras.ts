import type { Context, Hono } from 'hono';
import type { ModUpdatesState } from './api.ts';
import { GameRefused } from './factorio.ts';
import type { ModUpdates } from './mod-updates.ts';
import type { Env } from './web.ts';

/** A route's answer for a server the module has (else 404), its `GameRefused` as its status and text. */
async function answer(c: Context<Env>, has: (id: string) => boolean, fn: (id: string) => Promise<object>) {
  const id = c.req.param('id')!;
  if (!has(id)) return c.notFound();
  try {
    return c.json(await fn(id));
  } catch (err) {
    if (err instanceof GameRefused) return c.text(err.message, err.status);
    throw err;
  }
}

/**
 * A factorio server's portal mod updates (`GET …/game/updates`), registered by `webApi` before the online check:
 * they are read while the server is stopped too.
 */
export function gameExtrasRoutes(app: Hono<Env>, { modUpdates }: { modUpdates: ModUpdates }): void {
  app.get('/servers/:id/game/updates', (c) => answer(c, (id) => modUpdates.has(id), async (id) => (await modUpdates.state(id)) satisfies ModUpdatesState));
}

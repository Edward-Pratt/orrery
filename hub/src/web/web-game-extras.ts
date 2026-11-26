// `gameExtrasRoutes`, registered by `webApi` before the online check, each block only with its module on: `GET
// /api/servers/:id/game/updates` (`ModUpdatesState`) and `GET`/`POST /api/servers/:id/moderation` (`ModerationState`;
// `ModerateRequest` answering `ModerateAnswer`) and `GET /api/servers/:id/game/mods.zip` (`ModsZip`: the zip as an
// attachment, `<id>-mods.zip`, `no-store`: made afresh each time; HEAD 405), 404 for a server the module doesn't have, `GameRefused`'s status and text.

import type { Context, Hono } from 'hono';
import type { Me, ModerateAnswer, ModerationState, ModUpdatesState } from '../api.ts';
import { GameRefused } from '../updates/factorio.ts';
import type { Moderation } from '../servers/moderation.ts';
import type { ModUpdates } from '../updates/mod-updates.ts';
import type { ModsZip } from '../updates/mods-zip.ts';
import type { Env } from './web.ts';

/** A route's answer for a server the module has (else 404), its `GameRefused` as its status and text. */
async function answer(c: Context<Env>, has: (id: string) => boolean, fn: (id: string, user: Me) => Promise<object>) {
  const id = c.req.param('id')!;
  if (!has(id)) return c.notFound();
  try {
    const body = await fn(id, c.get('user'));
    return body instanceof Response ? body : c.json(body);
  } catch (err) {
    if (err instanceof GameRefused) return c.text(err.message, err.status);
    throw err;
  }
}

/**
 * A factorio server's portal mod updates (`GET …/game/updates`), its mods zip (`GET …/game/mods.zip`) and its players' moderation (`GET` and `POST
 * …/moderation`), each with its module on, registered by `webApi` before the online check: the lists are read while
 * the server is stopped too, and an action's refusal says why itself. `actor` names the user in the audit.
 */
export function gameExtrasRoutes(
  app: Hono<Env>,
  { modUpdates, modsZip, moderation, actor, body }: { modUpdates?: ModUpdates; modsZip?: ModsZip; moderation?: Moderation; actor: (user: Me) => string; body: (c: Context<Env>) => Promise<Record<string, unknown>> },
): void {
  if (modUpdates) {
    app.get('/servers/:id/game/updates', (c) => answer(c, (id) => modUpdates.has(id), async (id) => (await modUpdates.state(id)) satisfies ModUpdatesState));
  }
  if (modsZip) {
    // HEAD (routed here as GET) is refused: it would make the zip and never read it.
    app.get('/servers/:id/game/mods.zip', async (c) =>
      c.req.method === 'HEAD' ? c.body(null, 405, { allow: 'GET' }) : answer(c, (id) => modsZip.has(id), async (id) => {
        const file = `${id.replace(/[^A-Za-z0-9_-]/g, '_')}-mods.zip`;
        return new Response(await modsZip.open(id, c.req.raw.signal), { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store' } });
      }),
    );
  }
  if (moderation) {
    const has = (id: string) => moderation.has(id);
    app.get('/servers/:id/moderation', (c) => answer(c, has, async (id) => (await moderation.state(id)) satisfies ModerationState));
    app.post('/servers/:id/moderation', (c) => answer(c, has, async (id, user) => (await moderation.act(id, await body(c), actor(user))) satisfies ModerateAnswer));
  }
}

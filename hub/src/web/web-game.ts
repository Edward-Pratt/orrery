// A factorio server's game routes, registered by `webApi` before the online check, for a server an Agent runs (else
// 404), around `gameExtrasRoutes`. `gameUpdatesRoutes`, with game updates (agents and systemd on): `GET
// /api/servers/:id/game` (`GameState`), `POST …/game/catalog` (`GameCatalog`), `…/game/update` (202 `{ id }`) and
// `…/game/update/cancel` (204) (`GameRefused`'s status, its message as text), and the mod browser's reads, `GET
// …/game/mods?factorio=&q=&category=&sort=&page=` (`ModBrowse`; 400 for a bad parameter, 502 if the portal can't be
// read) and `GET …/game/mods/:name/thumbnail` (the PNG, `image/png` with `x-content-type-options: nosniff` and
// `cache-control: private, max-age=86400`; 404 with `private, max-age=3600` when it has none; 502 uncached), and the
// Import mod list's `POST …/game/check` (`{ factorio, names }`: `ModCheckAnswer`; 400 for a bad body, 502 if the
// portal's list can't be read). `gameSettingsRoutes`: with game settings (agents and systemd on), a separate block:
// `GET /api/servers/:id/settings` (`GameSettingsState`) and `PUT …/settings` (`GameSettingsRequest`, answering
// `GameSettingsAnswer`; `GameRefused`'s 400/409/502 as text); with save uploads, `POST /api/servers/:id/saves`
// (`SaveUploadRequest`: 202 `SaveUploadAnswer`; 404 for a server it doesn't have, `GameRefused`'s status as text).

import type { Context, Hono } from 'hono';
import type {
  GameCatalog,
  GameSettingsAnswer,
  GameSettingsState,
  GameState,
  GameUpdateAnswer,
  Me,
  ModBrowse,
  ModCheckAnswer,
  SaveUploadAnswer,
  SaveUploadRequest,
} from '../api.ts';
import { GameRefused } from '../updates/factorio.ts';
import type { GameUpdates } from '../updates/game-updates.ts';
import { actor, jsonBody } from './request.ts';
import type { Env, WebDeps } from './web.ts';

/** Registers the game update and mod browser routes on `app`. */
export function gameUpdatesRoutes(app: Hono<Env>, { gameUpdates }: { gameUpdates: GameUpdates }): void {
  /** Runs a game update action for a server an Agent runs, mapping its refusals to their status. */
  const game = async (c: Context<Env>, fn: (id: string, user: Me) => Promise<unknown>, status: 200 | 202 = 200) => {
    const id = c.req.param('id')!;
    if (!gameUpdates.has(id)) return c.notFound();
    try {
      const answer = await fn(id, c.get('user'));
      return answer === undefined ? c.body(null, 204) : c.json(answer as object, status);
    } catch (err) {
      if (err instanceof GameRefused) return c.text(err.message, err.status);
      throw err;
    }
  };
  app.get('/servers/:id/game', (c) => game(c, async (sid) => gameUpdates.state(sid) satisfies GameState));
  app.post('/servers/:id/game/catalog', (c) => game(c, async (sid) => (await gameUpdates.catalog(sid, await jsonBody(c.req))) satisfies GameCatalog));
  app.post('/servers/:id/game/update', (c) =>
    game(c, async (sid, user) => ({ id: await gameUpdates.update(sid, await jsonBody(c.req), actor(user), user.username) }) satisfies GameUpdateAnswer, 202),
  );
  app.post('/servers/:id/game/update/cancel', (c) => game(c, async (sid, user) => gameUpdates.cancel(sid, actor(user), user.username)));
  // The mod browser: reads of the mod portal, through the hub (the dashboard never talks to it).
  app.post('/servers/:id/game/check', (c) => game(c, async (sid) => (await gameUpdates.check(sid, await jsonBody(c.req))) satisfies ModCheckAnswer));
  app.get('/servers/:id/game/mods', (c) => game(c, async (sid) => (await gameUpdates.browse(sid, c.req.query())) satisfies ModBrowse));
  app.get('/servers/:id/game/mods/:name/thumbnail', async (c) => {
    const id = c.req.param('id');
    if (!gameUpdates.has(id)) return c.notFound();
    try {
      const image = await gameUpdates.thumbnail(id, c.req.param('name'));
      if (!image) return c.text('No thumbnail.', 404, { 'cache-control': 'private, max-age=3600' });
      // A checked PNG only, never sniffed as anything else; by name, so not immutable: a mod can change its thumbnail.
      return c.body(image, 200, { 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=86400' });
    } catch (err) {
      if (err instanceof GameRefused) return c.text(err.message, err.status);
      throw err;
    }
  });
}

/** Registers the game settings and the save upload routes on `app`, each block only with its module on. */
export function gameSettingsRoutes(app: Hono<Env>, { gameSettings, saveUploads }: Pick<WebDeps, 'gameSettings' | 'saveUploads'>): void {
  // Game settings are written while the server is stopped too, so they come before the online check (`webApi` registers them first).
  if (gameSettings) {
    /** Runs a game settings call for a server an Agent runs, mapping its refusals to their status. */
    const settings = async (c: Context<Env>, fn: (id: string, user: Me) => Promise<object>) => {
      const id = c.req.param('id')!;
      if (!gameSettings.has(id)) return c.notFound();
      try {
        return c.json(await fn(id, c.get('user')));
      } catch (err) {
        if (err instanceof GameRefused) return c.text(err.message, err.status);
        throw err;
      }
    };
    app.get('/servers/:id/settings', (c) => settings(c, async (sid) => gameSettings.state(sid) satisfies GameSettingsState));
    app.put('/servers/:id/settings', (c) =>
      settings(c, async (sid, user) => (await gameSettings.set(sid, await jsonBody(c.req), actor(user), user.username)) satisfies GameSettingsAnswer),
    );
  }
  // An uploaded save goes to a stopped server too, so before the online check (`webApi` registers it first).
  if (saveUploads) {
    app.post('/servers/:id/saves', async (c) => {
      const id = c.req.param('id');
      if (!saveUploads.has(id)) return c.notFound();
      try {
        const body = (await jsonBody(c.req)) as Partial<SaveUploadRequest>;
        return c.json(saveUploads.add(id, body.upload, actor(c.get('user'))) satisfies SaveUploadAnswer, 202);
      } catch (err) {
        if (err instanceof GameRefused) return c.text(err.message, err.status);
        throw err;
      }
    });
  }
}


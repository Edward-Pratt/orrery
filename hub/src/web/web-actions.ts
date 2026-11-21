// The actions on a server, audited as the user. `restoreRoutes`, with systemd whenever a server has a restore source
// (a folder and the restore script, or an Agent), registered by `webApi` before the online check: `POST
// /api/servers/:id/restore`, `Restores`' 404/409, 502 with the script's (or the Agent's) error. `actionsRoutes`,
// registered last but the event stream: the online check (`POST /api/servers/:id/*`: the body read first, 404 unknown,
// 409 offline), then `POST /api/servers/:id/chat` (a user with a Discord id that linked, named by their name in that
// server's game, `Stats.linkedPlayer`), `/command` (400 with why for a factorio server's over 256 characters,
// `CommandRefused`), `/restart`, `/restart/cancel`, `/backup` (`ServerHub.backup`: a Mod's `backup start`, a factorio
// server's save): 404 unknown, 409 offline, 400 bad input, 502 if the server doesn't answer.

import type { Context, Hono } from 'hono';
import type { CommandOutput } from '../api.ts';
import { RestoreRefused, type Restores } from '../backups/restore.ts';
import { CommandRefused, mcText } from '../servers/servers.ts';
import { actor, jsonBody } from './request.ts';
import type { Env, WebDeps } from './web.ts';

/** Registers a server's restore on `app`; before the online check, as it needs the server down. */
export function restoreRoutes(app: Hono<Env>, { restores }: { restores: Restores }): void {
  app.post('/servers/:id/restore', async (c) => {
    const name = (await jsonBody(c.req)).name;
    if (typeof name !== 'string') return c.text('Give a backup name', 400);
    try {
      const output = await restores.restore(c.req.param('id'), name, actor(c.get('user')));
      return c.json({ output: output.split('\n').filter((line) => line !== '') } satisfies CommandOutput);
    } catch (err) {
      if (err instanceof RestoreRefused) return c.text(err.message, err.status);
      return c.text(`The restore failed: ${(err as Error).message}`, 502);
    }
  });
}

/** Registers the online check and the chat, command, backup and restart actions behind it on `app`. */
export function actionsRoutes(app: Hono<Env>, { hub, stats, restarts }: Pick<WebDeps, 'hub' | 'stats' | 'restarts'>): void {
  // Actions: the server must be known and online. The body is read first, so each action runs on what was checked.
  app.post('/servers/:id/*', async (c, next) => {
    c.set('body', await jsonBody(c.req));
    const state = hub.get(c.req.param('id'));
    if (!state) return c.notFound();
    if (!state.online) return c.text(`${state.name} is offline`, 409);
    await next();
  });
  app.post('/servers/:id/chat', (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    const message = c.get('body').message;
    // A user with a linked Discord id appears in game under their name in that server's game, as from Discord.
    const author = (user.discordId && stats.linkedPlayer(id, user.discordId)) || user.username;
    if (typeof message !== 'string' || !hub.say(id, author, message, 'dashboard')) {
      return c.text('Give a message', 400);
    }
    hub.audit(actor(user), 'chat', id, mcText(message, 256));
    return c.body(null, 204);
  });
  const run = async (c: Context<Env>, command: unknown) => {
    try {
      if (typeof command !== 'string') throw new Error('empty command');
      return c.json({ output: await hub.runCommand(c.req.param('id')!, command, actor(c.get('user'))) } satisfies CommandOutput);
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'empty command') return c.text('Give a command', 400);
      if (err instanceof CommandRefused) return c.text(message, 400);
      return c.text(message, 502); // timed out, or the server went away
    }
  };
  // Output that comes later (spark's profiler link) goes on the event stream.
  app.post('/servers/:id/command', (c) => run(c, c.get('body').command));
  // A Mod's `backup start`, or a factorio server's save; the finished/failed notice follows on the event stream.
  app.post('/servers/:id/backup', async (c) => {
    try {
      return c.json({ output: await hub.backup(c.req.param('id'), actor(c.get('user'))) } satisfies CommandOutput);
    } catch (err) {
      return c.text((err as Error).message, 502); // timed out, or the server went away
    }
  });
  app.post('/servers/:id/restart', (c) => {
    const id = c.req.param('id');
    if (restarts.pending(id)) return c.text('A restart is already scheduled: cancel it first.', 409);
    try {
      restarts.schedule(id, c.get('body').minutes as number, actor(c.get('user')), c.get('user').username);
    } catch (err) {
      return c.text((err as Error).message, 400); // known, online, nothing pending: only bad minutes are left to throw
    }
    return c.body(null, 204);
  });
  app.post('/servers/:id/restart/cancel', (c) =>
    restarts.cancel(c.req.param('id'), actor(c.get('user')), c.get('user').username)
      ? c.body(null, 204)
      : c.text('No restart is scheduled.', 409),
  );
}

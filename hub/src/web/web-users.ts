// `usersRoutes`, registered by `webApi` after the permission rules: the Users page's API. `GET /api/users`
// (`UserView[]`), `POST /api/users` (`NewUserRequest`: the user and their invite link, `InviteAnswer`, shown this
// once), `PUT /api/users/:id` (`UserChange`, all or none; 204), `POST /api/users/:id/reset` (a new invite link,
// `InviteAnswer`), `POST /api/users/:id/logout` and `DELETE /api/users/:id` (204); `GET /api/roles` (`RoleView[]`),
// `POST /api/roles` and `PUT /api/roles/:id` (`RoleRequest`, answering the `RoleView`), `DELETE /api/roles/:id` (204);
// `GET /api/permissions` (`PermissionInfo[]`). Who may call each is `permit.ts`'s (`users`; role writes owners only);
// what one user may do to another (no one reaches above their own level) is `Users`'. `UsersRefused` and
// `RoleRefused` answer their status and text.

import type { Context, Hono } from 'hono';
import type { InviteAnswer, PermissionInfo, RoleView, UserView } from '../api.ts';
import { PERMISSIONS } from '../users/permissions.ts';
import { RoleRefused, type Roles } from '../users/roles.ts';
import { inviteLink, UsersRefused, type Users } from '../users/users.ts';
import { actor, jsonBody, usersActor } from './request.ts';
import type { Env } from './web.ts';

export type UsersDeps = { users: Users; roles: Roles; publicUrl: string };

/** Runs a Users or Roles call, its refusal as its status and text; an undefined answer is 204. */
async function answer(c: Context<Env>, fn: () => object | void | Promise<object | void>) {
  try {
    const out = await fn();
    return out === undefined ? c.body(null, 204) : c.json(out);
  } catch (err) {
    if (err instanceof UsersRefused || err instanceof RoleRefused) return c.text(err.message, err.status);
    throw err;
  }
}

/** Registers the users', roles' and permissions' routes on `app`. */
export function usersRoutes(app: Hono<Env>, { users, roles, publicUrl }: UsersDeps): void {
  const invite = ({ id, username, token }: { id: string; username: string; token: string }): InviteAnswer => ({ id, username, invite: inviteLink(publicUrl, token) });
  const by = (c: Context<Env>) => usersActor(c.get('user'));
  const id = (c: Context<Env>) => c.req.param('id')!;

  app.get('/users', (c) => c.json(users.list() satisfies UserView[]));
  app.post('/users', (c) => answer(c, async () => invite(users.invite(await jsonBody(c.req), by(c)))));
  app.put('/users/:id', (c) => answer(c, async () => users.update(id(c), await jsonBody(c.req), by(c))));
  app.post('/users/:id/reset', (c) => answer(c, () => invite(users.reset(id(c), by(c)))));
  app.post('/users/:id/logout', (c) => answer(c, () => users.endSessions(id(c), by(c))));
  app.delete('/users/:id', (c) => answer(c, () => users.remove(id(c), by(c))));

  app.get('/roles', (c) => c.json(roles.list() satisfies RoleView[]));
  app.post('/roles', (c) => answer(c, async () => roles.create(await jsonBody(c.req), actor(c.get('user'))) satisfies RoleView));
  app.put('/roles/:id', (c) => answer(c, async () => roles.update(id(c), await jsonBody(c.req), actor(c.get('user'))) satisfies RoleView));
  app.delete('/roles/:id', (c) => answer(c, () => roles.remove(id(c), actor(c.get('user')))));

  app.get('/permissions', (c) => c.json(PERMISSIONS satisfies readonly PermissionInfo[]));
}

// The permission each route needs (`RULES`: the appendix of `docs/notes/users.md`, as code), checked before any route
// (`permitRoutes`, registered by `webApi` right after the session check). Each rule registers with Hono's own router
// (`app.on(method, path, …)`), so a request meets exactly its route's rules and no route handler checks anything: a
// rule that passes marks the request permitted, one that fails answers 403 naming what is missing ("Needs
// servers.console on gtnh"). Then the default deny: a request other than GET or HEAD that no rule passed is 403, so a
// write added later is refused until it has a rule here. GET and HEAD (Hono routes HEAD as GET) need only the session,
// but for the reads a rule names: a server's log files (player IPs), a factorio server's game settings (its game
// password) and the audit log. A scoped permission is checked on the route's `:id` server; a service's on the server
// it is linked to (`Services.serverOf`), an unlinked one needing an unscoped grant. The dashboard hiding a button is
// never the check: this is.

import type { Context, Hono } from 'hono';
import { VERBS } from '../services/services.ts';
import { can, canAnywhere, type Permission } from '../users/permissions.ts';
import type { Env } from './web.ts';

/** What a rule needs: a permission (on the `:id` server, or the server the `:id` service is linked to), an owner, or the session alone. */
type Need = { permission: Permission; on?: 'server' | 'service' } | { either: Permission; orAnywhere: Permission } | 'owner' | 'session';
type Rule = readonly [method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, need: Need];

const server = (permission: Permission): Need => ({ permission, on: 'server' });
const unscoped = (permission: Permission): Need => ({ permission });
/** An upload is a pack zip (`library`) or a save (`servers.control`, on the server its `POST …/saves` names). */
const UPLOAD: Need = { either: 'library', orAnywhere: 'servers.control' };

const PACK = server('servers.pack');
const S = '/servers/:id';

export const RULES: readonly Rule[] = [
  ['POST', `${S}/chat`, server('servers.chat')],
  ['POST', `${S}/command`, server('servers.console')],
  ...(['restart', 'restart/cancel', 'backup', 'saves'] as const).map((a): Rule => ['POST', `${S}/${a}`, server('servers.control')]),
  ['POST', `${S}/restore`, server('servers.restore')],
  ['GET', `${S}/logs`, server('servers.logs')],
  ['GET', `${S}/logs/:name`, server('servers.logs')],
  ...(['compare', 'adopt', 'update', 'update/cancel', 'extras', 'edits', 'edits/preview'] as const).map((a): Rule => ['POST', `${S}/pack/${a}`, PACK]),
  ['PUT', `${S}/pack/runtime`, PACK],
  ['PUT', `${S}/pack/extras/:extra`, PACK],
  ['DELETE', `${S}/pack/extras/:extra`, PACK],
  ['PUT', `${S}/pack/edits/:edit`, PACK],
  ['DELETE', `${S}/pack/edits/:edit`, PACK],
  ...(['catalog', 'update', 'update/cancel', 'check'] as const).map((a): Rule => ['POST', `${S}/game/${a}`, PACK]),
  ['GET', `${S}/settings`, server('servers.settings')],
  ['PUT', `${S}/settings`, server('servers.settings')],
  ['POST', `${S}/moderation`, server('servers.moderation')],
  ...VERBS.map((v): Rule => ['POST', `/services/:id/${v}`, { permission: 'services.control', on: 'service' }]),
  ['GET', '/services/:id/logs', { permission: 'services.logs', on: 'service' }],
  ['POST', '/deploys', unscoped('deploys')],
  ['POST', '/deploys/check', unscoped('deploys')],
  ...(['/library/packs', '/library/cancel', '/library/runtimes', '/servers'] as const).map((p): Rule => ['POST', p, unscoped('library')]),
  ['DELETE', '/library/packs/:id', unscoped('library')],
  ['DELETE', '/library/runtimes/:name', unscoped('library')],
  ['DELETE', '/servers/pending/:id', unscoped('library')],
  ['POST', '/uploads', UPLOAD],
  ['GET', '/uploads/:upload', UPLOAD],
  ['PUT', '/uploads/:upload', UPLOAD],
  ['GET', '/audit', unscoped('audit')],
  ...(['/users', '/roles', '/permissions'] as const).map((p): Rule => ['GET', p, unscoped('users')]),
  ['POST', '/users', unscoped('users')],
  ['PUT', '/users/:id', unscoped('users')],
  ['DELETE', '/users/:id', unscoped('users')],
  ['POST', '/users/:id/reset', unscoped('users')],
  ['POST', '/users/:id/logout', unscoped('users')],
  ['POST', '/roles', 'owner'],
  ['PUT', '/roles/:id', 'owner'],
  ['DELETE', '/roles/:id', 'owner'],
  ['PUT', '/me/password', 'session'],
  ['POST', '/me/logout-all', 'session'],
  ['POST', '/logout', 'session'],
];

/** What `need` lacks for the request's user, as the 403's text; undefined when it is met. */
function missing(c: Context<Env>, need: Need, serverOf: (serviceId: string) => string | undefined): string | undefined {
  const { grants, owner } = c.get('user');
  if (need === 'session') return undefined;
  if (need === 'owner') return owner ? undefined : 'Needs an owner';
  if ('either' in need) {
    return can(grants, need.either) || canAnywhere(grants, need.orAnywhere) ? undefined : `Needs ${need.either}, or ${need.orAnywhere} on a server`;
  }
  const id = need.on === 'server' ? c.req.param('id') : need.on === 'service' ? serverOf(c.req.param('id')!) : undefined;
  return can(grants, need.permission, id) ? undefined : `Needs ${need.permission}${id === undefined ? '' : ` on ${id}`}`;
}

/** Registers every rule, then the default deny, on `app`; `serverOf` maps a service to its linked server. */
export function permitRoutes(app: Hono<Env>, serverOf: (serviceId: string) => string | undefined): void {
  for (const [method, path, need] of RULES) {
    app.on(method, path, async (c, next) => {
      const lacks = missing(c, need, serverOf);
      if (lacks) return c.text(lacks, 403);
      c.set('permitted', true);
      await next();
    });
  }
  app.use(async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.get('permitted')) return next();
    return c.text('No permission allows this request', 403);
  });
}

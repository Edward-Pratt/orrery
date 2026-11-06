// Web login and sessions (`authRoutes`, registered by `webApi` right after the reads without a session). First the
// CSRF check (Origin and a JSON content type on everything but GET/HEAD; an upload's chunk is raw bytes), so the login
// gets it too. Then, without a session: `POST /api/login` (`LoginRequest`: 204 and the `session` cookie; 401 "Wrong
// username or password" for an unknown name, a wrong password, a user without one and a disabled user alike; 429
// with `Retry-After` while `LoginLimit` locks the name from that address, or the address, and while `MAX_VERIFYING`
// password checks run, so a flood can't fill Node's thread pool), `GET /api/invites/:token` (`InviteInfo`; 404
// unknown, used or expired) and `POST /api/invites/:token` (`PasswordRequest`: `Users.acceptInvite`, then logged in as
// a login is). Then the session check every later route sits behind: the cookie's row, then its user, read afresh on
// every request (a missing or disabled user is 401, so a changed grant counts at once); `c.get('user')` is a
// `SessionUser`, `c.get('session')` the session's hash. Then the session's own routes: `GET /api/me` (`Me` only), `PUT
// /api/me/password` (`PasswordChange`: the current one checked, and limited, as a login is; the user's other sessions
// end), `POST /api/me/logout-all` and `POST /api/logout`. A login's address is the last `X-Forwarded-For` entry
// (Caddy's: the hub binds loopback, so the header is always Caddy's), else the socket's. Session ids are random, sent
// only in an httpOnly, Secure, SameSite=Lax cookie on `/api`, stored as `hashToken`, and expire after `sessionDays`.
// A login is one console line (a failure with its address); passwords are never logged.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { InviteInfo, Me } from '../api.ts';
import type { WebIntegration } from '../config.ts';
import type { LoginLimit } from '../users/login-limit.ts';
import { isOwner, permissionsOf } from '../users/permissions.ts';
import { hashToken, type UserRow, type UsersStore } from '../users/store.ts';
import { UsersRefused, type Users } from '../users/users.ts';
import { jsonBody, usersActor } from './request.ts';
import type { Env } from './web.ts';

export type AuthDeps = { users: Users; sessions: UsersStore; limit: LoginLimit };

const DAY_S = 24 * 60 * 60;
const COOKIE = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/api' } as const;
/** An upload's chunk: the one request that isn't JSON. */
const CHUNK = /^\/api\/uploads\/[^/]+$/;
/** Password checks at once, at most: each holds one of the 4 threads of Node's pool (files, DNS) for ~40 ms. */
export const MAX_VERIFYING = 2;
const WRONG = 'Wrong username or password';

/** The client's address: the last `X-Forwarded-For` entry (Caddy's), else the socket's. */
function addressOf(c: Context<Env>): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
  return forwarded || ((c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket.remoteAddress ?? 'unknown');
}

/** A name from a request, fit for one console line. */
const shown = (name: string) => JSON.stringify(name.slice(0, 64));

/** Registers the CSRF check, the login and invites, the session check and the session's own routes on `app`, in that order. */
export function authRoutes(app: Hono<Env>, web: WebIntegration, { users, sessions, limit }: AuthDeps): void {
  const origin = new URL(web.publicUrl).origin;
  // CSRF, with SameSite=Lax: a state-changing request must come from the dashboard, and be JSON (a cross-site form
  // can't send that without a CORS preflight, which is never answered).
  app.use(async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    if (c.req.header('origin') !== origin) return c.text('Wrong origin', 403);
    const type = c.req.header('content-type')?.split(';')[0]!.trim().toLowerCase();
    // The one exception: an upload's chunk is raw bytes (a cross-site form can't send that type either).
    const chunk = c.req.method === 'PUT' && CHUNK.test(c.req.path);
    if (type !== (chunk ? 'application/octet-stream' : 'application/json')) return c.text(chunk ? 'Send the chunk as application/octet-stream' : 'Send JSON', 415);
    await next();
  });

  const startSession = (c: Context<Env>, user: UserRow) => {
    const id = randomBytes(32).toString('base64url');
    sessions.addSession(hashToken(id), user.id, Date.now() + web.sessionDays * DAY_S * 1000);
    setCookie(c, 'session', id, { ...COOKIE, maxAge: web.sessionDays * DAY_S });
  };
  let verifying = 0;
  /**
   * Runs a password check of `name` from the request's address within the limits: a 429 while the pair or the address
   * is locked, or while `MAX_VERIFYING` checks run. The try counts as a failure before the check, so tries sent at
   * once can't all pass the lock; the caller forgives it on a success (`limit.clear`).
   */
  async function limited<T>(c: Context<Env>, name: string, check: () => Promise<T>): Promise<T | Response> {
    const address = addressOf(c);
    const wait = limit.locked(name, address);
    if (wait) return c.text(`Too many tries: wait ${Math.ceil(wait / 60)} min and try again`, 429, { 'retry-after': String(wait) });
    if (verifying >= MAX_VERIFYING) return c.text('The hub is busy: try again in a moment', 429, { 'retry-after': '1' });
    limit.fail(name, address);
    verifying++;
    try {
      return await check();
    } finally {
      verifying--;
    }
  }

  app.post('/login', async (c) => {
    const { username, password } = await jsonBody(c.req);
    const name = typeof username === 'string' ? username : '';
    const user = await limited(c, name, () => users.login(username, password));
    if (user instanceof Response) return user;
    if (!user) {
      console.log(`[web] a failed login as ${shown(name)} from ${addressOf(c)}`);
      return c.text(WRONG, 401);
    }
    limit.clear(name, addressOf(c));
    startSession(c, user);
    console.log(`[web] ${user.username} (${user.id}) logged in`);
    return c.body(null, 204);
  });
  app.get('/invites/:token', (c) => {
    const username = users.invitee(c.req.param('token'));
    return username ? c.json({ username } satisfies InviteInfo) : c.text('That invite is no longer valid', 404);
  });
  app.post('/invites/:token', async (c) => {
    try {
      const user = await users.acceptInvite(c.req.param('token'), (await jsonBody(c.req)).password);
      startSession(c, user); // after: accepting ends every earlier session of theirs
      console.log(`[web] ${user.username} (${user.id}) set a password from an invite and logged in`);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof UsersRefused) return c.text(err.message, err.status);
      throw err;
    }
  });

  app.use(async (c, next) => {
    const cookie = getCookie(c, 'session');
    const session = cookie ? hashToken(cookie) : undefined;
    const userId = session ? sessions.session(session) : undefined;
    const found = userId && users.resolve(userId);
    if (!session || !found || found.user.disabled) return c.text('Not logged in', 401);
    const { user, grants } = found;
    c.set('user', { id: user.id, username: user.username, owner: isOwner(grants), permissions: permissionsOf(grants), discordId: user.discordId, grants });
    c.set('session', session);
    await next();
  });
  app.get('/me', (c) => {
    const { id, username, owner, permissions } = c.get('user');
    return c.json({ id, username, owner, permissions } satisfies Me);
  });
  app.put('/me/password', async (c) => {
    const user = c.get('user');
    const { current, password } = await jsonBody(c.req);
    const outcome = await limited(c, user.username, async () => {
      try {
        await users.changePassword(user.id, current, password, c.get('session'));
      } catch (err) {
        if (err instanceof UsersRefused) return err;
        throw err;
      }
    });
    if (outcome instanceof Response) return outcome;
    if (outcome?.status !== 403) limit.clear(user.username, addressOf(c)); // the current password was right
    return outcome ? c.text(outcome.message, outcome.status) : c.body(null, 204);
  });
  app.post('/me/logout-all', (c) => {
    users.endSessions(c.get('user').id, usersActor(c.get('user')));
    deleteCookie(c, 'session', COOKIE);
    return c.body(null, 204);
  });
  app.post('/logout', (c) => {
    sessions.deleteSession(c.get('session'));
    deleteCookie(c, 'session', COOKIE);
    return c.body(null, 204);
  });
}

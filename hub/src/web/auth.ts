// Web login and sessions (`authRoutes`, registered by `webApi` right after `GET /api/environment`): Discord OAuth for
// admin-role members (`OAuth`, real `discordOAuth`), `GET /api/login` and `GET /api/callback` (a single-use `state`
// cookie; a failed login redirects to `/?login=admin|state|discord` for the dashboard's login card), sessions in
// SQLite (stored hashed, with the Discord avatar hash, and the access token sealed with the session id), the session
// check every later route sits behind (re-asking Discord for the admin role every 10 minutes, in the background), the
// CSRF check (Origin and a JSON content type on everything but GET/HEAD; an upload's chunk is raw bytes), then `GET
// /api/me` (`id`, `username`, `avatar`) and `POST /api/logout`.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Me } from '../api.ts';
import type { WebIntegration } from '../config.ts';
import type { Db } from '../stats/db.ts';
import type { Env } from './web.ts';

/** A user's membership in a guild. */
export type Member = { id: string; username: string; avatar: string | null; roles: string[] };

/** The Discord OAuth endpoints the login uses, passed in so tests need no network. */
export type OAuth = {
  /** Exchanges a callback's code for an access token. */
  token: (code: string, redirectUri: string) => Promise<string>;
  /** The token's user in a guild; undefined if they are not a member. */
  member: (accessToken: string, guildId: string) => Promise<Member | undefined>;
};

const DAY_S = 24 * 60 * 60;
const COOKIE = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/api' } as const;
/** Sessions are stored hashed, so a copy of the database logs nobody in. */
const hash = (id: string) => createHash('sha256').update(id).digest('hex');
/** How often a session's admin role is asked of Discord again, so one taken away ends the session. */
const RECHECK_MS = 10 * 60_000;

/** A session's Discord access token, sealed with a key from its cookie: like the session, unreadable from a database copy. */
const sealKey = (session: string) => createHash('sha256').update(`token:${session}`).digest();
function seal(token: string, session: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(session), iv);
  const sealed = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64');
}
function unseal(sealed: string, session: string): string {
  const b = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', sealKey(session), b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8');
}

/** An upload's chunk: the one request that isn't JSON. */
const CHUNK = /^\/api\/uploads\/[^/]+$/;

/** Registers the login, the session and CSRF checks and the session's own routes on `app`, in that order. */
export function authRoutes(app: Hono<Env>, web: WebIntegration, oauth: OAuth, db: Db): void {
  const redirectUri = new URL('/api/callback', web.publicUrl).href;
  const origin = new URL(web.publicUrl).origin;
  app.get('/login', (c) => {
    const state = randomBytes(16).toString('base64url');
    setCookie(c, 'state', state, { ...COOKIE, maxAge: 600 });
    const params = new URLSearchParams({
      client_id: web.clientId,
      response_type: 'code',
      scope: 'identify guilds.members.read',
      redirect_uri: redirectUri,
      state,
    });
    return c.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get('/callback', async (c) => {
    const state = getCookie(c, 'state');
    deleteCookie(c, 'state', COOKIE); // one use
    const code = c.req.query('code');
    // a failed login goes back to the dashboard's login card, which says why
    const failed = (why: 'state' | 'discord' | 'admin') => c.redirect(new URL(`/?login=${why}`, web.publicUrl).href);
    if (!state || c.req.query('state') !== state || !code) return failed('state');
    let member: Member | undefined;
    let token: string;
    try {
      token = await oauth.token(code, redirectUri);
      member = await oauth.member(token, web.guildId);
    } catch (err) {
      console.error('[web] Discord login failed:', (err as Error).message);
      return failed('discord');
    }
    if (!member?.roles.includes(web.adminRoleId)) return failed('admin');
    const id = randomBytes(32).toString('base64url');
    db.addWebSession(hash(id), member.id, member.username, member.avatar, Date.now() + web.sessionDays * DAY_S * 1000);
    db.setWebSessionCheck(hash(id), seal(token, id), Date.now());
    setCookie(c, 'session', id, { ...COOKIE, maxAge: web.sessionDays * DAY_S });
    console.log(`[web] ${member.username} (${member.id}) logged in`);
    return c.redirect(new URL('/', web.publicUrl).href);
  });

  /**
   * Asks Discord again whether a session's user still has the admin role; ends the session if not (or if Discord no
   * longer takes the token). Discord being unreachable keeps it: the next check asks again.
   */
  const recheck = async (id: string, session: string, sealed: string, user: Me) => {
    let member: Member | undefined;
    try {
      member = await oauth.member(unseal(sealed, session), web.guildId);
    } catch (err) {
      console.error(`[web] re-checking ${user.username} (${user.id}) failed:`, (err as Error).message);
      return;
    }
    if (member?.roles.includes(web.adminRoleId)) return;
    db.deleteWebSession(id);
    const why = member ? 'lost the admin role' : 'not in the guild, or Discord refused the token';
    console.log(`[web] ${user.username} (${user.id}) is no longer an admin (${why}): logged out`);
  };
  app.use(async (c, next) => {
    const session = getCookie(c, 'session');
    const id = session && hash(session);
    const user = id ? db.webSession(id) : undefined;
    if (!id || !user) return c.text('Not logged in', 401);
    // ponytail: sessions from before re-checks have no row and run to their expiry unchecked.
    const check = db.webSessionCheck(id);
    if (check && Date.now() - check.checked >= RECHECK_MS) {
      db.markWebSessionChecked(id, Date.now()); // first, so concurrent requests ask Discord once
      void recheck(id, session!, check.token, user); // in the background: this request goes on, the next one sees the outcome
    }
    c.set('user', user);
    await next();
  });
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
  app.get('/me', (c) => c.json(c.get('user') satisfies Me));
  app.post('/logout', (c) => {
    db.deleteWebSession(hash(getCookie(c, 'session')!));
    deleteCookie(c, 'session', COOKIE);
    return c.body(null, 204);
  });
}

/** The real Discord OAuth endpoints; the client secret stays in here. */
export function discordOAuth(clientId: string, clientSecret: string): OAuth {
  const API = 'https://discord.com/api/v10';
  const call = (url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const json = async (what: string, res: Response) => {
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
    return res.json() as Promise<Record<string, any>>;
  };
  return {
    token: async (code, redirectUri) => {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      });
      const res = await call(`${API}/oauth2/token`, { method: 'POST', body });
      return (await json('token exchange', res)).access_token as string;
    },
    member: async (accessToken, guildId) => {
      const res = await call(`${API}/users/@me/guilds/${guildId}/member`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 404) return undefined; // not in the guild
      if (res.status === 401) return undefined; // the token was revoked or expired: no longer known as a member
      const m = await json('guild member', res);
      return { id: m.user.id, username: m.user.username, avatar: m.user.avatar ?? null, roles: m.roles };
    },
  };
}

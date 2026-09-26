import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import type { WebIntegration } from './config.ts';
import type { Db } from './db.ts';
import type { LiveFeed } from './live.ts';
import type { HubEvent } from './servers.ts';

/** A user's membership in a guild. */
export type Member = { id: string; username: string; roles: string[] };

/** The Discord OAuth endpoints the login uses, passed in so tests need no network. */
export type OAuth = {
  /** Exchanges a callback's code for an access token. */
  token: (code: string, redirectUri: string) => Promise<string>;
  /** The token's user in a guild; undefined if they are not a member. */
  member: (accessToken: string, guildId: string) => Promise<Member | undefined>;
};

const DAY_S = 24 * 60 * 60;
/** Keeps proxies from closing an idle event stream. */
const KEEP_ALIVE_MS = 25_000;
const COOKIE = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/api' } as const;
/** Sessions are stored hashed, so a copy of the database logs nobody in. */
const hash = (id: string) => createHash('sha256').update(id).digest('hex');

/** The HTTP API under /api: Discord login for admins, sessions, and every other route behind a session. */
export function webApi(db: Db, web: WebIntegration, oauth: OAuth, live: LiveFeed) {
  const redirectUri = new URL('/api/callback', web.publicUrl).href;
  const app = new Hono<{ Variables: { user: { id: string; username: string } } }>().basePath('/api');

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
    if (!state || c.req.query('state') !== state || !code) return c.text('Login failed (bad state): try again.', 400);
    let member: Member | undefined;
    try {
      member = await oauth.member(await oauth.token(code, redirectUri), web.guildId);
    } catch (err) {
      console.error('[web] Discord login failed:', (err as Error).message);
      return c.text('Login failed: Discord did not answer. Try again.', 502);
    }
    if (!member?.roles.includes(web.adminRoleId)) return c.text('You are not allowed in: the dashboard is for admins.', 403);
    const id = randomBytes(32).toString('base64url');
    db.addWebSession(hash(id), member.id, member.username, Date.now() + web.sessionDays * DAY_S * 1000);
    setCookie(c, 'session', id, { ...COOKIE, maxAge: web.sessionDays * DAY_S });
    console.log(`[web] ${member.username} (${member.id}) logged in`);
    return c.redirect(new URL('/', web.publicUrl).href);
  });

  app.use(async (c, next) => {
    const session = getCookie(c, 'session');
    const user = session ? db.webSession(hash(session)) : undefined;
    if (!user) return c.text('Not logged in', 401);
    c.set('user', user);
    await next();
  });
  app.get('/me', (c) => c.json(c.get('user')));
  app.post('/logout', (c) => {
    db.deleteWebSession(hash(getCookie(c, 'session')!));
    deleteCookie(c, 'session', COOKIE);
    return c.body(null, 204);
  });
  // Every hub event, live: first the buffered ones after Last-Event-ID (all of them without it), then new ones.
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (id: number, e: HubEvent) => stream.writeSSE({ id: String(id), data: JSON.stringify(e) });
      const onEvent = (id: number, e: HubEvent) => void send(id, e);
      // ponytail: a client that stops reading queues events in memory until its connection drops.
      for (const [id, e] of live.since(Number(c.req.header('last-event-id')) || 0)) void send(id, e);
      live.on('event', onEvent);
      const keepAlive = setInterval(() => void stream.write(': keep-alive\n\n'), KEEP_ALIVE_MS);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(keepAlive);
      live.off('event', onEvent);
    }),
  );
  return app;
}

export type WebApi = ReturnType<typeof webApi>;

/** Serves the API on 127.0.0.1 (0: any free port); resolves once listening. */
export function serveWebApi(app: WebApi, port: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) =>
      resolve({
        port: info.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            (server as Server).closeAllConnections(); // open event streams never end on their own
          }),
      }),
    );
    server.once('error', reject);
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
      const m = await json('guild member', res);
      return { id: m.user.id, username: m.user.username, roles: m.roles };
    },
  };
}

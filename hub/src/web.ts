import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import type { AuditLog, CommandOutput, Integrations, Me, PlayerAnswer, ServerCard, ServerDetail } from './api.ts';
import type { Config, WebIntegration } from './config.ts';
import type { Db } from './db.ts';
import type { LiveFeed } from './live.ts';
import type { RestartScheduler } from './restarts.ts';
import { mcText, type HubEvent, type ServerHub, type ServerState } from './servers.ts';
import type { Stats } from './stats.ts';

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

const AUDIT_LIMIT = 200;

/** A request's JSON object body; undefined if it isn't one. */
async function jsonBody(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown> | undefined> {
  const body = await req.json().catch(() => undefined);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

/** What the API reads from; `db` only for its own sessions. */
export type WebDeps = {
  db: Db;
  live: LiveFeed;
  hub: ServerHub;
  stats: Stats;
  restarts: RestartScheduler;
  integrations: Config['integrations'];
};

/** The HTTP API under /api: Discord login for admins, sessions, and every other route behind a session. */
export function webApi(web: WebIntegration, oauth: OAuth, { db, live, hub, stats, restarts, integrations }: WebDeps) {
  // Chat, TPS and quests come from the mod, so only a server with a mod token has them.
  const hasMod = (id: string) => Boolean(integrations.minecraft?.tokens[id]);
  const card = (s: ServerState, status = stats.status(s.id)!): ServerCard => ({
    id: s.id,
    name: s.name,
    online: s.online,
    hung: s.hung,
    tps: hasMod(s.id) ? s.tps : null,
    players: s.players,
    uptimeDay: status.uptimeDay,
    restart: restarts.pending(s.id) ?? null,
    features: { chat: hasMod(s.id), tps: hasMod(s.id), quests: hasMod(s.id) },
  });
  const redirectUri = new URL('/api/callback', web.publicUrl).href;
  const origin = new URL(web.publicUrl).origin;
  const app = new Hono<{ Variables: { user: { id: string; username: string } } }>().basePath('/api');
  const actor = (user: Me) => `web:${user.username} (${user.id})`;

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
  // CSRF, with SameSite=Lax: a state-changing request must come from the dashboard, and be JSON (a cross-site form
  // can't send that without a CORS preflight, which is never answered).
  app.use(async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    if (c.req.header('origin') !== origin) return c.text('Wrong origin', 403);
    if (c.req.header('content-type')?.split(';')[0]!.trim().toLowerCase() !== 'application/json') {
      return c.text('Send JSON', 415);
    }
    await next();
  });
  app.get('/me', (c) => c.json(c.get('user') satisfies Me));
  app.post('/logout', (c) => {
    db.deleteWebSession(hash(getCookie(c, 'session')!));
    deleteCookie(c, 'session', COOKIE);
    return c.body(null, 204);
  });
  app.get('/integrations', (c) =>
    c.json({ minecraft: !!integrations.minecraft, discord: !!integrations.discord, web: true } satisfies Integrations),
  );
  app.get('/servers', (c) => c.json(hub.list().map((s) => card(s)) satisfies ServerCard[]));
  app.get('/servers/:id', async (c) => {
    const id = c.req.param('id');
    const state = hub.get(id);
    if (!state) return c.notFound();
    const status = stats.status(id)!;
    return c.json({
      card: card(state, status),
      status,
      tps: hasMod(id) ? stats.tps(id)! : null,
      top: { day: stats.top(id, 'day')!, week: stats.top(id, 'week')!, all: stats.top(id, 'all')! },
      backups: (await stats.backups(id))!,
    } satisfies ServerDetail);
  });
  app.get('/servers/:id/players/:name', (c) => {
    const answer = stats.playtime(c.req.param('id'), { player: c.req.param('name') });
    // Never seen: an unknown name, not a player with no playtime.
    if (!answer || (answer.found && answer.lastSeen === null)) return c.notFound();
    return c.json(answer satisfies PlayerAnswer);
  });
  app.get('/audit', (c) => {
    const server = c.req.query('server');
    if (server !== undefined && !hub.get(server)) return c.notFound();
    return c.json(stats.audit(AUDIT_LIMIT, server) satisfies AuditLog);
  });
  // Actions: the server must be known and online.
  app.post('/servers/:id/*', async (c, next) => {
    const state = hub.get(c.req.param('id'));
    if (!state) return c.notFound();
    if (!state.online) return c.text(`${state.name} is offline`, 409);
    await next();
  });
  app.post('/servers/:id/chat', async (c) => {
    const id = c.req.param('id');
    const user = c.get('user');
    const message = (await jsonBody(c.req))?.message;
    // Linked people appear in game under their Minecraft name, as from Discord.
    if (typeof message !== 'string' || !hub.say(id, stats.linkedPlayer(user.id) ?? user.username, message)) {
      return c.text('Give a message', 400);
    }
    hub.audit(actor(user), 'chat', id, mcText(message, 256));
    return c.body(null, 204);
  });
  const run = async (id: string, command: string, by: string) => {
    try {
      return { output: await hub.runCommand(id, command, by) } satisfies CommandOutput;
    } catch (err) {
      return (err as Error).message; // timed out, or the server went away
    }
  };
  app.post('/servers/:id/command', async (c) => {
    const command = (await jsonBody(c.req))?.command;
    if (typeof command !== 'string' || !command.trim().replace(/^\//, '')) {
      return c.text('Give a command', 400);
    }
    // Output that comes later (spark's profiler link) goes on the event stream.
    const result = await run(c.req.param('id'), command, actor(c.get('user')));
    return typeof result === 'string' ? c.text(result, 502) : c.json(result);
  });
  app.post('/servers/:id/backup', async (c) => {
    // The finished/failed notice follows on the event stream, from the mod's backup event.
    const result = await run(c.req.param('id'), 'backup start', actor(c.get('user')));
    return typeof result === 'string' ? c.text(result, 502) : c.json(result);
  });
  app.post('/servers/:id/restart', async (c) => {
    const id = c.req.param('id');
    if (restarts.pending(id)) return c.text('A restart is already scheduled: cancel it first.', 409);
    const minutes = (await jsonBody(c.req))?.minutes;
    try {
      restarts.schedule(id, minutes as number, actor(c.get('user')), c.get('user').username);
    } catch (err) {
      return c.text((err as Error).message, 400); // only bad minutes are left to throw
    }
    return c.body(null, 204);
  });
  app.post('/servers/:id/restart/cancel', (c) =>
    restarts.cancel(c.req.param('id'), actor(c.get('user')), c.get('user').username)
      ? c.body(null, 204)
      : c.text('No restart is scheduled.', 409),
  );
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

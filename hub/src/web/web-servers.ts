// `serversRoutes`, registered by `webApi` after the New server routes (so "pending" isn't taken for an id): the
// servers' reads and the audit log, none audited. `/api/servers` cards (with `lagging` and the linked service's id and
// state); `/api/servers/:id` status, TPS, top per period, backups, `logs` (it has a folder, or an Agent runs it);
// `/api/servers/:id/logs` (`Stats.logs`, newest first; 502 if its Agent can't answer) and
// `/api/servers/:id/logs/:name` (the last 1000 lines, `{ lines }` as a service's logs; a name not in the listing, so
// `..`, slashes and symlinks too, is 404; 502 if the file can't be read or the Agent can't answer), 404 for an unknown
// server or one with neither a folder nor an Agent, not audited; `/api/servers/:id/players/:name`, 404 if never seen;
// `/api/servers/:id/history?hours=` with `asOf`, the newest event id, so the dashboard skips replayed events already
// counted; `/api/audit[?server=][&actor=][&before=id]`, a batch of 200 newest first with `older` (`before` is an
// entry's `id`, paged by (ts, rowid); 400 if not an id); unknown server ids 404; features per server: chat, TPS and
// the console (and TPS itself) over a game connection, so for a server with a mod token or one an Agent runs, quests
// only with a mod token, `update` for a server an Agent runs while game updates are on (`GameUpdates`),
// `features.settings` with game settings; the card's `paused` from `ServerState`.

import type { Hono } from 'hono';
import type { AuditLog, PlayerAnswer, ServerCard, ServerDetail, ServerHistory, ServerLog, ServerLogFiles } from '../api.ts';
import { rateOf } from '../servers/lag.ts';
import type { ServerState } from '../servers/servers.ts';
import { BAD_HOURS, hoursOf } from './request.ts';
import type { Env, WebDeps } from './web.ts';

const AUDIT_LIMIT = 200;

export type ServersDeps = Pick<
  WebDeps,
  'live' | 'hub' | 'stats' | 'restarts' | 'lag' | 'services' | 'packs' | 'gameUpdates' | 'gameSettings' | 'saveUploads' | 'integrations'
>;

/** Registers the servers' cards, details, logs, history and players, and the audit log, on `app`. */
export function serversRoutes(app: Hono<Env>, { live, hub, stats, restarts, lag, services, packs, gameUpdates, gameSettings, saveUploads, integrations }: ServersDeps): void {
  // Chat, TPS and quests come from the mod, so only a server with a mod token has them.
  const hasMod = (id: string) => Boolean(integrations.minecraft?.tokens[id]);
  // A factorio server is run by an Agent (its `server`).
  const agentServed = (id: string) => Boolean(integrations.agents?.agents.some((a) => a.server === id));
  // Chat, a rate (from heartbeats) and the console come over a game connection: the Mod's, or an Agent's.
  const connects = (id: string) => hasMod(id) || agentServed(id);
  const card = (s: ServerState, status = stats.status(s.id)!): ServerCard => {
    const linked = services?.ofServer(s.id);
    return {
      id: s.id,
      name: s.name,
      game: s.game,
      rate: rateOf(s.game),
      online: s.online,
      hung: s.hung,
      paused: s.paused,
      tps: connects(s.id) ? s.tps : null,
      players: s.players,
      uptimeDay: status.uptimeDay,
      restart: restarts.pending(s.id) ?? null,
      lagging: lag.isLagging(s.id),
      service: linked ? { id: linked.id, state: linked.state } : null,
      features: { chat: connects(s.id), tps: connects(s.id), quests: hasMod(s.id), console: connects(s.id), update: Boolean(gameUpdates?.has(s.id)), settings: Boolean(gameSettings?.has(s.id)), upload: Boolean(saveUploads?.has(s.id)) },
      packUpdate: packs?.has(s.id) ? { running: packs.busy(s.id), rolledBack: packs.rollback(s.id) } : null,
    };
  };
  app.get('/servers', (c) => c.json(hub.list().map((s) => card(s)) satisfies ServerCard[]));
  app.get('/servers/:id', async (c) => {
    const id = c.req.param('id');
    const state = hub.get(id);
    if (!state) return c.notFound();
    const status = stats.status(id)!;
    return c.json({
      card: card(state, status),
      service: services?.ofServer(id) ?? null,
      status,
      tps: connects(id) ? stats.tps(id)! : null,
      top: { day: stats.top(id, 'day')!, week: stats.top(id, 'week')!, all: stats.top(id, 'all')! },
      backups: (await stats.backups(id))!,
      pack: packs?.has(id) ?? false,
      logs: stats.hasLogs(id),
    } satisfies ServerDetail);
  });
  // Reads, so not audited. A file is only ever one of the listing's names, never a path from the request.
  app.get('/servers/:id/logs', async (c) => {
    try {
      const files = await stats.logs(c.req.param('id'));
      return files ? c.json(files satisfies ServerLogFiles) : c.notFound();
    } catch (err) {
      return c.text(`Listing the logs failed: ${(err as Error).message}`, 502); // an Agent's, which can't answer
    }
  });
  app.get('/servers/:id/logs/:name', async (c) => {
    const name = c.req.param('name');
    try {
      const lines = await stats.log(c.req.param('id'), name);
      return lines ? c.json({ lines } satisfies ServerLog) : c.notFound();
    } catch (err) {
      return c.text(`Reading ${name} failed: ${(err as Error).message}`, 502);
    }
  });
  app.get('/servers/:id/history', (c) => {
    const id = c.req.param('id');
    if (!hub.get(id)) return c.notFound();
    const hours = hoursOf(c);
    if (!hours) return c.text(BAD_HOURS, 400);
    const asOf = live.lastId; // read first: an event after it may or may not be in the history, so it is replayed
    return c.json({ ...stats.history(id, hours, connects(id))!, asOf } satisfies ServerHistory);
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
    const before = c.req.query('before');
    if (before !== undefined && !/^[1-9]\d{0,15}$/.test(before)) return c.text('before must be an entry id', 400);
    const filter = { target: server, actor: c.req.query('actor'), before: before === undefined ? undefined : Number(before) };
    return c.json(stats.audit(AUDIT_LIMIT, filter) satisfies AuditLog);
  });
}

// `eventsRoutes`, registered last by `webApi`: `GET /api/events` (SSE: `LiveFeed`'s buffer after `Last-Event-ID`,
// then live events), one `LiveFeed` listener per open stream, removed when it closes. Every `tickMs` (25 s) the
// stream re-checks its session (`alive`: the row unexpired, its user there and enabled) and closes once it has ended
// (a logout, Log out everywhere, a disabled or deleted user, an expiry), so an open tab stops getting chat, console
// output and notices; the browser's reconnect then gets the 401. Else the tick sends a keep-alive comment, so proxies
// don't close an idle stream.

import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { FeedEvent } from '../servers/servers.ts';
import type { LiveFeed } from '../stats/live.ts';
import type { Env } from './web.ts';

/** How often an open stream re-checks its session, and sends a keep-alive while it holds. */
export const STREAM_TICK_MS = 25_000;

export type EventsDeps = {
  live: LiveFeed;
  /** Whether the session (its hash, `c.get('session')`) still logs its user in. */
  alive: (session: string) => boolean;
  tickMs?: number;
};

/** Registers the event stream on `app`. */
export function eventsRoutes(app: Hono<Env>, { live, alive, tickMs = STREAM_TICK_MS }: EventsDeps): void {
  // Every hub event, live: first the buffered ones after Last-Event-ID (all of them without it), then new ones.
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const session = c.get('session');
      const send = (id: number, e: FeedEvent) => stream.writeSSE({ id: String(id), data: JSON.stringify(e) });
      const onEvent = (id: number, e: FeedEvent) => void send(id, e);
      // ponytail: a client that stops reading queues events in memory until its connection drops.
      for (const [id, e] of live.since(Number(c.req.header('last-event-id')) || 0)) void send(id, e);
      live.on('event', onEvent);
      let tick: ReturnType<typeof setInterval> | undefined;
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
        tick = setInterval(() => (alive(session) ? void stream.write(': keep-alive\n\n') : resolve()), tickMs);
      });
      clearInterval(tick);
      live.off('event', onEvent);
    }),
  );
}

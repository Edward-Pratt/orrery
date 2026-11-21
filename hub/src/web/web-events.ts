// `eventsRoutes`, registered last by `webApi`: `GET /api/events` (SSE: `LiveFeed`'s buffer after `Last-Event-ID`,
// then live events; keep-alive comments every 25 s), one `LiveFeed` listener per open stream, removed when it closes.

import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { FeedEvent } from '../servers/servers.ts';
import type { LiveFeed } from '../stats/live.ts';
import type { Env } from './web.ts';

/** Keeps proxies from closing an idle event stream. */
const KEEP_ALIVE_MS = 25_000;

/** Registers the event stream on `app`. */
export function eventsRoutes(app: Hono<Env>, { live }: { live: LiveFeed }): void {
  // Every hub event, live: first the buffered ones after Last-Event-ID (all of them without it), then new ones.
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (id: number, e: FeedEvent) => stream.writeSSE({ id: String(id), data: JSON.stringify(e) });
      const onEvent = (id: number, e: FeedEvent) => void send(id, e);
      // ponytail: a client that stops reading queues events in memory until its connection drops.
      for (const [id, e] of live.since(Number(c.req.header('last-event-id')) || 0)) void send(id, e);
      live.on('event', onEvent);
      const keepAlive = setInterval(() => void stream.write(': keep-alive\n\n'), KEEP_ALIVE_MS);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(keepAlive);
      live.off('event', onEvent);
    }),
  );
}

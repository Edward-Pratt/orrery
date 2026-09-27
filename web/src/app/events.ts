import { inject, Injectable, InjectionToken } from '@angular/core';
import type { HubEvent, LiveEvent, Target, TargetEvent } from '@hub/api';
import { Observable } from 'rxjs';
import { Session } from './session';

/** The fetch the event stream uses; a test passes a fake backend. */
export const FETCH = new InjectionToken<typeof fetch>('fetch', { factory: () => fetch.bind(globalThis) });
/** How long to wait before reconnecting a dropped stream. */
export const RETRY_MS = new InjectionToken<number>('retry', { factory: () => 3_000 });

/** A hub event with its stream id. */
export type Live = { id: number; event: LiveEvent };

/** A server's own events: never the host's, a service's or a check's, even one with the same id. */
export const ofServer =
  (serverId: string) =>
  (live: Live): live is { id: number; event: HubEvent } =>
    'serverId' in live.event && live.event.serverId === serverId;

/** Events about the host, services or checks (`target`), never a server's. */
export const ofTarget =
  (target: Target) =>
  (live: Live): live is { id: number; event: TargetEvent } =>
    'target' in live.event && live.event.target === target;

/**
 * The hub's live event stream (`GET /api/events`). Fetch rather than EventSource, so a reconnect after any drop,
 * hub restarts included, can send Last-Event-ID itself.
 */
@Injectable({ providedIn: 'root' })
export class LiveEvents {
  readonly #fetch = inject(FETCH);
  readonly #retryMs = inject(RETRY_MS);
  readonly #session = inject(Session);

  /**
   * Each subscription opens its own stream: first the hub's replay of recent events, then live ones. After a drop it
   * reconnects and resumes after the last id seen, without gaps or duplicates. Ends when the session does (401).
   */
  readonly all$ = new Observable<Live>((sub) => {
    const abort = new AbortController();
    let lastId = 0;
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const res = await this.#fetch('/api/events', {
            headers: lastId ? { 'last-event-id': String(lastId) } : {},
            // Past the HTTP cache: its lock on a URL makes a second identical request wait for the first to finish,
            // which a stream never does, so a section's stream would hang behind its page's.
            cache: 'no-store',
            signal: abort.signal,
          });
          if (res.status === 401) {
            this.#session.user.set(null);
            return sub.complete();
          }
          if (res.ok && res.body) {
            for await (const live of frames(res.body)) {
              if (live.id <= lastId) continue;
              lastId = live.id;
              sub.next(live);
            }
          }
        } catch {
          // dropped, or the hub is down: try again
        }
        await new Promise((r) => setTimeout(r, this.#retryMs));
      }
    })();
    return () => abort.abort();
  });
}

/** Parses SSE frames with an id and JSON data; comments (keep-alives) are skipped. */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Live> {
  const reader = body.getReader();
  const text = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += text.decode(value, { stream: true });
      let end;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const lines = buf.slice(0, end).split('\n');
        buf = buf.slice(end + 2);
        const field = (name: string) => lines.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim();
        const id = Number(field('id'));
        const data = field('data');
        if (id && data) yield { id, event: JSON.parse(data) as LiveEvent };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

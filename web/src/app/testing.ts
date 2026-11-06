// `fakeEvents()`: a fake `/api/events` for the `FETCH` token (each push reaches every open stream); `dialog()`,
// `dialogButton()` and `toasts()` read the confirmation and toasts, which live outside the component under test;
// `loggedIn(me)`, a `Session` already logged in (as `OWNER`, every permission, by default; `VIEWER` holds none), as
// every page is in the app, where they render only behind a login.

import type { Provider } from '@angular/core';
import type { HubEvent, LiveEvent, Me, Permission, TargetEvent } from '@hub/api';
import { Session } from './session';

const EVERY: readonly Permission[] = [
  'servers.chat', 'servers.console', 'servers.control', 'servers.restore', 'servers.logs', 'servers.pack', 'servers.settings',
  'servers.moderation', 'services.control', 'services.logs', 'deploys', 'library', 'audit', 'users',
];
export const OWNER: Me = { id: 'u-alex', username: 'alex', owner: true, permissions: EVERY.map((permission) => ({ permission, servers: null })) };
export const VIEWER: Me = { id: 'u-vic', username: 'vic', owner: false, permissions: [] };

/** A `Session` logged in as `me`, for a test's providers. */
export const loggedIn = (me: Me = OWNER): Provider => ({
  provide: Session,
  useFactory: () => {
    const session = new Session();
    session.user.set(me);
    return session;
  },
});

/**
 * A fake `/api/events` for the FETCH token: each call opens a stream the test writes frames to (`push`, to every open
 * stream) or ends (`drop`). `requests` holds each call's Last-Event-ID.
 */
export function fakeEvents() {
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const requests: (string | null)[] = [];
  const text = new TextEncoder();
  const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Headers(init?.headers).get('last-event-id'));
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void open.add((stream = c)) });
    init?.signal?.addEventListener('abort', () => {
      if (open.delete(stream)) stream.error(new DOMException('aborted', 'AbortError'));
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    /** Sends `e` as the hub would, stamped with `at` (default: now) unless it has its own. */
    push: (id: number, e: HubEvent | TargetEvent, at = Date.now()) =>
      open.forEach((c) => c.enqueue(text.encode(`id: ${id}\ndata: ${JSON.stringify({ at, ...e } satisfies LiveEvent)}\n\n`))),
    comment: () => open.forEach((c) => c.enqueue(text.encode(': keep-alive\n\n'))),
    drop: () => (open.forEach((c) => c.close()), open.clear()),
  };
}

/** Lets pending promises and stream reads run. */
export const settle = () => new Promise((r) => setTimeout(r, 10));

/**
 * Repeats `step` (default: `settle`) until `done()` holds, for what a fixed wait can't promise on a busy machine
 * (a reconnect, an overlay opening).
 */
export async function until(done: () => boolean, step: () => Promise<unknown> = settle, ms = 2_000) {
  for (const end = Date.now() + ms; !done(); await step()) if (Date.now() > end) throw new Error('until: timed out');
}

/** The confirmation dialog (it lives in the overlay, outside the component under test) and its parts. */
export const dialog = () => document.querySelector<HTMLElement>('[data-slot=alert-dialog-content]');
export const dialogButton = (which: 'ok' | 'cancel') => document.querySelector<HTMLButtonElement>(`[data-confirm-${which}]`)!;
/** The toasts on screen, as their text. */
export const toasts = () => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent?.trim() ?? '');

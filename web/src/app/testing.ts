import type { LiveEvent } from '@hub/api';

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
    push: (id: number, e: LiveEvent) => open.forEach((c) => c.enqueue(text.encode(`id: ${id}\ndata: ${JSON.stringify(e)}\n\n`))),
    comment: () => open.forEach((c) => c.enqueue(text.encode(': keep-alive\n\n'))),
    drop: () => (open.forEach((c) => c.close()), open.clear()),
  };
}

/** Lets pending promises and stream reads run. */
export const settle = () => new Promise((r) => setTimeout(r, 10));

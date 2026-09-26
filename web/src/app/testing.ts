import type { LiveEvent } from '@hub/api';

/**
 * A fake `/api/events` for the FETCH token: each call opens a stream the test writes frames to (`push`) or ends
 * (`drop`). `requests` holds each call's Last-Event-ID.
 */
export function fakeEvents() {
  let open: ReadableStreamDefaultController<Uint8Array> | undefined;
  const requests: (string | null)[] = [];
  const text = new TextEncoder();
  const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Headers(init?.headers).get('last-event-id'));
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (open = c) });
    init?.signal?.addEventListener('abort', () => open?.error(new DOMException('aborted', 'AbortError')));
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    push: (id: number, e: LiveEvent) => open!.enqueue(text.encode(`id: ${id}\ndata: ${JSON.stringify(e)}\n\n`)),
    comment: () => open!.enqueue(text.encode(': keep-alive\n\n')),
    drop: () => open!.close(),
  };
}

/** Lets pending promises and stream reads run. */
export const settle = () => new Promise((r) => setTimeout(r, 10));

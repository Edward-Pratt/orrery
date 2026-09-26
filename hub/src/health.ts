export type Get = (url: string) => Promise<{ ok: boolean; status: number }>;

export const httpGet: Get = (url) => fetch(url, { signal: AbortSignal.timeout(10_000) });

/**
 * GETs `url` every `everyMs` from the hub's own timer, so an outside monitor (e.g. healthchecks.io) alerts when the
 * pings stop: hub dead or stuck, or host dead. Returns a stop function. Never throws.
 */
export function startPinger(url: string, everyMs = 60_000, get: Get = httpGet): () => void {
  const timer = setInterval(() => {
    get(url).then(
      (res) => {
        if (!res.ok) console.error(`[health] ping got HTTP ${res.status}`);
      },
      (err: Error) => console.error('[health] ping failed:', err.message),
    );
  }, everyMs);
  return () => clearInterval(timer);
}

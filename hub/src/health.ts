type Get = (url: string) => Promise<{ ok: boolean; status: number }>;

const httpGet: Get = (url) => fetch(url, { signal: AbortSignal.timeout(10_000) });

/**
 * GETs `url` every `everyMs` while `up()` is true, so an outside monitor (e.g. healthchecks.io) alerts when the
 * pings stop: hub dead, host dead, or Discord unreachable. Returns a stop function. Never throws.
 */
export function startPinger(url: string, up: () => boolean, everyMs = 60_000, get: Get = httpGet): () => void {
  const timer = setInterval(() => {
    if (!up()) return;
    get(url).then(
      (res) => {
        if (!res.ok) console.error(`[health] ping got HTTP ${res.status}`);
      },
      (err: Error) => console.error('[health] ping failed:', err.message),
    );
  }, everyMs);
  return () => clearInterval(timer);
}

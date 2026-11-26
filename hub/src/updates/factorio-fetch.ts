// The catalog's reads of factorio.com and the mod portal, through the injected `PortalFetch` (15 s timeouts,
// `TIMEOUT_MS`, unless a read says its own; answers capped, bytes counted as read (`CAPS`): 64 KiB, 4 MiB for
// `sha256sums/` and a mod's page, 16 MiB for a line's list (`CAPS.list`), 512 KiB for a short page and a thumbnail;
// every request `redirect: 'manual'`,
// a public read following at most 3 redirects itself, each checked before it is asked: https on `factorio.com`,
// `www.factorio.com` or `mods.factorio.com`, no port, no user, else 502): `portalRead(fetch, url, cap, who, …)` (the
// bytes; null for a 404 when `missing` allows it; `hops: 0` refuses any redirect, `type` the media type it must have),
// `portalText(…)` on top of it, `portalJson(text, what)` (502 naming `what` when it isn't JSON), `failure(err)` (why a
// request failed, never its URL), `GameRefused` (400/404/409/429/502) and `OverCap` (an answer over its cap, 502). Also
// `PORTAL`, the mod portal's origin. `FactorioCatalog` (`factorio.ts`) holds the caches. Hub core.

/**
 * factorio.com's and the mod portal's requests (`fetch`), all with `redirect: 'manual'`: a public read follows
 * redirects itself, each checked before it is asked (`https:` on `PUBLIC_HOSTS`, 3 at most); a mod's download link
 * follows none, so its credentials never go along, and nor does a thumbnail's read from `assets-mod.factorio.com`.
 */
export type PortalFetch = (url: string, init: { redirect: 'follow' | 'manual'; signal: AbortSignal }) => Promise<Response>;

/** Why a game action wasn't done: 400 (bad input), 404 (no such thing), 409 (not now), 429 (too many) or 502 (factorio.com, the portal or an Agent failed). */
export class GameRefused extends Error {
  readonly status: 400 | 404 | 409 | 429 | 502;
  constructor(status: 400 | 404 | 409 | 429 | 502, message: string) {
    super(message);
    this.status = status;
  }
}
/** An answer over its cap (502): a thumbnail's short page over it only means "no thumbnail". */
export class OverCap extends GameRefused {}

export const PORTAL = 'https://mods.factorio.com';
export const TIMEOUT_MS = 15_000;
/** The only hosts a public read (or its redirect) goes to, over https with no port or user. */
const PUBLIC_HOSTS = new Set(['factorio.com', 'www.factorio.com', 'mods.factorio.com']);
const MAX_HOPS = 3;
/** `list`: a line's every mod (3.7 MB for 2.1 in 2026); `page`: a mod's short page; `image`: a thumbnail. */
export const CAPS = { latest: 64 * 1024, sums: 4 * 1024 * 1024, mod: 4 * 1024 * 1024, list: 16 * 1024 * 1024, page: 512 * 1024, image: 512 * 1024 };

/** A public answer's JSON; 502 naming `what` when it isn't. */
export function portalJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GameRefused(502, `${what} isn't JSON.`);
  }
}

/** A public page's text, at most `cap` bytes; null for a 404 when `missing` allows it. */
export async function portalText(fetch: PortalFetch, url: string, cap: number, who: string, missing: true): Promise<string | null>;
export async function portalText(fetch: PortalFetch, url: string, cap: number, who: string): Promise<string>;
export async function portalText(fetch: PortalFetch, url: string, cap: number, who: string, missing = false): Promise<string | null> {
  const body = await portalRead(fetch, url, cap, who, { missing });
  return body === null ? null : body.toString('utf8');
}

/**
 * A public answer's bytes, at most `cap` (counted as read: `content-length` is only a first check), within
 * `TIMEOUT_MS`; null for a 404 when `missing` allows it. It follows at most `hops` redirects (3 unless said; 0: any
 * redirect is refused), each checked before it is asked: https on `PUBLIC_HOSTS`, no port, no user. `type`: the
 * media type the answer must have.
 */
export async function portalRead(
  fetch: PortalFetch,
  url: string,
  cap: number,
  who: string,
  { missing = false, hops = MAX_HOPS, type, timeout = TIMEOUT_MS, abort }: { missing?: boolean; hops?: number; type?: string; timeout?: number; abort?: AbortSignal } = {},
): Promise<Buffer<ArrayBuffer> | null> {
  const signal = abort ? AbortSignal.any([AbortSignal.timeout(timeout), abort]) : AbortSignal.timeout(timeout);
  let res: Response;
  for (let at = url, hop = 0; ; hop++) {
    try {
      res = await fetch(at, { redirect: 'manual', signal });
    } catch (err) {
      throw new GameRefused(502, `${who} can't be read: ${failure(err)}.`);
    }
    if (res.status < 300 || res.status > 399) break;
    // A redirect, followed only once its target is checked: never to http, another host or a port.
    await res.body?.cancel().catch(() => {});
    if (!hops) throw new GameRefused(502, `${who} redirected, which is never followed.`);
    if (hop >= hops) throw new GameRefused(502, `${who} redirected more than ${hops} times.`);
    let next: URL;
    try {
      next = new URL(res.headers.get('location') ?? '', at);
    } catch {
      throw new GameRefused(502, `${who} redirected to something that isn't a URL.`);
    }
    if (next.protocol !== 'https:') throw new GameRefused(502, `${who} redirected away from https.`);
    if (!PUBLIC_HOSTS.has(next.hostname) || next.port || next.username || next.password) {
      throw new GameRefused(502, `${who} redirected away from ${[...PUBLIC_HOSTS].join(', ')}.`);
    }
    at = next.href;
  }
  if (missing && res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new GameRefused(502, `${who} can't be read: HTTP ${res.status}.`);
  }
  if (type !== undefined && (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== type) {
    await res.body?.cancel().catch(() => {});
    throw new GameRefused(502, `${who} isn't ${type}.`);
  }
  if (Number(res.headers.get('content-length') ?? 0) > cap) {
    await res.body?.cancel().catch(() => {});
    throw new OverCap(502, `${who}'s answer is over ${cap} bytes.`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = res.body?.getReader();
    for (;;) {
      const chunk = reader && (await reader.read());
      if (!chunk || chunk.done) break;
      size += chunk.value.byteLength;
      if (size > cap) {
        await reader.cancel().catch(() => {});
        throw new OverCap(502, `${who}'s answer is over ${cap} bytes.`);
      }
      chunks.push(chunk.value);
    }
  } catch (err) {
    if (err instanceof GameRefused) throw err;
    throw new GameRefused(502, `${who} can't be read: ${failure(err)}.`);
  }
  return Buffer.concat(chunks);
}

/** Why a request failed, in words that never hold its URL. */
export function failure(err: unknown): string {
  const e = err as { name?: string; cause?: { code?: unknown } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timed out';
  return typeof e?.cause?.code === 'string' ? e.cause.code : 'the request failed';
}

// The library's downloads and the Actions artifacts, for `Library`: `download` fetches through `HubDeps.download`, a
// fetch-shaped request (`Fetch`), following up to 5 redirects itself (each `https:`) and resuming a drop up to 3 times
// with `Range` + `If-Range` from the bytes on disk, a `200` starting over. A GitHub Actions artifact link
// (`…/actions/runs/<run>/artifacts/<id>`, `ARTIFACT`, kept as the source) is fetched through
// `GET /repos/<o>/<r>/actions/artifacts/<id>/zip` on `GITHUB_API` with `HubDeps.githubToken`: the token goes only on
// that first request, only to `https://api.github.com`, never on a redirect's hop. Hub core.

import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** One HTTP request, redirects not followed (`redirect: 'manual'`): what downloads go through. The real one is `fetch`. */
export type Fetch = (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal?: AbortSignal }) => Promise<Response>;

export const GITHUB_API = 'https://api.github.com';
const REDIRECTS = 5;
const RESUMES = 3;
/** A GitHub Actions artifact's page, which the API serves as a zip. */
export const ARTIFACT = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/\d+\/artifacts\/(\d+)\/?$/;

/** An answer that isn't a drop: an HTTP error or a refused redirect fails the download at once. */
class Refused extends Error {}

/** `url` requested with up to 5 redirects followed here: every hop `https:`, the token sent only on the first, and only to api.github.com. */
export async function request(fetcher: Fetch, url: string, headers: Record<string, string>, token: string | undefined, signal?: AbortSignal): Promise<Response> {
  for (let hop = 0; ; hop++) {
    if (URL.parse(url)?.protocol !== 'https:') throw new Refused(`a redirect to ${url} isn't https: refused`);
    const auth: Record<string, string> = token && hop === 0 && new URL(url).origin === GITHUB_API ? { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' } : {};
    const res = await fetcher(url, { headers: { ...headers, ...auth }, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    await res.body?.cancel();
    const to = res.headers.get('location');
    if (!to) throw new Refused(`HTTP ${res.status} without a Location`);
    if (hop === REDIRECTS) throw new Refused(`more than ${REDIRECTS} redirects`);
    url = new URL(to, url).href;
  }
}

/**
 * Fetches `url` into the file `dest`, reporting bytes so far and the total (null: unknown); `signal` aborts it. A drop
 * (a network error, or a body cut short) is resumed from `url` again (an artifact's API link gives a fresh blob link)
 * with `Range` from the bytes on disk and `If-Range` with the first answer's ETag; a `200` instead of a `206` starts
 * the file over, as does an answer without an ETag. After three resumes it fails.
 */
export async function download(
  fetcher: Fetch,
  url: string,
  dest: string,
  onProgress: (bytes: number, total: number | null) => void,
  signal?: AbortSignal,
  token?: string,
): Promise<void> {
  let etag: string | null = null;
  let have = 0;
  for (let resumes = 0; ; resumes++) {
    try {
      const res = await request(fetcher, url, have && etag ? { range: `bytes=${have}-`, 'if-range': etag } : {}, token, signal);
      if (res.status === 206 && have) {
        // appended
      } else if (res.status === 200) {
        have = 0;
        etag = res.headers.get('etag');
      } else throw new Refused(`HTTP ${res.status}`);
      if (!res.body) throw new Refused(`HTTP ${res.status} without a body`);
      const total = Number(res.status === 206 ? /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] : res.headers.get('content-length')) || null;
      let bytes = have;
      const count = new Transform({
        transform(chunk: Buffer, _, done) {
          bytes += chunk.length;
          onProgress(bytes, total);
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(dest, { flags: have ? 'a' : 'w' }), { signal });
      if (total === null || bytes >= total) return;
      throw new Error(`the download stopped at ${bytes} of ${total} bytes`);
    } catch (err) {
      if (err instanceof Refused || signal?.aborted) throw err;
      if (resumes === RESUMES) throw new Error(`${(err as Error).message} (after ${RESUMES} resumes)`);
      have = (await stat(dest).catch(() => undefined))?.size ?? 0;
    }
  }
}

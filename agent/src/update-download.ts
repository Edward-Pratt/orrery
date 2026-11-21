// A game update's downloads (`update-prepare.ts`; agent/CLAUDE.md, "Trust boundaries"). `Http`, injectable: `fetch`
// with `redirect: 'manual'`; the downloads follow redirects themselves, at most 5, each only to an allowed https host
// (`allowedUrl`); 1 GiB a game, 512 MiB a mod, 16 MiB a hash list (a `Content-Length` over it refused before a byte is
// read); one that gets no byte for `STALL_MS` (60 s), its answer or its body, is stopped and fails prepare ("No data
// from <URL> for 60 s: the download was stopped"); the update's cancel aborts it. The hashes' sources, the agent's
// own URLs: factorio.com's sha256 list (`SHA256SUMS`, parsed by `parseSums`) and the mod portal's public API
// (`MOD_API`). Every error names a URL without its query string or fragment (`bare`).
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { UpdatesCtx } from './update-ctx.ts';
import { allowedUrl } from './update-checks.ts';
import { create, writeAll } from './update-files.ts';
import { Cancelled, Fail, mb, reason, type Running } from './update-job.ts';
import { progressStep } from './update-steps.ts';

/** factorio.com's sha256 of every release file: the game's hash comes from here, not from the hub. */
export const SHA256SUMS = 'https://www.factorio.com/download/sha256sums/';
/** The mod portal's public API (no credentials): each mod's releases with their sha1. */
export const MOD_API = 'https://mods.factorio.com/api/mods/';
const MAX_HOPS = 5;

/** Download caps: far over a headless tarball (about 60 MB), a light mod, and the hash lists. */
export const GAME_MAX = 1024 ** 3;
export const MOD_MAX = 512 * 1024 ** 2;
const META_MAX = 16 * 1024 ** 2;

/** An HTTP GET of `url` with no redirect followed (`redirect: 'manual'`): the agent follows them itself, checked. */
export type Http = (url: string, signal: AbortSignal) => Promise<Response>;
export const http: Http = (url, signal) => fetch(url, { redirect: 'manual', signal });

/** A URL as it may be shown: no query string, no fragment (a signed link's credentials). */
const bare = (u: URL) => `${u.origin}${u.pathname}`;

/**
 * A download's abort: the update's own (a cancel), or `ms` without a byte (a stall, `stalled`). Armed from the request
 * on, so an answer that never comes stalls too; `alive` after each answer and chunk, `end` once done.
 */
function watch(update: AbortSignal, ms: number) {
  const stall = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const w = {
    signal: AbortSignal.any([update, stall.signal]),
    get stalled() {
      return stall.signal.aborted;
    },
    alive() {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), ms);
    },
    end: () => clearTimeout(timer),
  };
  w.alive();
  return w;
}
type Watch = ReturnType<typeof watch>;

/** factorio.com's sha256 list: file name to hash. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)\s*$/.exec(line);
    if (m) sums.set(m[2]!, m[1]!);
  }
  return sums;
}

/**
 * A GET, following redirects itself (5 at most), each only to an allowed https host: `url` is the hub's (checked
 * too) or, `ours`, one of the agent's own (the hash lists). Anything but 200 at the end fails, and so does a 200 whose
 * `Content-Length` is over `cap`; so does an answer that doesn't come within the stall time (`w`).
 */
async function get(c: UpdatesCtx, r: Running, url: string, ours: boolean, w: Watch, cap: number): Promise<{ res: Response; at: URL }> {
  let at = ours ? new URL(url) : allowedUrl(url, 'the download');
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await c.o.http(at.href, w.signal);
    } catch (err) {
      if (r.abort.signal.aborted) throw new Cancelled('cancelled');
      if (w.stalled) throw stalledFail(c, at);
      throw new Fail(`Can't download ${bare(at)}: ${reason((err as Error).cause ?? err)}`);
    }
    w.alive();
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get('location');
      if (!location) throw new Fail(`${bare(at)} answered ${res.status} with no Location`);
      if (hop >= MAX_HOPS) throw new Fail(`${bare(at)}: over ${MAX_HOPS} redirects`);
      let next: string;
      try {
        next = new URL(location, at).href;
      } catch {
        throw new Fail(`${bare(at)} redirected to something that is not a URL`);
      }
      try {
        at = allowedUrl(next, `${bare(at)}'s redirect`);
      } catch (err) {
        throw new Fail(reason(err));
      }
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new Fail(`${bare(at)} answered HTTP ${res.status}`);
    }
    if (Number(res.headers.get('content-length')) > cap) {
      await res.body?.cancel().catch(() => {});
      throw new Fail(`${bare(at)} is over ${mb(cap)}`);
    }
    return { res, at };
  }
}

/** The step error for a download that got no byte for the stall time. */
function stalledFail(c: UpdatesCtx, at: URL): Fail {
  return new Fail(`No data from ${bare(at)} for ${c.o.stallMs / 1000} s: the download was stopped`);
}

/** One of the agent's own URLs as text, 16 MiB at most. */
export async function text(c: UpdatesCtx, r: Running, url: string): Promise<string> {
  const w = watch(r.abort.signal, c.o.stallMs);
  try {
    const { res, at } = await get(c, r, url, true, w, META_MAX);
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body ?? []) {
        w.alive();
        size += chunk.length;
        if (size > META_MAX) throw new Fail(`${bare(at)} is over ${mb(META_MAX)}`);
        parts.push(Buffer.from(chunk));
      }
    } catch (err) {
      if (r.abort.signal.aborted) throw new Cancelled('cancelled');
      if (err instanceof Fail) throw err;
      if (w.stalled) throw stalledFail(c, at);
      throw new Fail(`Can't read ${bare(at)}: ${reason(err)}`);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {
    w.end();
  }
}

/** The hub's `url` into `<dir>/<name>` (a new file), `cap` bytes at most; resolves with its hash in hex. */
export async function download(c: UpdatesCtx, r: Running, url: string, dir: string, name: string, algo: 'sha1' | 'sha256', cap: number, progress: (got: number) => string): Promise<string> {
  const w = watch(r.abort.signal, c.o.stallMs);
  try {
    const { res, at } = await get(c, r, url, false, w, cap);
    const file = `${dir}/${name}`;
    const fh = await create(file);
    const hash = createHash(algo);
    let got = 0;
    try {
      for await (const chunk of res.body ?? []) {
        w.alive();
        got += chunk.length;
        if (got > cap) throw new Fail(`${bare(at)} is over ${mb(cap)}`);
        hash.update(chunk);
        await writeAll(fh, chunk);
        progressStep(c, r, progress(got));
      }
    } catch (err) {
      await fh.close();
      await rm(file, { force: true });
      if (r.abort.signal.aborted) throw new Cancelled('cancelled');
      if (err instanceof Fail) throw err;
      if (w.stalled) throw stalledFail(c, at);
      throw new Fail(`Can't download ${bare(at)}: ${reason(err)}`);
    }
    await fh.close();
    return hash.digest('hex');
  } finally {
    w.end();
  }
}

// `ModsZip`, the mods zip of a server an Agent runs (`has`; others 404): `open(serverId)` gives a zip of the portal
// mods its Agent last reported in `installed` (every enabled one, `GAME_MODS` aside), each as `<name>_<version>.zip`,
// plus a `mod-list.json` enabling them all and the game's own enabled ones, so the folder drops into a client's
// `mods/`. It is rebuilt from the mod portal at the versions the server runs, not copied from the server's disk (no
// `mod-settings.dat`). Before the first byte, every mod is found on the portal at its version (`catalog.mod`, cached)
// and given its signed link (`catalog.mod` then `catalog.link`, 4 at once each, the owner's account): a missing one, no `installed` yet or
// no account refuses (`GameRefused`), so a zip is never silently partial. Then the stream reads one mod per pull
// (`portalRead`, no redirect, `MOD_MAX` bytes and `MOD_TIMEOUT_MS` each), checks its sha1 against the portal's and
// writes it stored (`StoreZip`). A failed read errors the stream (the download fails, it never ends cleanly); the
// client going away (the stream cancelled, or `signal`, even before the stream exists) aborts the read, and so does a
// stream nobody reads for `IDLE_MS`. One zip per server at a time (else 429), its slot freed once whichever way it
// ends. Hub core.

import { createHash } from 'node:crypto';
import { GAME_MODS, GameRefused, validName, VERSION, type FactorioCatalog, type PortalFetch } from './factorio.ts';
import { portalRead } from './factorio-fetch.ts';
import type { GameUpdates } from './game-updates.ts';
import { eachAtMost } from './mod-updates.ts';
import { StoreZip } from './zip-store.ts';

/** The most one mod's download may hold (it is held in memory while written). */
const MOD_MAX = 512 * 1024 * 1024;
const MOD_TIMEOUT_MS = 10 * 60_000;
/** A stream not read for this long is ended and its slot freed (a client that never reads, or never cancels). */
const IDLE_MS = 2 * 60_000;
/** Portal reads at once while finding and linking the mods. */
const READS_AT_ONCE = 4;
/** Mods a refusal names; the rest are counted. */
const NAMED = 10;

export type ModsZipDeps = { catalog: Pick<FactorioCatalog, 'mod' | 'link'>; fetch: PortalFetch; gameUpdates: Pick<GameUpdates, 'has' | 'state'> };
type Entry = { name: string; version: string; sha1: string; url: string };

const sha1 = (data: Uint8Array) => createHash('sha1').update(data).digest('hex');
const names = (list: string[]) => list.slice(0, NAMED).join(', ') + (list.length > NAMED ? ` and ${list.length - NAMED} more` : '');

export class ModsZip {
  #d: ModsZipDeps;
  #busy = new Set<string>();
  #idleMs: number;

  /** `idleMs`: `IDLE_MS` unless a test says. */
  constructor(deps: ModsZipDeps, { idleMs = IDLE_MS }: { idleMs?: number } = {}) {
    this.#d = deps;
    this.#idleMs = idleMs;
  }

  has(serverId: string): boolean {
    return this.#d.gameUpdates.has(serverId);
  }

  /**
   * The server's mods zip as a stream, every mod found and linked first; `signal` (the request's) aborts it. Rejects
   * 409/429/502 (`GameRefused`).
   */
  async open(serverId: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    if (this.#busy.has(serverId)) throw new GameRefused(429, "This server's mods zip is being made already.");
    this.#busy.add(serverId);
    let ended = false;
    const done = () => {
      if (!ended) this.#busy.delete(serverId);
      ended = true;
    };
    try {
      const installed = this.#d.gameUpdates.state(serverId).installed;
      if (!installed) throw new GameRefused(409, "The server's Agent hasn't said what it runs yet.");
      const modList = Buffer.from(`${JSON.stringify({ mods: installed.mods.map((m) => ({ name: m.name, enabled: true })) }, null, 2)}\n`);
      const entries = await this.#entries(installed.mods);
      signal?.throwIfAborted(); // the client left while the mods were found: no stream, the slot freed below
      return this.#stream(entries, modList, done, signal);
    } catch (err) {
      done();
      throw err;
    }
  }

  /** Each portal mod at the version the server runs, with its signed link; refused if one isn't on the portal so. */
  async #entries(mods: { name: string; version: string }[]): Promise<Entry[]> {
    const portal = mods.filter((m) => !GAME_MODS.has(m.name));
    if (!portal.length) throw new GameRefused(409, 'The server runs no mods from the mod portal.');
    const missing: string[] = [];
    const entries: Entry[] = [];
    await eachAtMost(READS_AT_ONCE, portal, async ({ name, version }) => {
      const release = validName(name) && VERSION.test(version) ? (await this.#d.catalog.mod(name))?.releases.find((r) => r.version === version) : undefined;
      if (release) entries.push({ name, version, sha1: release.sha1, url: release.downloadUrl });
      else missing.push(`${name} ${version}`);
    });
    if (missing.length) throw new GameRefused(409, `Not on the mod portal at the version the server runs: ${names(missing.sort())}.`);
    await eachAtMost(READS_AT_ONCE, entries, async (e) => {
      e.url = await this.#d.catalog.link(e.url);
    });
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  #stream(entries: Entry[], modList: Buffer, done: () => void, signal?: AbortSignal): ReadableStream<Uint8Array> {
    const zip = new StoreZip();
    const abort = new AbortController();
    let idle: NodeJS.Timeout | undefined;
    const stop = () => {
      clearTimeout(idle);
      abort.abort();
      done();
    };
    signal?.addEventListener('abort', stop, { once: true });
    let next = 0;
    let ctl: ReadableStreamDefaultController<Uint8Array>;
    /** Ends the stream unless it is read again within `IDLE_MS`. */
    const arm = () => {
      idle = setTimeout(() => {
        stop();
        ctl.error(new Error(`The mods zip wasn't read for ${this.#idleMs / 1000} s.`));
      }, this.#idleMs).unref();
    };
    return new ReadableStream<Uint8Array>(
      {
        start: (out) => {
          ctl = out;
          arm();
        },
        pull: async (out) => {
          clearTimeout(idle);
          try {
            if (next === entries.length) {
              for (const b of zip.entry('mod-list.json', modList)) out.enqueue(b);
              out.enqueue(zip.end());
              out.close();
              return void done();
            }
            const e = entries[next++]!;
            const who = `${e.name} ${e.version}'s download`;
            const data = (await portalRead(this.#d.fetch, e.url, MOD_MAX, who, { hops: 0, timeout: MOD_TIMEOUT_MS, abort: abort.signal }))!;
            if (sha1(data) !== e.sha1) throw new GameRefused(502, `${who} doesn't match the portal's sha1.`);
            for (const b of zip.entry(`${e.name}_${e.version}.zip`, data)) out.enqueue(b);
            arm();
          } catch (err) {
            if (!abort.signal.aborted) console.warn(`[hub] mods zip failed: ${err instanceof Error ? err.message : String(err)}`);
            done();
            throw err;
          }
        },
        cancel: stop,
      },
      { highWaterMark: 0 },
    );
  }
}

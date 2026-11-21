// `NodeCheck` (with `integrations.agents`): each Agent's Node against nodejs.org's releases. `run()` reads
// `https://nodejs.org/dist/index.json` (`NODE_INDEX`) through the injected `NodeFetch` (`redirect: 'manual'`: a
// redirect is a failure; 15 s; at most `INDEX_BYTES`, 4 MiB, counted as read, `content-length` only a first check). The
// answer is untrusted: it must be a JSON array of at most `INDEX_ENTRIES` (10,000); an entry counts only when it is an
// object whose `version` matches `NODE_VERSION` (a release, at most 32 characters), others are dropped, and at least
// one must count; versions compare as numbers, never by the index's order. For each Agent whose latest hello named
// its Node (`AgentStatus.node`), the newest release of that Node's major, when newer, raises one `nodeUpdate` host
// notice (`info`, the Agent's id and name, its Node and the newest), once per Agent and newest while the hub runs (a
// restarted hub tells a Node still behind once more); an Agent current again (or with no release of its major listed)
// is forgotten. A failed or malformed read keeps the last good answer, which that run still checks against, and is
// logged once until a read succeeds; no error holds more than the reason. `startNodeCheck(deps)` runs it every day at
// `NODE_CHECK_TIME` (05:00 local, `everyDay`) and returns its cancel. Hub core.

import { everyDay } from '../daily.ts';
import { NODE_VERSION } from '../protocol.ts';
import type { ServerHub } from '../servers/servers.ts';
import { compareVersions } from '../updates/factorio-releases.ts';
import type { AgentStatus } from './public.ts';

/** nodejs.org's request (`fetch`): always `redirect: 'manual'`, so no redirect is followed. */
export type NodeFetch = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

export type NodeCheckDeps = {
  agents: { list: () => AgentStatus[] };
  hub: Pick<ServerHub, 'publishTarget'>;
  fetch: NodeFetch;
};

export const NODE_INDEX = 'https://nodejs.org/dist/index.json';
/** When the check runs, local time: after the database upkeep (04:00), before the usual 06:00 daily restart. */
export const NODE_CHECK_TIME = '05:00';
/** The index's most bytes (about 300 KB in 2026) and entries (under 1,000). */
export const INDEX_BYTES = 4 * 1024 * 1024;
export const INDEX_ENTRIES = 10_000;
const TIMEOUT_MS = 15_000;

/** A release's version as `compareVersions` reads it: `v24.22.2` is `24.22.2`. */
const bare = (v: string) => v.slice(1);
const majorOf = (v: string) => bare(v).split('.')[0]!;

/** The newest release of each major in an index answer (by major, as a string); throws why it isn't one. */
export function newestByMajor(data: unknown): Map<string, string> {
  if (!Array.isArray(data)) throw new Error("it isn't a list");
  if (data.length > INDEX_ENTRIES) throw new Error(`it lists over ${INDEX_ENTRIES} releases`);
  const newest = new Map<string, string>();
  for (const entry of data) {
    const version: unknown = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>).version : undefined;
    if (typeof version !== 'string' || !NODE_VERSION.test(version)) continue;
    const known = newest.get(majorOf(version));
    if (known === undefined || compareVersions(bare(version), bare(known)) > 0) newest.set(majorOf(version), version);
  }
  if (!newest.size) throw new Error('it lists no release');
  return newest;
}

/** A response's body as text, at most `cap` bytes counted as read; throws past it. */
async function capped(res: Response, cap: number): Promise<string> {
  if (Number(res.headers.get('content-length') ?? 0) > cap) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`its answer is over ${cap} bytes`);
  }
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = reader && (await reader.read());
    if (!chunk || chunk.done) break;
    size += chunk.value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`its answer is over ${cap} bytes`);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Why a request failed, in words that hold no URL. */
function failure(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: unknown } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timed out';
  if (typeof e?.cause?.code === 'string') return e.cause.code;
  return e instanceof SyntaxError ? "it isn't JSON" : (e?.message ?? 'the request failed');
}

/**
 * Each Agent's Node against the newest release of its major on nodejs.org: a `nodeUpdate` host notice when it is
 * behind, once per Agent and newest. A failed read keeps the last good answer and is logged once. Hub core.
 */
export class NodeCheck {
  #d: NodeCheckDeps;
  #newest: Map<string, string> | null = null; // the last good answer
  #failing = false; // logged since the last good read
  #told = new Map<string, string>(); // by Agent id: the newest it was last told about

  constructor(deps: NodeCheckDeps) {
    this.#d = deps;
  }

  /** Reads the index (keeping the last good answer when it can't) and tells each Agent behind; never rejects. */
  async run(): Promise<void> {
    try {
      this.#newest = await this.#read();
      this.#failing = false;
    } catch (err) {
      if (!this.#failing) console.error(`[node-check] nodejs.org's release index can't be read: ${failure(err)}; keeping the last answer`);
      this.#failing = true;
    }
    if (this.#newest) this.#tell(this.#newest);
  }

  async #read(): Promise<Map<string, string>> {
    const res = await this.#d.fetch(NODE_INDEX, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    return newestByMajor(JSON.parse(await capped(res, INDEX_BYTES)));
  }

  #tell(newest: Map<string, string>): void {
    for (const a of this.#d.agents.list()) {
      const latest = a.node === null ? undefined : newest.get(majorOf(a.node));
      if (a.node === null || latest === undefined || compareVersions(bare(latest), bare(a.node)) <= 0) {
        this.#told.delete(a.id);
        continue;
      }
      if (this.#told.get(a.id) === latest) continue;
      this.#told.set(a.id, latest);
      this.#d.hub.publishTarget({ target: 'host', id: a.id, type: 'notice', severity: 'info', kind: 'nodeUpdate', name: a.name, node: a.node, newest: latest });
    }
  }
}

/** Runs a `NodeCheck` every day at `NODE_CHECK_TIME`; returns the cancel. */
export function startNodeCheck(deps: NodeCheckDeps): () => void {
  const check = new NodeCheck(deps);
  return everyDay(NODE_CHECK_TIME, 0, () => void check.run());
}

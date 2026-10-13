import type { CheckConfig } from './config.ts';
import type { Get } from './health.ts';
import type { CheckStatus, ServerHub } from './servers.ts';

/** Why a request failed, briefly: "timed out", a network error code such as ECONNREFUSED, or a message. */
function failure(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.cause?.message ?? e.message);
}

/**
 * Requests each check's URL at startup and then every interval: up means HTTP 2xx before `get` times out, on the
 * first try or on one retry made straight after a failure. Keeps only
 * the current state, and puts each result on the event stream (`checked`); going down, and coming back up, is also a
 * notice (never repeated while the state holds). Hub core.
 */
export class Checks {
  #hub: Pick<ServerHub, 'publishTarget'>;
  #get: Get;
  #checks: CheckConfig[];
  #states = new Map<string, CheckStatus>();
  #timers: NodeJS.Timeout[] = [];

  constructor(hub: Pick<ServerHub, 'publishTarget'>, checks: CheckConfig[], get: Get) {
    this.#hub = hub;
    this.#get = get;
    this.#checks = checks;
    for (const c of checks) {
      this.#states.set(c.id, { id: c.id, url: c.url, up: null, ms: null, error: null, checkedAt: null, service: c.service ?? null });
    }
  }

  start(): void {
    for (const c of this.#checks) {
      void this.#run(c);
      this.#timers.push(setInterval(() => void this.#run(c), c.intervalSeconds * 1000));
    }
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
  }

  list(): CheckStatus[] {
    return [...this.#states.values()].map((s) => ({ ...s }));
  }

  /** One GET of `url`: null when up, else why not; and how long it took. */
  async #attempt(url: string): Promise<{ error: string | null; ms: number }> {
    const start = Date.now();
    try {
      const res = await this.#get(url);
      return { error: res.ok ? null : `HTTP ${res.status}`, ms: Date.now() - start };
    } catch (err) {
      return { error: failure(err), ms: Date.now() - start };
    }
  }

  async #run(c: CheckConfig): Promise<void> {
    let result = await this.#attempt(c.url);
    // Asked again at once before it counts as down: one lost packet is not an outage.
    if (result.error !== null) result = await this.#attempt(c.url);
    const { error, ms } = result;
    const state = this.#states.get(c.id)!;
    const was = state.up;
    Object.assign(state, { up: error === null, ms, error, checkedAt: Date.now() });
    this.#hub.publishTarget({ target: 'check', id: c.id, type: 'checked', status: { ...state } });
    if (error !== null && was !== false) {
      this.#hub.publishTarget({ target: 'check', id: c.id, type: 'notice', severity: 'problem', kind: 'checkDown', url: c.url, error });
    } else if (error === null && was === false) {
      this.#hub.publishTarget({ target: 'check', id: c.id, type: 'notice', severity: 'good', kind: 'checkUp', url: c.url, ms: state.ms! });
    }
  }
}

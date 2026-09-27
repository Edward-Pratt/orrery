import type { CheckConfig } from './config.ts';
import type { Get } from './health.ts';
import type { CheckStatus, ServerHub } from './servers.ts';

/** Why a request failed, briefly: "timed out", a network error code such as ECONNREFUSED, or a message. */
function failure(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.cause?.message ?? e.message);
}

/**
 * Requests each check's URL at startup and then every interval: up means HTTP 2xx before `get` times out. Keeps only
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

  async #run(c: CheckConfig): Promise<void> {
    const start = Date.now();
    let error: string | null;
    try {
      const res = await this.#get(c.url);
      error = res.ok ? null : `HTTP ${res.status}`;
    } catch (err) {
      error = failure(err);
    }
    const state = this.#states.get(c.id)!;
    const was = state.up;
    Object.assign(state, { up: error === null, ms: Date.now() - start, error, checkedAt: Date.now() });
    this.#hub.publishTarget({ target: 'check', id: c.id, type: 'checked', status: { ...state } });
    if (error !== null && was !== false) {
      this.#hub.publishTarget({ target: 'check', id: c.id, type: 'notice', severity: 'problem', kind: 'checkDown', url: c.url, error });
    } else if (error === null && was === false) {
      this.#hub.publishTarget({ target: 'check', id: c.id, type: 'notice', severity: 'good', kind: 'checkUp', url: c.url, ms: state.ms! });
    }
  }
}

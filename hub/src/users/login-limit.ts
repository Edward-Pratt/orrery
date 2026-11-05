// `LoginLimit`: the login's counters, in memory (a restart clears them). Per username (lower-cased) and address pair,
// `PAIR_MAX` (5) failures in `WINDOW_MS` (15 min) lock the pair for `LOCK_MS` (15 min); never the name alone, so five
// wrong guesses at the owner's name from elsewhere lock no one out. Per address, `ADDRESS_MAX` (20) failures in the
// window lock the address. `locked(username, address)` answers the seconds to wait, 0 when the attempt may go on;
// `fail` counts one; `clear` forgets the pair on a success (the address's count stays). Expired entries are swept
// on every call and at most `KEPT` (10,000) of each are held, the oldest dropped, so a flood can't grow the hub's
// memory. Hub core.

export const PAIR_MAX = 5;
export const ADDRESS_MAX = 20;
export const WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;
const KEPT = 10_000;

type Entry = { fails: number[]; lockedUntil: number };

export class LoginLimit {
  #pairs = new Map<string, Entry>();
  #addresses = new Map<string, Entry>();

  /** Seconds to wait before another attempt at this name from this address, or 0. */
  locked(username: string, address: string, now = Date.now()): number {
    this.#sweep(now);
    const until = Math.max(this.#pairs.get(pair(username, address))?.lockedUntil ?? 0, this.#addresses.get(address)?.lockedUntil ?? 0);
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }

  fail(username: string, address: string, now = Date.now()): void {
    this.#sweep(now);
    count(this.#pairs, pair(username, address), PAIR_MAX, now);
    count(this.#addresses, address, ADDRESS_MAX, now);
  }

  clear(username: string, address: string): void {
    this.#pairs.delete(pair(username, address));
  }

  #sweep(now: number): void {
    for (const map of [this.#pairs, this.#addresses]) {
      for (const [key, e] of map) {
        e.fails = e.fails.filter((t) => t > now - WINDOW_MS);
        if (!e.fails.length && e.lockedUntil <= now) map.delete(key);
      }
      for (const key of map.keys()) {
        if (map.size <= KEPT) break;
        map.delete(key);
      }
    }
  }
}

const pair = (username: string, address: string) => `${username.toLowerCase()}\n${address}`;

function count(map: Map<string, Entry>, key: string, max: number, now: number): void {
  const e = map.get(key) ?? { fails: [], lockedUntil: 0 };
  map.delete(key); // re-inserted last: the cap drops the oldest first
  e.fails.push(now);
  if (e.fails.length >= max) {
    e.lockedUntil = now + LOCK_MS;
    e.fails = [];
  }
  map.set(key, e);
}

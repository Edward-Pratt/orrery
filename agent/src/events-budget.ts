// The game events' budget: `GameEvents` emits within `EventBudget`, 5 a second sustained and 30 at once, all kinds
// together (a cell-rate check on a monotonic clock).
//
// So a chat flood can never push the game connection past the hub's 20 lines a second, which it closes after 10 s;
// only events count, not the hello or a datagram dropped as malformed, and a link or unlink counts before its fresh
// `/orrery-status`, so a flood of them can't flood RCON. One over the budget is dropped (its `seq` still taken, so no
// gap is logged) and counted: the first drop starts a minute, at whose end one line logs the count (`GameEvents.stop`
// logs what is counted, through `flush`).

/**
 * Game events the agent forwards to the hub, all kinds together: 5 a second sustained, 30 at once. The hub drops a
 * connection's lines over 20 a second (100 at once) and closes one that stays over that for 10 s, so a player
 * spamming chat can never take the game connection, and its heartbeats, down with it.
 */
export const EVENT_RATE = 5;
export const EVENT_BURST = 30;
/** The events dropped over the budget are counted in one log line a minute at most. */
export const DROP_LOG_MS = 60_000;

/**
 * The game events' budget, `EVENT_RATE` a second and `EVENT_BURST` at once, on a monotonic clock (ms): a cell-rate
 * check, so a full burst comes back after a quiet 6 s and nothing builds up past it. `take` says whether one more
 * event goes now. What it refuses is counted: the first refusal starts a minute, at whose end (or at `flush`) one line
 * logs the count.
 */
export class EventBudget {
  #now: () => number;
  /** When the next event would be on time; it may run up to `EVENT_BURST - 1` intervals ahead of the clock. */
  #due = -Infinity;
  #dropped = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  take(): boolean {
    const now = this.#now();
    const interval = 1000 / EVENT_RATE;
    const due = Math.max(this.#due, now);
    if (due - now <= (EVENT_BURST - 1) * interval) {
      this.#due = due + interval;
      return true;
    }
    if (this.#dropped++ === 0) this.#timer = setTimeout(() => this.flush(), DROP_LOG_MS);
    return false;
  }

  /** Logs the count dropped since the minute started, if any, and ends that minute. */
  flush(): void {
    clearTimeout(this.#timer);
    const n = this.#dropped;
    if (n === 0) return;
    this.#dropped = 0;
    console.log(`[events] dropped ${n} game event${n === 1 ? '' : 's'} in the last minute: over ${EVENT_RATE} a second (${EVENT_BURST} at once)`);
  }
}

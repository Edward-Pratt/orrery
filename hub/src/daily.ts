/** Parses a 24-hour "HH:MM"; null if invalid. */
export function parseDaily(time: string): { h: number; m: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? { h: Number(match[1]), m: Number(match[2]) } : null;
}

/**
 * The next moment, strictly after `now`, that is `leadMs` before local time h:m. Recomputed from the local
 * clock every time (never "+24 h"), so a DST change doesn't shift it by an hour.
 */
export function nextDaily(time: { h: number; m: number }, leadMs: number, now: number): number {
  const d = new Date(now);
  d.setHours(time.h, time.m, 0, 0);
  while (d.getTime() - leadMs <= now) {
    d.setDate(d.getDate() + 1);
    d.setHours(time.h, time.m, 0, 0); // again: a time inside a spring-forward gap was rolled on an hour
  }
  return d.getTime() - leadMs;
}

/**
 * Calls fn(target) every day at local "HH:MM" minus `leadMs`; `target` is the scheduled time, so a timer that
 * fires a little early still knows which day it's for. Returns a cancel function. Throws on a bad time.
 */
export function everyDay(time: string, leadMs: number, fn: (target: number) => void): () => void {
  const hm = parseDaily(time);
  if (!hm) throw new Error(`must be HH:MM (24-hour), got "${time}"`);
  let timer: NodeJS.Timeout | undefined;
  // `after` is the target that just fired: timers can fire a millisecond early, and computing the next target
  // from Date.now() alone would then pick the same one again.
  const arm = (after: number) => {
    const target = nextDaily(hm, leadMs, Math.max(Date.now(), after));
    timer = setTimeout(() => {
      try {
        fn(target);
      } catch (err) {
        console.error(`[daily] ${time} task failed:`, err);
      }
      arm(target);
    }, target - Date.now());
  };
  arm(0);
  return () => clearTimeout(timer);
}

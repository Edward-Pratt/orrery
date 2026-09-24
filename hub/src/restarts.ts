import type { ServerHub } from './servers.ts';

type Hub = Pick<ServerHub, 'runCommand' | 'on' | 'get'>;
type Pending = { at: number; by: string; timers: NodeJS.Timeout[] };

/** In-game warnings, as time left before the restart. */
const WARNINGS_MS = [600_000, 300_000, 60_000, 30_000, 10_000];
/** A daily restart starts its countdown this long before the configured time. */
const DAILY_LEAD_MS = 10 * 60_000;

export function countdownText(ms: number): string {
  if (ms >= 60_000) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`;
  return `${ms / 1000} seconds`;
}

/** Parses a 24-hour "HH:MM"; null if invalid. */
export function parseDaily(time: string): { h: number; m: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? { h: Number(match[1]), m: Number(match[2]) } : null;
}

/**
 * The next moment, strictly after `now`, that is `leadMs` before local time h:m. Recomputed from the local
 * clock every time (never "+24 h"), so a DST change doesn't shift the restart by an hour.
 */
export function nextDaily(time: { h: number; m: number }, leadMs: number, now: number): number {
  const d = new Date(now);
  d.setHours(time.h, time.m, 0, 0);
  while (d.getTime() - leadMs <= now) d.setDate(d.getDate() + 1);
  return d.getTime() - leadMs;
}

/**
 * Countdown restarts: in-game warnings, then `stop` (systemd's Restart=always brings the server back).
 * Lives in the hub core so the web dashboard can use it too. Pending restarts are in memory only.
 */
export class RestartScheduler {
  #hub: Hub;
  #notify: (serverId: string, text: string) => void;
  #pending = new Map<string, Pending>();
  #daily = new Map<string, NodeJS.Timeout>();

  constructor(hub: Hub, notify: (serverId: string, text: string) => void) {
    this.#hub = hub;
    this.#notify = notify;
    hub.on('event', (e) => {
      if ((e.type === 'stopped' || e.type === 'crashed') && this.#clear(e.serverId)) {
        this.#notify(e.serverId, '❎ Restart cancelled (server went down)');
      }
    });
  }

  /** Throws if minutes isn't a whole number 0–60, the server is offline, or a restart is already pending. */
  schedule(serverId: string, minutes: number, by: string): void {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) {
      throw new Error('minutes must be a whole number from 0 to 60');
    }
    if (!this.#hub.get(serverId)?.online) throw new Error(`${serverId} is offline`);
    if (this.#pending.has(serverId)) throw new Error('a restart is already scheduled (use /restart cancel first)');
    const delay = minutes * 60_000;
    const timers = WARNINGS_MS.filter((w) => w <= delay).map((w) => setTimeout(() => this.#warn(serverId, w), delay - w));
    timers.push(setTimeout(() => this.#fire(serverId), delay));
    this.#pending.set(serverId, { at: Date.now() + delay, by, timers });
    if (delay) this.#notify(serverId, `🔄 Restart in ${countdownText(delay)} (by ${by})`);
  }

  /** False if nothing was pending. */
  cancel(serverId: string, by: string): boolean {
    if (!this.#clear(serverId)) return false;
    this.#notify(serverId, `❎ Restart cancelled (by ${by})`);
    this.#say(serverId, 'say Restart cancelled');
    return true;
  }

  pending(serverId: string): { at: number; by: string } | undefined {
    const p = this.#pending.get(serverId);
    return p && { at: p.at, by: p.by };
  }

  /** Arms a daily restart at local "HH:MM" (countdown starts 10 minutes before). Throws on a bad time. */
  daily(serverId: string, time: string): void {
    const hm = parseDaily(time);
    if (!hm) throw new Error(`server "${serverId}": dailyRestart must be HH:MM (24-hour), got "${time}"`);
    const arm = () => {
      const delay = nextDaily(hm, DAILY_LEAD_MS, Date.now()) - Date.now();
      this.#daily.set(
        serverId,
        setTimeout(() => {
          try {
            this.schedule(serverId, DAILY_LEAD_MS / 60_000, 'daily');
          } catch (err) {
            console.error(`[restart] daily restart of ${serverId} skipped: ${(err as Error).message}`);
          }
          arm();
        }, delay),
      );
    };
    arm();
  }

  /** Clears every timer (hub shutdown). */
  stop(): void {
    for (const id of [...this.#pending.keys()]) this.#clear(id);
    for (const timer of this.#daily.values()) clearTimeout(timer);
    this.#daily.clear();
  }

  #clear(serverId: string): boolean {
    const p = this.#pending.get(serverId);
    if (!p) return false;
    for (const timer of p.timers) clearTimeout(timer);
    this.#pending.delete(serverId);
    return true;
  }

  #say(serverId: string, command: string): void {
    this.#hub
      .runCommand(serverId, command, 'restart')
      .catch((err: Error) => console.error(`[restart] "${command}" on ${serverId} failed: ${err.message}`));
  }

  #warn(serverId: string, msLeft: number): void {
    this.#say(serverId, `say Server restarting in ${countdownText(msLeft)}`);
  }

  #fire(serverId: string): void {
    const p = this.#pending.get(serverId);
    if (!p) return;
    this.#clear(serverId); // first, so the `stopped` event this causes isn't reported as a cancellation
    this.#notify(serverId, '🔄 Restarting now');
    this.#hub.runCommand(serverId, 'stop', p.by).catch((err: Error) => {
      if (err.message === 'server disconnected') return; // it shut down before replying: that's success
      console.error(`[restart] stop on ${serverId} failed: ${err.message}`);
      this.#notify(serverId, `❌ Restart failed: ${err.message}`);
    });
  }
}

import { everyDay } from './daily.ts';
import type { ServerHub } from './servers.ts';

type Hub = Pick<ServerHub, 'runCommand' | 'on' | 'get' | 'publish' | 'audit'>;
type Pending = { at: number; by: string; byName: string; stop: boolean; fire?: () => Promise<void>; timers: NodeJS.Timeout[] };
/** A stop countdown (`stop`) and what it runs at the end instead of the `stop` command (`fire`). */
export type CountdownOptions = { stop?: boolean; fire?: () => Promise<void> };

/** In-game warnings, as time left before the restart. */
const WARNINGS_MS = [600_000, 300_000, 60_000, 30_000, 10_000];
/** A daily restart starts its countdown this long before the configured time. */
const DAILY_LEAD_MS = 10 * 60_000;

export function countdownText(ms: number): string {
  if (ms >= 60_000) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`;
  return `${ms / 1000} seconds`;
}

/**
 * Countdown restarts: in-game warnings, then `stop` (systemd's Restart=always brings the server back). A countdown
 * can instead be a stop that ends in its own action (stopping the server's service, so it stays down).
 * Lives in the hub core so the web dashboard can use it too; its notices go on the hub's event stream. Pending
 * restarts are in memory only.
 */
export class RestartScheduler {
  #hub: Hub;
  #pending = new Map<string, Pending>();
  #daily = new Map<string, () => void>(); // serverId -> cancel

  constructor(hub: Hub) {
    this.#hub = hub;
    hub.on('event', (e) => {
      if ((e.type === 'stopped' || e.type === 'crashed') && this.#clear(e.serverId)) {
        hub.publish(e.serverId, { severity: 'info', kind: 'restartCancelledDown' });
      }
    });
  }

  /**
   * `by` goes to the audit log, now and with the `stop` command (e.g. "discord:alice (123)"); `byName` is shown
   * to people. Throws if minutes isn't a whole number 0–60, the server is offline, or a restart is already pending.
   */
  schedule(serverId: string, minutes: number, by: string, byName = by, { stop = false, fire }: CountdownOptions = {}): void {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) {
      throw new Error('minutes must be a whole number from 0 to 60');
    }
    if (!this.#hub.get(serverId)?.online) throw new Error(`${serverId} is offline`);
    if (this.#pending.has(serverId)) throw new Error('a restart is already scheduled (use /restart cancel first)');
    const delay = minutes * 60_000;
    const timers = WARNINGS_MS.filter((w) => w <= delay).map((w) => setTimeout(() => this.#warn(serverId, w), delay - w));
    timers.push(setTimeout(() => this.#fire(serverId), delay));
    this.#pending.set(serverId, { at: Date.now() + delay, by, byName, stop, fire, timers });
    this.#hub.audit(by, stop ? 'stop' : 'restart', serverId, `in ${minutes} min`);
    if (delay) this.#hub.publish(serverId, { severity: 'info', kind: 'restartScheduled', ms: delay, by: byName, ...this.#stop(stop) });
  }

  /** False if nothing was pending. `by` and `byName` as for `schedule`. */
  cancel(serverId: string, by: string, byName = by): boolean {
    const stop = this.#pending.get(serverId)?.stop;
    if (!this.#clear(serverId)) return false;
    this.#hub.audit(by, 'restart cancel', serverId);
    this.#hub.publish(serverId, { severity: 'info', kind: 'restartCancelled', by: byName });
    this.#say(serverId, stop ? 'say Stop cancelled' : 'say Restart cancelled');
    return true;
  }

  pending(serverId: string): { at: number; by: string; stop: boolean } | undefined {
    const p = this.#pending.get(serverId);
    return p && { at: p.at, by: p.byName, stop: p.stop };
  }

  /** Arms (or re-arms) a daily restart at local "HH:MM"; the countdown starts 10 minutes before. Throws on a bad time. */
  daily(serverId: string, time: string): void {
    // Arm first: everyDay throws on a bad time, and the earlier daily restart must survive that.
    const cancel = everyDay(time, DAILY_LEAD_MS, () => {
      try {
        this.schedule(serverId, DAILY_LEAD_MS / 60_000, 'hub:daily', 'daily');
      } catch (err) {
        console.error(`[restart] daily restart of ${serverId} skipped: ${(err as Error).message}`);
      }
    });
    this.#daily.get(serverId)?.(); // replace, don't stack, an earlier daily restart
    this.#daily.set(serverId, cancel);
  }

  /** Clears every timer (hub shutdown). */
  stop(): void {
    for (const id of [...this.#pending.keys()]) this.#clear(id);
    for (const cancel of this.#daily.values()) cancel();
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
      .runCommand(serverId, command, 'hub:restart')
      .catch((err: Error) => console.error(`[restart] "${command}" on ${serverId} failed: ${err.message}`));
  }

  /** Marks a notice as about a stop; restart notices stay as they were. */
  #stop(stop: boolean): { stop?: true } {
    return stop ? { stop } : {};
  }

  #warn(serverId: string, msLeft: number): void {
    const verb = this.#pending.get(serverId)?.stop ? 'stopping' : 'restarting';
    this.#say(serverId, `say Server ${verb} in ${countdownText(msLeft)}`);
  }

  #fire(serverId: string): void {
    const p = this.#pending.get(serverId);
    if (!p) return;
    this.#clear(serverId); // first, so the `stopped` event this causes isn't reported as a cancellation
    this.#hub.publish(serverId, { severity: 'info', kind: 'restartNow', ...this.#stop(p.stop) });
    (p.fire?.() ?? this.#hub.runCommand(serverId, 'stop', p.by)).catch((err: Error) => {
      if (err.message === 'server disconnected') return; // it shut down before replying: that's success
      console.error(`[restart] stop on ${serverId} failed: ${err.message}`);
      this.#hub.publish(serverId, { severity: 'problem', kind: 'restartFailed', error: err.message });
    });
  }
}

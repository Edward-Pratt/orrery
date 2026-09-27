import { execFile } from 'node:child_process';
import type { ServiceStatus } from './api.ts';
import type { CheckConfig, ServiceConfig } from './config.ts';
import type { ServerHub } from './servers.ts';

/** Runs systemctl or journalctl (no shell): resolves with its output, rejects with its error output. */
export type Run = (command: 'systemctl' | 'journalctl', args: string[]) => Promise<string>;

export const execRun: Run = (command, args) =>
  new Promise((resolve, reject) =>
    execFile(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    ),
  );

const WATCH_MS = 5_000;
const LOG_LINES = 200;

/**
 * The listed systemd units: reads each one's state at startup and every 5 s, and puts changes on the event stream
 * (a failure is also a notice); reads their recent logs from journald. Only listed units are ever passed to `run`,
 * after `--` or as `--unit=`. Hub core.
 */
export class Services {
  #hub: Pick<ServerHub, 'publishTarget'>;
  #run: Run;
  #services: Map<string, ServiceConfig>;
  #checks: CheckConfig[];
  #states = new Map<string, { state: string; sub: string }>();
  #timer: NodeJS.Timeout | undefined;
  #watching = false;

  constructor(hub: Pick<ServerHub, 'publishTarget'>, services: ServiceConfig[], checks: CheckConfig[], run: Run) {
    this.#hub = hub;
    this.#run = run;
    this.#services = new Map(services.map((s) => [s.id, s]));
    this.#checks = checks;
  }

  start(): void {
    void this.#watch();
    this.#timer = setInterval(() => void this.#watch(), WATCH_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  list(): ServiceStatus[] {
    return [...this.#services.values()].map((s) => ({
      id: s.id,
      unit: s.unit,
      state: this.#states.get(s.id)?.state ?? null,
      sub: this.#states.get(s.id)?.sub ?? null,
      checks: this.#checks.filter((c) => c.service === s.id).map((c) => c.id),
    }));
  }

  /** A listed service's recent log lines, oldest first; undefined for an id that isn't listed. Rejects if journalctl fails. */
  async logs(id: string): Promise<string[] | undefined> {
    const s = this.#services.get(id);
    if (!s) return undefined;
    const out = await this.#run('journalctl', [`--unit=${s.unit}`, `--lines=${LOG_LINES}`, '--no-pager', '--output=short-iso']);
    return out.split('\n').filter((line) => line !== '');
  }

  async #watch(): Promise<void> {
    if (this.#watching) return; // the last round is still waiting on systemctl
    this.#watching = true;
    try {
      for (const s of this.#services.values()) await this.#read(s);
    } finally {
      this.#watching = false;
    }
  }

  async #read(s: ServiceConfig): Promise<void> {
    let out: string;
    try {
      out = await this.#run('systemctl', ['show', '--property=ActiveState,SubState', '--', s.unit]);
    } catch (err) {
      console.error(`[services] reading ${s.unit} failed:`, (err as Error).message);
      return;
    }
    const prop = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1] ?? 'unknown';
    const now = { state: prop('ActiveState'), sub: prop('SubState') };
    const was = this.#states.get(s.id);
    this.#states.set(s.id, now);
    const at = { target: 'service', id: s.id } as const;
    if (was && (was.state !== now.state || was.sub !== now.sub)) this.#hub.publishTarget({ ...at, type: 'state', ...now });
    if (now.state === 'failed' && was?.state !== 'failed') {
      this.#hub.publishTarget({ ...at, type: 'notice', severity: 'problem', kind: 'serviceFailed', unit: s.unit });
    }
  }
}

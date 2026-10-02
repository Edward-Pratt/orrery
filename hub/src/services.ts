import { execFile } from 'node:child_process';
import type { CheckConfig, ServerSettings, ServiceConfig } from './config.ts';
import type { RestartScheduler } from './restarts.ts';
import type { ServerHub, ServiceStatus, ServiceVerb } from './servers.ts';

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
/** The in-game countdown before a linked server with players online is stopped or restarted. */
const CLEAN_STOP_MINUTES = 5;

export const VERBS: ServiceVerb[] = ['start', 'stop', 'restart'];

/** A stop or restart was asked for while a countdown already runs on the linked server. */
export class CountdownRunning extends Error {
  constructor(serverName: string) {
    super(`a countdown is already running on ${serverName}`);
  }
}

type Hub = Pick<ServerHub, 'publishTarget' | 'audit' | 'get'>;

/**
 * The listed systemd units: reads each one's state at startup and every 5 s, and puts changes on the event stream
 * (a failure is also a notice); reads their recent logs from journald; starts, stops and restarts them. Stopping or
 * restarting one whose linked server has players online runs the server's countdown first. Only listed units are
 * ever passed to `run`, after `--` or as `--unit=`. Hub core.
 */
export class Services {
  #hub: Hub;
  #run: Run;
  #restarts: RestartScheduler;
  #services: Map<string, ServiceConfig>;
  #checks: CheckConfig[];
  #servers = new Map<string, string>(); // service id -> the id of the server that runs as it
  #states = new Map<string, { state: string; sub: string }>();
  #timer: NodeJS.Timeout | undefined;
  #watching = false;

  constructor(
    hub: Hub,
    restarts: RestartScheduler,
    services: ServiceConfig[],
    servers: Pick<ServerSettings, 'id' | 'service'>[],
    checks: CheckConfig[],
    run: Run,
  ) {
    this.#hub = hub;
    this.#restarts = restarts;
    this.#run = run;
    this.#services = new Map(services.map((s) => [s.id, s]));
    for (const s of servers) if (s.service) this.#servers.set(s.service, s.id);
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

  has(id: string): boolean {
    return this.#services.has(id);
  }

  /** The service a server runs as, if it is linked to one. */
  ofServer(serverId: string): ServiceStatus | undefined {
    const id = [...this.#servers].find(([, server]) => server === serverId)?.[0];
    return this.list().find((s) => s.id === id);
  }

  /**
   * Starts, stops or restarts a listed service (`by` goes to the audit log, `byName` to players), without waiting
   * for systemd to finish. With players online on its linked server, a stop or restart first counts down in game,
   * and it resolves with when the action will run; otherwise at once, with null. Audited once it is run or counting
   * down. Rejects if systemctl fails, or with `CountdownRunning`.
   */
  async act(id: string, verb: ServiceVerb, by: string, byName: string): Promise<number | null> {
    const s = this.#services.get(id)!;
    const serverId = this.#servers.get(id);
    const server = serverId === undefined ? undefined : this.#hub.get(serverId);
    const run = async () => void (await this.#run('systemctl', [verb, '--no-block', '--', s.unit]));
    let at: number | null = null;
    if (verb !== 'start' && server?.online && server.players.length) {
      if (this.#restarts.pending(server.id)) throw new CountdownRunning(server.name);
      // systemctl stop, not the game's own stop: systemd's Restart=always must not bring the server back.
      this.#restarts.schedule(server.id, CLEAN_STOP_MINUTES, by, byName, { stop: verb === 'stop', fire: run });
      at = this.#restarts.pending(server.id)!.at;
    } else {
      await run();
    }
    this.#hub.audit(by, `service ${verb}`, id, at === null ? s.unit : `${s.unit}, after a ${CLEAN_STOP_MINUTES} min countdown`);
    return at;
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

  /** Reads a listed service's state from systemd now (rather than at the next round); undefined if unlisted or unread. */
  async read(id: string): Promise<ServiceStatus | undefined> {
    const s = this.#services.get(id);
    if (!s) return undefined;
    await this.#read(s);
    return this.list().find((x) => x.id === id);
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

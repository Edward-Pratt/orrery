import { execFile } from 'node:child_process';
import type { Agents } from './agents.ts';
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

/** Where a service runs: on this machine (systemctl and journalctl through `Run`) or on an Agent's Host. */
type Backend = { act: (verb: ServiceVerb) => Promise<void>; logs: () => Promise<string[]> };

/**
 * The listed systemd units: reads each one's state at startup and every 5 s, and puts changes on the event stream
 * (a failure is also a notice); reads their recent logs from journald; starts, stops and restarts them. Stopping or
 * restarting one whose linked server has players online runs the server's countdown first. Only listed units are
 * ever passed to `run`, after `--` or as `--unit=`. A service an Agent backs (the `service` of the server it runs) is
 * never passed to `run`: its state is what the Agent last pushed (`serviceState`), and its actions and logs are the
 * Agent's `serviceAct` and `journal` requests. Hub core.
 */
export class Services {
  #hub: Hub;
  #run: Run;
  #restarts: RestartScheduler;
  #services: Map<string, ServiceConfig>;
  #checks: CheckConfig[];
  #servers = new Map<string, string>(); // service id -> the id of the server that runs as it
  #agents: Pick<Agents, 'request'> | undefined;
  #agentOf = new Map<string, string>(); // service id -> the id of the Agent that backs it
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
    agents?: Pick<Agents, 'list' | 'request' | 'on'>,
  ) {
    this.#hub = hub;
    this.#restarts = restarts;
    this.#run = run;
    this.#services = new Map(services.map((s) => [s.id, s]));
    for (const s of servers) if (s.service) this.#servers.set(s.service, s.id);
    this.#checks = checks;
    this.#agents = agents;
    for (const a of agents?.list() ?? []) {
      const id = [...this.#servers].find(([, server]) => server === a.server)?.[0];
      if (id !== undefined && this.#services.has(id)) this.#agentOf.set(id, a.id);
    }
    agents?.on('serviceState', (agentId, msg) => {
      const id = [...this.#agentOf].find(([, agent]) => agent === agentId)?.[0];
      // Its first state too: unlike a local unit's, read at startup, it comes whenever the Agent connects.
      if (id !== undefined) this.#set(this.#services.get(id)!, { state: msg.active, sub: msg.sub }, true);
    });
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
   * down. Rejects if systemctl (or the Agent) fails, or with `CountdownRunning`.
   */
  async act(id: string, verb: ServiceVerb, by: string, byName: string): Promise<number | null> {
    const s = this.#services.get(id)!;
    const serverId = this.#servers.get(id);
    const server = serverId === undefined ? undefined : this.#hub.get(serverId);
    const run = () => this.#backend(s).act(verb);
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

  /**
   * Starts, stops or restarts a listed service now, with no countdown whoever is online (a countdown that already ran
   * ends in it: a factorio server's restart), without waiting for systemd to finish. Audited as `by`. Rejects for an
   * unlisted id, or if systemctl (or the Agent) fails.
   */
  async now(id: string, verb: ServiceVerb, by: string): Promise<void> {
    const s = this.#services.get(id);
    if (!s) throw new Error(`no service ${id}`);
    await this.#backend(s).act(verb);
    this.#hub.audit(by, `service ${verb}`, id, s.unit);
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

  /** A listed unit's `Environment=` settings as systemd shows them (`A=b C=d`); undefined if unknown or unreadable. */
  async environment(id: string): Promise<string | undefined> {
    const s = this.#services.get(id);
    if (!s || this.#agentOf.has(id)) return undefined; // an Agent's unit isn't on this machine
    try {
      const out = await this.#run('systemctl', ['show', '--property=Environment', '--', s.unit]);
      return /^Environment=(.*)$/m.exec(out)?.[1];
    } catch (err) {
      console.error(`[services] reading ${s.unit}'s environment failed:`, (err as Error).message);
      return undefined;
    }
  }

  /**
   * Reads a listed service's state from systemd now (rather than at the next round); an Agent's, as it last pushed
   * it. Undefined if unlisted or unread.
   */
  async read(id: string): Promise<ServiceStatus | undefined> {
    const s = this.#services.get(id);
    if (!s) return undefined;
    if (!this.#agentOf.has(id)) await this.#read(s);
    return this.list().find((x) => x.id === id);
  }

  /**
   * A listed service's recent log lines, oldest first (an Agent's: its unit's log file); undefined for an id that
   * isn't listed. Rejects if journalctl (or the Agent) fails.
   */
  async logs(id: string): Promise<string[] | undefined> {
    const s = this.#services.get(id);
    return s && this.#backend(s).logs();
  }

  /** How a listed service is run: through its Agent's requests, else systemctl and journalctl here. */
  #backend(s: ServiceConfig): Backend {
    const agentId = this.#agentOf.get(s.id);
    if (agentId !== undefined) {
      const agents = this.#agents!; // set whenever an Agent backs a service
      return {
        act: (action) => agents.request(agentId, { type: 'serviceAct', action }),
        logs: async () => (await agents.request(agentId, { type: 'journal', unit: s.unit })).lines,
      };
    }
    return {
      act: async (verb) => void (await this.#run('systemctl', [verb, '--no-block', '--', s.unit])),
      logs: async () => {
        const out = await this.#run('journalctl', [`--unit=${s.unit}`, `--lines=${LOG_LINES}`, '--no-pager', '--output=short-iso']);
        return out.split('\n').filter((line) => line !== '');
      },
    };
  }

  async #watch(): Promise<void> {
    if (this.#watching) return; // the last round is still waiting on systemctl
    this.#watching = true;
    try {
      for (const s of this.#services.values()) if (!this.#agentOf.has(s.id)) await this.#read(s);
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
    this.#set(s, { state: prop('ActiveState'), sub: prop('SubState') });
  }

  /** Keeps a service's state, putting a change (with `first`, the first state too) on the stream, a failure also as a notice. */
  #set(s: ServiceConfig, now: { state: string; sub: string }, first = false): void {
    const was = this.#states.get(s.id);
    this.#states.set(s.id, now);
    const at = { target: 'service', id: s.id } as const;
    if (was ? was.state !== now.state || was.sub !== now.sub : first) this.#hub.publishTarget({ ...at, type: 'state', ...now });
    if (now.state === 'failed' && was?.state !== 'failed') {
      this.#hub.publishTarget({ ...at, type: 'notice', severity: 'problem', kind: 'serviceFailed', unit: s.unit });
    }
  }
}

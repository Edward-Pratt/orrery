// What the first-boot checks (`check.ts`) share: `WAITS` (how long each step may take), `PATHS` (where the check reads
// the system: `/proc`, SELinux's `enforce`, the generator and Quadlet folders), `CheckOptions` (those, the `systemctl`
// and the host readers, all for tests), the `Report` (a line per check as it ends, counted by mark), and `CheckCtx`:
// the config, the check's own `RconSession` (its `run` notes each reply's size for S8 and the password's fate for
// S21), its `Saves` and `ServiceWatch` on the server's unit, and what earlier checks found for later ones (whether RCON
// answered since the last start, why the stops can't run, the runs seen, S1's save, when the agent's unit started).
import { join } from 'node:path';
import type { Config } from './config.ts';
import { procReaders, type HostReaders } from './host.ts';
import { RconRefused, RconSession } from './rcon.ts';
import { Saves } from './saves.ts';
import { ServiceWatch, systemctl, type Systemctl } from './service.ts';

/** How long each step may take, in ms (tests shorten them). */
export const WAITS = {
  /** RCON's first answer after a start: factorio.service's TimeoutStartSec, since Factorio may still load the map. */
  rcon: 300_000,
  retry: 5000,
  /** One RCON command, or connecting. */
  command: 10_000,
  /** A stop: factorio.service's TimeoutStopSec (Podman's --stop-timeout is 170 s). */
  stop: 200_000,
  /** S1's save: its file within 60 s (the notes), then held as long as `Saves` wants. */
  save: 60_000,
  stable: 5000,
  /** Between looks at the unit, a file or agent.log. */
  poll: 1000,
  /** S16: orrery-agent.service running, then its restart count held for longer than its RestartSec=5. */
  agent: 30_000,
  restarts: 6000,
  /** S4: the agent's 60 s for Factorio's "Opening socket" line, then its 5 s for the mod's hello. */
  events: 65_000,
  /** S4 with the agent down: the mod's hello to the check's own listener. */
  hello: 5000,
  /** A TCP connection to the hub. */
  hub: 5000,
  /** The hub's welcome, as the agent's `connected` file shows it. */
  welcome: 30_000,
  /** Between the two CPU readings of the host sample. */
  cpu: 1000,
};

/** Where the check reads the system (tests point them at a temp folder). */
export const PATHS = {
  proc: '/proc',
  selinux: '/sys/fs/selinux/enforce',
  /** Where systemd's generators (Quadlet) write units. */
  generator: '/run/systemd/generator',
  quadlet: '/etc/containers/systemd',
};

export type CheckOptions = {
  waits?: Partial<typeof WAITS>;
  paths?: Partial<typeof PATHS>;
  /** For both units: the server's (through `ServiceWatch`) and the agent's own (`show` only). */
  systemctl?: Systemctl;
  read?: HostReaders;
};

export type Mark = 'ok' | 'FAIL' | 'warn';

/** The report: a line per check as it ends (console.log: a pipe is written at once on Linux), counted by mark. */
export class Report {
  counts: Record<Mark, number> = { ok: 0, FAIL: 0, warn: 0 };

  say(mark: Mark, what: string): void {
    this.counts[mark]++;
    console.log(`${mark.padEnd(4)} ${what}`);
  }

  /** What a long step is doing, so a live report never looks hung. */
  note(what: string): void {
    console.log(`     ${what}`);
  }
}

/** One run of the server's unit, from the check's view: its change time and the Factorio version RCON gave. */
export type Run = { since: number; version: string };

/** What the checks share: the options, the check's own RCON session, unit and saves, and what earlier ones found. */
export class CheckCtx {
  readonly c: Config;
  readonly w: typeof WAITS;
  readonly p: typeof PATHS;
  readonly systemctl: Systemctl;
  readonly hostReaders: HostReaders;
  readonly report: Report;
  readonly service: ServiceWatch;
  readonly rcon: RconSession;
  readonly saves: Saves;
  readonly log: string;
  /** The biggest RCON reply seen, in bytes (S8). */
  largest = 0;
  /** Whether RCON took the password (S21). */
  auth: 'unknown' | 'ok' | 'refused' = 'unknown';
  /** RCON answered since the last start. */
  up = false;
  /** Why the stops (S1, S20, S3, S5) can't run: players on, or auto_pause off. */
  gate: string | null = null;
  runs: Run[] = [];
  /** The change time of the run RCON last answered for. */
  since = 0;
  /** S1's save, and the tick just before it was made (no later than the tick it holds). */
  a: { name: string; tick: number } | null = null;
  /** When orrery-agent.service last became active (S16), for its log lines and the hub's welcome. */
  agentSince: number | null = null;

  constructor(config: Config, report: Report, o: CheckOptions) {
    this.c = config;
    this.w = { ...WAITS, ...o.waits };
    this.p = { ...PATHS, ...o.paths };
    this.systemctl = o.systemctl ?? systemctl();
    this.hostReaders = o.read ?? procReaders;
    this.report = report;
    const { server } = config;
    this.log = join(server.data, 'factorio-current.log');
    this.service = new ServiceWatch(server.unit, this.systemctl);
    this.rcon = new RconSession(server.rconPort, config.rconPassword, this.w.command);
    this.saves = new Saves({
      dir: join(server.data, 'saves'),
      log: this.log,
      run: this.run,
      unit: () => this.service.read(),
      pollMs: this.w.poll,
      stableMs: this.w.stable,
      waitMs: this.w.save,
    });
  }

  /** An RCON command on the check's own connection, its reply's size noted (S8) and the password's fate (S21). */
  run = async (command: string): Promise<string> => {
    let reply: string;
    try {
      reply = await this.rcon.exec(command);
    } catch (err) {
      if (err instanceof RconRefused) this.auth = 'refused';
      throw err;
    }
    this.auth = 'ok';
    this.largest = Math.max(this.largest, Buffer.byteLength(reply));
    return reply;
  };
}

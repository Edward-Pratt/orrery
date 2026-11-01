// The first-boot check (`index.ts check`): setup's last step, run as factorio with the two secrets in its environment
// only, after setup started factorio.service and orrery-agent.service. A report on stdout, each line printed as its
// check ends, so setup can show it live; true (exit 0) only when no check failed. Each of the design's first-boot
// smoke checks (docs/notes/factorio-agent.md) the agent can make from its seat gets a line, in the order they run (S1,
// S2, S20, S3, S5, S4, S6, S8, S16, S21, S25, S29); the others end the report, naming who makes them. Whatever RCON or
// a file the container writes says goes through `printable`, and no secret is ever printed.
import { createSocket } from 'node:dgram';
import { constants, lstat, open, readdir, readFile, readlink, type FileHandle } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.ts';
import { ENGINE, openingLine, parseDatagram, socketState } from './events.ts';
import { head, openPlain, tail } from './files.ts';
import { HostSampler, procReaders, type HostReaders } from './host.ts';
import { AGENT_LOG, AGENT_UNIT } from './logs.ts';
import { RconRefused, RconSession } from './rcon.ts';
import { Saves, loadedMap, type BackupResult } from './saves.ts';
import { ServiceWatch, systemctl, type Systemctl, type UnitState } from './service.ts';
import { parseStatus, readAutoPause, type Status } from './status.ts';
import { printable } from './wire.ts';

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

/** The mods setup's mod-list.json enables (S29). */
const SETUP_MODS = ['base', 'space-age', 'quality', 'elevated-rails', 'recycler', 'orrery'];
/**
 * `/orrery-status` commands sent before a stop: each runs exactly one tick while auto-paused (smoke-x64 section 1), so
 * the map is this far past S1's save, and a start that loaded the wrong save shows in the tick.
 */
const MARGIN = 200;
/** Podman's --stop-timeout: Factorio has this long after SIGINT to save and exit (S5). */
const STOP_MS = 170_000;
/** Source RCON servers split replies at this size; Factorio sends any size as one packet (S8). */
const SOURCE_SPLIT = 4096;
/** Far past where Factorio logs the map it loads, and a cap on the small files read. */
const MiB = 1024 * 1024;
/** Lines of a log read for its shutdown: "Saving progress" lines come between SIGINT and Goodbye. */
const TAIL = 2000;

/** The smoke checks the agent can't make from its seat: who makes each, and how. Printed at the end, as a to-do. */
const OTHERS: readonly string[] = [
  'S4 players: no game event lost under load (agent.log logs every seq gap)',
  'S7 players: on_player_changed_surface does not fire on remote view, or the landing check ignores it',
  'S9 owner: the portal zip layout and changelog, from the factorio-v1.0.0 upload and its portal page',
  'S10 owner and friend: join once; orrery downloads from the portal, and each player needs Space Age',
  'S11 owner: the signed dl-mod.factorio.com redirect, on the hub host (passed 2026-10-31)',
  "S12 owner: the factorio.com service token's scope (moot while S11 holds)",
  'S13 friend and owner: a port scan from this VM finds only 25584 open on the hub host (factorio-friend-setup.md)',
  'S14 owner: research and planet names read well in the first Discord posts',
  "S15 owner: the hub's log shows it bound 25584 on the tailnet IP",
  'S17 setup: the image, its glibc and Factorio --version in it (step 8; the first line above)',
  "S18 setup: Podman took every key of the Quadlet file (step 14's dry run; podman --version above)",
  'S19 friend: /quit from the dashboard Console, and once in game, leaves factorio.service inactive with Result=success, and it stays down; kill -9 of the Factorio process gives failed, then a restart after 10 s; ExecStopPost is in the quadlet -dryrun output',
  "S22 friend, as root: journalctl -u factorio.service -n 20 shows Factorio's output",
  "S23 friend, as root: ausearch -m AVC -ts boot shows no denial for the container's ports or mounts (S20 and S3 give the start times)",
  'S24 owner and friend: joining once shows Factorio reaches auth.factorio.com',
  'S26 players: Space Age trigger technologies raise on_research_finished with by_script false',
  'S27 players: a landing raises on_cargo_pod_finished_descending with player_index',
  'S28 players: a first platform leaves starter_pack_on_the_way',
  'S30 players: a death names its cause',
  "S31 owner: a newer Factorio's save does not load in an older one (release 2's forced rollback)",
  "S32 players: an admin's pause with players on stops the tick",
];

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const span = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 6000) / 10} minutes` : `${ms / 1000} s`);
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const isStopped = (s: UnitState) => s.active === 'inactive' || s.active === 'failed';
const describe = (s: UnitState | null) => (s ? `${s.active} (${s.sub}), Result=${s.result}` : 'in an unknown state');
/** A reply quoted for the report: JSON, at most 200 characters of it, `printable`. */
const quote = (reply: string) => printable(JSON.stringify(reply.slice(0, 200)));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Factorio's shutdown lines (smoke-x64 section 7): the signal and Goodbye carry only the seconds, the save is an engine
 * line, so a mod's `log()` or a chat line can't pass for any of them.
 */
const SIGNAL = /^ *\d+\.\d+ Received (SIG[A-Z]+), shutting down$/;
const SAVING = new RegExp(ENGINE + 'Saving map as (.+)$');
const GOODBYE = /^ *\d+\.\d+ Goodbye$/;

export type Shutdown = { signal: string | null; saved: string | null; goodbye: boolean };

/** What the end of a run's log says about its shutdown: the signal, the file it saved to, whether it said Goodbye. */
export function shutdownOf(lines: string[]): Shutdown {
  const s: Shutdown = { signal: null, saved: null, goodbye: false };
  for (const line of lines) {
    let m: RegExpExecArray | null;
    if ((m = SIGNAL.exec(line))) s.signal = m[1]!;
    else if ((m = SAVING.exec(line))) s.saved = m[1]!;
    else if (GOODBYE.test(line)) s.goodbye = true;
  }
  return s;
}

/** A line of agent.log (`AgentLog`): its time, epoch ms, and what was logged. */
function agentLine(line: string): { at: number; text: string } | null {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) (.*)$/.exec(line);
  return m ? { at: Date.parse(m[1]!), text: m[2]! } : null;
}

/** `/proc/net/udp`'s owner (uid) of the IPv4 socket bound on 127.0.0.1:`port`; null if none. */
export function udpOwner(table: string, port: number): number | null {
  const local = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  for (const line of table.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[1] === local && f[7] !== undefined && /^\d+$/.test(f[7])) return Number(f[7]);
  }
  return null;
}

/** The names `mod-list.json` enables, read defensively (the container writes it): null if it isn't that shape. */
export function enabledMods(text: string): string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || !Array.isArray(raw.mods)) return null;
  return raw.mods.filter((m): m is { name: string } => isObject(m) && m.enabled === true && typeof m.name === 'string').map((m) => m.name);
}

/** A small regular file's text (`O_NOFOLLOW`, `O_NONBLOCK`, at most 1 MiB); null if it isn't one or can't be read. */
async function small(path: string): Promise<string | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile() || st.size > MiB) return null;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** `p`, or null once `ms` passed first; the timer never outlives it. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Null if a TCP connection to the hub opens (and is closed at once, nothing sent), else why not. */
function reach(host: string, port: number, waitMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: waitMs });
    socket.once('connect', () => (socket.destroy(), resolve(null)));
    socket.once('timeout', () => (socket.destroy(), resolve('timed out')));
    socket.once('error', (err) => resolve(err.message));
  });
}

/** How many entries under `root` (it included, never following a link) changed at or after `since`, and the first. */
async function changedSince(root: string, since: number): Promise<{ count: number; first: string | null }> {
  let count = 0;
  let first: string | null = null;
  const walk = async (path: string): Promise<void> => {
    const st = await lstat(path);
    if (st.mtimeMs >= since) {
      count++;
      first ??= path;
    }
    if (st.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
  };
  await walk(root);
  return { count, first };
}

type Mark = 'ok' | 'FAIL' | 'warn';

/** The report: a line per check as it ends (console.log: a pipe is written at once on Linux), counted by mark. */
class Report {
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
type Run = { since: number; version: string };

/** The checks after the config, in their order, sharing what earlier ones found. */
class Checks {
  #c: Config;
  #w: typeof WAITS;
  #p: typeof PATHS;
  #systemctl: Systemctl;
  #hostReaders: HostReaders;
  #report: Report;
  #service: ServiceWatch;
  #rcon: RconSession;
  #saves: Saves;
  #log: string;
  /** The biggest RCON reply seen, in bytes (S8). */
  #largest = 0;
  /** Whether RCON took the password (S21). */
  #auth: 'unknown' | 'ok' | 'refused' = 'unknown';
  /** RCON answered since the last start. */
  #up = false;
  /** Why the stops (S1, S20, S3, S5) can't run: players on, or auto_pause off. */
  #gate: string | null = null;
  #runs: Run[] = [];
  /** The change time of the run RCON last answered for. */
  #since = 0;
  /** S1's save, and the tick just before it was made (no later than the tick it holds). */
  #a: { name: string; tick: number } | null = null;
  /** When orrery-agent.service last became active (S16), for its log lines and the hub's welcome. */
  #agentSince: number | null = null;

  constructor(config: Config, report: Report, o: CheckOptions) {
    this.#c = config;
    this.#w = { ...WAITS, ...o.waits };
    this.#p = { ...PATHS, ...o.paths };
    this.#systemctl = o.systemctl ?? systemctl();
    this.#hostReaders = o.read ?? procReaders;
    this.#report = report;
    const { server } = config;
    this.#log = join(server.data, 'factorio-current.log');
    this.#service = new ServiceWatch(server.unit, this.#systemctl);
    this.#rcon = new RconSession(server.rconPort, config.rconPassword, this.#w.command);
    this.#saves = new Saves({
      dir: join(server.data, 'saves'),
      log: this.#log,
      run: this.#run,
      unit: () => this.#service.read(),
      pollMs: this.#w.poll,
      stableMs: this.#w.stable,
      waitMs: this.#w.save,
    });
  }

  async run(): Promise<void> {
    await this.#step('host:', () => this.#host());
    if (await this.#factorio()) {
      await this.#step('S1', () => this.#s1());
      await this.#step('S2', () => this.#s2());
      await this.#step('S20', () => this.#s20());
      await this.#step('S3', () => this.#s3());
    } else for (const s of ['S1', 'S2', 'S20', 'S3', 'S5']) this.#report.say('warn', `${s} skipped (no RCON)`);
    await this.#ifUp('S4', () => this.#s4());
    await this.#ifUp('S6', () => this.#s6());
    await this.#ifUp('S8', () => this.#s8());
    await this.#step('S16', () => this.#s16());
    await this.#step('S21', () => this.#s21());
    await this.#ifUp('S25', () => this.#s25());
    await this.#ifUp('S29', () => this.#s29());
    await this.#step('hub:', () => this.#hub());
  }

  close(): void {
    this.#rcon.close();
  }

  /** An RCON command on the check's own connection, its reply's size noted (S8) and the password's fate (S21). */
  #run = async (command: string): Promise<string> => {
    let reply: string;
    try {
      reply = await this.#rcon.exec(command);
    } catch (err) {
      if (err instanceof RconRefused) this.#auth = 'refused';
      throw err;
    }
    this.#auth = 'ok';
    this.#largest = Math.max(this.#largest, Buffer.byteLength(reply));
    return reply;
  };

  /** A check whose unexpected error is its FAIL line, so the rest still run. */
  async #step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.#report.say('FAIL', `${name} ${printable((err as Error).message)}`);
    }
  }

  async #ifUp(name: string, fn: () => Promise<void>): Promise<void> {
    if (!this.#up) return this.#report.say('warn', `${name} skipped (no RCON since the last start)`);
    await this.#step(name, fn);
  }

  async #host(): Promise<void> {
    const sampler = new HostSampler(this.#c.mounts, this.#hostReaders);
    await sampler.sample();
    await sleep(this.#w.cpu);
    const s = (await sampler.sample())!;
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    const disks = s.disks.map((d) => `${d.mount} ${gb(d.free)} of ${gb(d.total)} GB free`).join(', ');
    this.#report.say('ok', `host: cpu ${Math.round(s.cpu * 100)}%, load ${s.load.join(' ')}, memory ${gb(s.memory.used)} of ${gb(s.memory.total)} GB used; ${disks}`);
    if (s.disks.length !== this.#c.mounts.length) this.#report.say('FAIL', 'host: a mount in "mounts" can\'t be read');
  }

  /** The unit, then RCON's first answer: false if Factorio isn't there to check. */
  async #factorio(): Promise<boolean> {
    const { unit, rconPort } = this.#c.server;
    const first = await this.#service.read().catch((err: Error) => err);
    if (first instanceof Error) this.#report.say('warn', `unit: can't read ${unit}: ${printable(first.message)}`);
    else if (isStopped(first)) {
      this.#report.say('FAIL', `unit: ${unit} is ${describe(first)}: as root, journalctl -u ${unit} says why`);
      return false;
    }
    this.#report.note(`waiting for /orrery-status over RCON (up to ${span(this.#w.rcon)}: Factorio may still be loading the map)`);
    const status = await this.#answer();
    if (typeof status === 'string') {
      this.#report.say('FAIL', `rcon: 127.0.0.1:${rconPort}: ${status}`);
      return false;
    }
    const since = this.#since ? ` (${unit} active since ${new Date(this.#since).toISOString()})` : '';
    this.#report.say('ok', `rcon: Factorio ${status.version} answers /orrery-status: tick ${status.tick}, ${status.players.length} online${since}`);
    const autoPause = await readAutoPause(join(this.#c.server.data, 'config', 'server-settings.json'));
    this.#gate = status.players.length > 0 ? `${status.players.length} online` : autoPause ? null : 'auto_pause is off';
    return true;
  }

  /**
   * `/orrery-status` once RCON answers, retried for `waits.rcon`, the run it answered for noted; why not, if it didn't.
   * A refused password, or the unit stopped or failed, is final at once: waiting can't change it.
   */
  async #answer(): Promise<Status | string> {
    const { unit } = this.#c.server;
    const until = performance.now() + this.#w.rcon;
    this.#up = false;
    for (;;) {
      let why: string;
      try {
        const status = parseStatus(await this.#run('/orrery-status'));
        if (status) {
          this.#since = (await this.#service.read().catch(() => null))?.since ?? 0;
          this.#runs.push({ since: this.#since, version: status.version });
          this.#up = true;
          return status;
        }
        why = '/orrery-status gave no status (is the orrery mod loaded?)';
      } catch (err) {
        if (err instanceof RconRefused) return 'RCON refused the password: RCON_PASSWORD is not the one factorio.service started with (/etc/orrery-factorio.env)';
        why = printable((err as Error).message);
      }
      const now = await this.#service.read().catch(() => null);
      if (now && isStopped(now)) return `${unit} is ${describe(now)}: as root, journalctl -u ${unit} says why`;
      if (performance.now() + this.#w.retry > until) return why;
      await sleep(this.#w.retry);
    }
  }

  /** Reads the unit until `done` says so or `ms` passed: the last state read, and whether it was done. */
  async #until(done: (s: UnitState) => boolean, ms: number): Promise<{ state: UnitState | null; done: boolean }> {
    const until = performance.now() + ms;
    let state: UnitState | null = null;
    for (;;) {
      state = (await this.#service.read().catch(() => null)) ?? state;
      if (state && done(state)) return { state, done: true };
      if (performance.now() >= until) return { state, done: false };
      await sleep(this.#w.poll);
    }
  }

  /** `MARGIN` × `/orrery-status`, so the map moves on that many ticks while paused: the last answer. */
  async #advance(): Promise<Status> {
    let status: Status | null = null;
    for (let i = 0; i < MARGIN; i++) status = parseStatus(await this.#run('/orrery-status'));
    if (!status) throw new Error('/orrery-status gave no status');
    if (status.players.length > 0) this.#gate = `${status.players.length} online now`;
    return status;
  }

  /** The end of one of Factorio's logs in the data folder: how its run shut down. */
  async #shutdown(name: string): Promise<Shutdown> {
    return shutdownOf((await tail(join(this.#c.server.data, name), TAIL).catch(() => null)) ?? []);
  }

  /** The Factorio version `<install>/current` points at (`releases/<version>`); null if it isn't such a link. */
  async #installed(): Promise<string | null> {
    const target = await readlink(join(this.#c.server.install, 'current')).catch(() => '');
    return /^releases\/(\d+\.\d+\.\d+)$/.exec(target)?.[1] ?? null;
  }

  /** S1: a named save while auto-paused with nobody on. */
  async #s1(): Promise<void> {
    if (this.#gate) return this.#report.say('warn', `S1 skipped (${this.#gate}): the save while paused, and the stops of S20, S3 and S5, need nobody on and auto_pause on`);
    // The tick before the save, not after: the save holds this tick or a later one, so a start from it (S3) can't be
    // behind it. Every RCON command runs a tick while paused, and the agent's own polls too.
    const before = parseStatus(await this.#run('/orrery-status'));
    if (!before) throw new Error('/orrery-status gave no status');
    let result = null as BackupResult | null;
    this.#saves.once('backup', (b) => (result = b));
    const t0 = performance.now();
    await this.#saves.save();
    const took = performance.now() - t0;
    const fallback = 'fallback, while paused skip the named save and record the newest existing save';
    if (!result?.ok) return this.#report.say('FAIL', `S1 ${result?.detail ?? 'no save was made'}: ${fallback}`);
    const a = (await this.#saves.list()).saves.find((s) => s.kind === 'named');
    if (!a) return this.#report.say('FAIL', `S1 ${result.detail}, but saves/ lists no named save: ${fallback}`);
    this.#a = { name: a.name, tick: before.tick };
    this.#report.say('ok', `S1 /orrery-save while paused: ${a.name} (${mb(a.size)}) in ${secs(took)}, from tick ${before.tick}`);
  }

  /** S2: a command over RCON runs with a nil player_index, so a command for players refuses it. */
  async #s2(): Promise<void> {
    const reply = await this.#run('/orrery-unlink');
    let r: unknown = null;
    try {
      r = JSON.parse(reply);
    } catch {
      // not JSON: not the mod's refusal
    }
    if (isObject(r) && Object.keys(r).length === 2 && r.ok === false && r.error === '/orrery-unlink is for players') {
      this.#report.say('ok', 'S2 RCON commands run with player_index nil (/orrery-status answered, /orrery-unlink refused as for players)');
    } else this.#report.say('FAIL', `S2 /orrery-unlink over RCON answered ${quote(reply)}, not "/orrery-unlink is for players"`);
  }

  /** S20: a restart saves before the new run starts, so the map goes on from where it was. */
  async #s20(): Promise<void> {
    if (this.#gate) return this.#report.say('warn', `S20 skipped (${this.#gate})`);
    const tb = await this.#advance();
    if (this.#gate) return this.#report.say('warn', `S20 skipped (${this.#gate})`);
    const { unit } = this.#c.server;
    const before = await this.#service.read();
    this.#report.note(`S20 restarting ${unit}: Factorio saves, then starts again (up to ${span(this.#w.stop + this.#w.rcon)})`);
    const t0 = performance.now();
    await this.#service.act('restart');
    let down = false;
    const after = await this.#until((s) => {
      if (s.active !== 'active') down = true;
      return s.active === 'failed' || (s.active === 'active' && (down || s.since > before.since));
    }, this.#w.stop + this.#w.rcon);
    if (after.state?.active !== 'active' || !after.done) {
      this.#up = false;
      return this.#report.say('FAIL', `S20 ${unit} did not come back after a restart: it is ${describe(after.state)}`);
    }
    const ta = await this.#answer();
    if (typeof ta === 'string') return this.#report.say('FAIL', `S20 no RCON after the restart: ${ta}`);
    const took = performance.now() - t0;
    const end = await this.#shutdown('factorio-previous.log'); // the ended run's log, renamed at this start
    const saved = end.saved ? `saved ${printable(end.saved)}` : 'no "Saving map as" line';
    const evidence = `tick ${tb.tick} -> ${ta.tick}, ${saved}, ${end.goodbye ? 'Goodbye' : 'no Goodbye'}; up again in ${secs(took)}`;
    if (ta.tick >= tb.tick && end.saved && end.goodbye) this.#report.say('ok', `S20 restart saves first: ${evidence}`);
    else this.#report.say('FAIL', `S20 restart lost ticks or did not save (factorio-previous.log): ${evidence}`);
  }

  /**
   * S3 and S5: a stop (S5: SIGINT, saved, exit 0 within 170 s), S1's save restored, a start, which must load the
   * restored copy (`--start-server-load-latest` takes the newest file). Started again whatever failed in between.
   */
  async #s3(): Promise<void> {
    const skip = (why: string) => {
      this.#report.say('warn', `S3 skipped (${why})`);
      this.#report.say('warn', `S5 skipped (${why})`);
    };
    if (this.#gate) return skip(this.#gate);
    if (!this.#up) return skip('no RCON since the last start');
    const t2 = await this.#advance();
    if (this.#gate) return skip(this.#gate);
    const { unit, data } = this.#c.server;
    const a = this.#a;
    this.#report.note(`S3 stopping ${unit} (up to ${span(this.#w.stop)}), restoring ${a ? a.name : 'nothing (S1 made no save)'}, and starting it again`);
    const t0 = performance.now();
    try {
      await this.#service.act('stop');
    } catch (err) {
      this.#report.say('FAIL', `S3 ${printable((err as Error).message)}`);
      return void this.#report.say('warn', 'S5 skipped (no stop)');
    }
    const stop = await this.#until(isStopped, this.#w.stop);
    const stopMs = performance.now() - t0;
    let end: Shutdown | null = null;
    let notRestored: string | null = null;
    let copy: string | null = null;
    try {
      if (!stop.done) notRestored = `${unit} did not stop within ${span(this.#w.stop)}: it is ${describe(stop.state)}`;
      else {
        end = await this.#shutdown('factorio-current.log'); // the stopped run's log, before the next start renames it
        if (!a) notRestored = 'S1 made no save to restore';
        else {
          await this.#saves.restore(a.name);
          copy = (await this.#saves.list()).saves[0]?.name ?? null; // the newest: the restored copy, 2 s past the rest
        }
      }
    } catch (err) {
      notRestored = printable((err as Error).message);
    }

    // Started again whatever happened above: the check never leaves the server down.
    let t3: Status | string;
    const t1 = performance.now();
    try {
      await this.#service.act('start');
      const start = await this.#until((s) => s.active === 'active' || s.active === 'failed', this.#w.rcon);
      t3 = start.state?.active === 'active' ? await this.#answer() : `${unit} did not start: it is ${describe(start.state)}`;
    } catch (err) {
      t3 = printable((err as Error).message);
    }
    if (typeof t3 === 'string') this.#up = false;

    if (notRestored || typeof t3 === 'string') {
      const why = [notRestored && `not restored: ${notRestored}`, typeof t3 === 'string' && `no RCON after the start: ${t3}`];
      this.#report.say('FAIL', `S3 ${why.filter(Boolean).join('; ')}`);
    } else {
      const loaded = loadedMap((await head(this.#log, MiB, this.#since)) ?? '');
      const want = copy && join(data, 'saves', copy);
      const evidence = `loaded ${loaded ? printable(loaded) : 'no map (no "Loading map" line in factorio-current.log)'}, tick ${t3.tick} (S1 saved from ${a!.tick}, stopped at ${t2.tick}); up in ${secs(performance.now() - t1)}`;
      if (loaded === want && a!.tick <= t3.tick && t3.tick < t2.tick) {
        this.#report.say('ok', `S3 a start loads the newest save, the restored copy: ${evidence}, ${t2.tick - t3.tick} ticks back`);
      } else this.#report.say('FAIL', `S3 ${evidence}: fallback, start with --start-server <file> through a state file read by ExecStartPre`);
    }

    if (!stop.done) return this.#report.say('FAIL', `S5 ${unit} did not stop within ${span(this.#w.stop)}: it is ${describe(stop.state)}`);
    const e = end ?? { signal: null, saved: null, goodbye: false };
    const evidence = [
      e.signal ?? 'no "Received SIG…" line',
      e.saved ? `saved ${printable(e.saved)}` : 'no "Saving map as" line',
      e.goodbye ? 'Goodbye' : 'no Goodbye',
      `${stop.state!.active} with Result=${stop.state!.result} in ${secs(stopMs)}`,
    ].join(', ');
    const clean = e.saved !== null && e.goodbye && stop.state!.result === 'success' && stopMs <= STOP_MS;
    if (clean && e.signal === 'SIGINT') this.#report.say('ok', `S5 stop: ${evidence}`);
    else if (clean && e.signal === 'SIGTERM') this.#report.say('warn', `S5 stop: ${evidence}: Podman sent SIGTERM, so PodmanArgs --stop-signal=SIGINT was not applied`);
    else this.#report.say('FAIL', `S5 stop: ${evidence}: fallback, raise the timeouts`);
  }

  /**
   * S4: Factorio's Lua UDP socket on 127.0.0.1:`factorioUdpPort`, its own (`/proc/net/udp`, this uid), logged as
   * Factorio's, and the mod's hello from it: as the running agent logs it (it holds `agentUdpPort`), or, with the
   * agent down, to the check's own listener there.
   */
  async #s4(): Promise<void> {
    const { factorioUdpPort: port } = this.#c.server;
    const uid = process.getuid!();
    const owner = udpOwner((await readFile(join(this.#p.proc, 'net', 'udp'), 'utf8').catch(() => '')), port);
    const text = await head(this.#log, MiB, this.#since);
    const state = text === null ? null : socketState(text, port);
    const logged = state === 'on';
    const opening = text !== null && text.split('\n').some((l) => openingLine(port).test(l.replace(/\r$/, '')));
    const socket = owner === null ? `nothing bound on 127.0.0.1:${port}` : `127.0.0.1:${port} bound by uid ${owner}`;
    const line = logged
      ? '"Opening socket" logged'
      : opening && state === 'off'
        ? '"Opening socket" logged, but the socket failed or closed (the port is taken?)'
        : opening
          ? '"Opening socket" logged, with nothing after it yet'
          : state === 'off'
            ? '"Opening Lua UDP Socket failed" logged'
            : 'no "Opening socket" line in factorio-current.log since the start';
    if (owner !== uid || !logged) return this.#report.say('FAIL', `S4 ${socket}, ${line}: fallback, a write_file tail`);
    const hello = await this.#hello();
    const evidence = `${socket}, ${line}, ${hello.evidence}`;
    if (hello.ok) this.#report.say('ok', `S4 Factorio's Lua UDP socket: ${evidence}`);
    else this.#report.say('FAIL', `S4 ${evidence}: fallback, a write_file tail`);
  }

  /** The mod's hello since the last start: in agent.log while the agent holds its UDP port, else to the check itself. */
  async #hello(): Promise<{ ok: boolean; evidence: string }> {
    const { agentUdpPort, factorioUdpPort } = this.#c.server;
    const socket = createSocket('udp4');
    const bound = await new Promise<boolean>((resolve) => {
      socket.once('error', () => resolve(false));
      socket.bind({ address: '127.0.0.1', port: agentUdpPort, exclusive: true }, () => resolve(true));
    });
    if (!bound) {
      try {
        socket.close();
      } catch {
        // never bound: nothing to close
      }
      return this.#agentHello();
    }
    try {
      // Nothing holds the agent's port, so orrery-agent.service is down: the check asks for the hello itself.
      let came: (seq: number) => void = () => {};
      const hello = new Promise<number>((resolve) => (came = resolve));
      socket.on('message', (data, from) => {
        if (from.address !== '127.0.0.1' || from.port !== factorioUdpPort) return;
        const d = parseDatagram(data);
        if (typeof d !== 'string' && d.event === null) came(d.seq);
      });
      const reply = await this.#run('/orrery-hello').catch((err: Error) => err);
      const where = `orrery-agent.service is down, so the check listened on 127.0.0.1:${agentUdpPort}`;
      if (reply instanceof Error) return { ok: false, evidence: `/orrery-hello failed: ${printable(reply.message)} (${where})` };
      const seq = await within(hello, this.#w.hello);
      if (seq === null) return { ok: false, evidence: `no hello datagram from 127.0.0.1:${factorioUdpPort} within ${secs(this.#w.hello)} (${where})` };
      return { ok: true, evidence: `the mod's hello came from it (seq ${seq}; ${where})` };
    } finally {
      socket.close();
    }
  }

  /** The running agent's word for this start, in its agent.log: the events gate on, and the mod's hello. */
  async #agentHello(): Promise<{ ok: boolean; evidence: string }> {
    const file = join(this.#c.root, AGENT_LOG);
    const until = performance.now() + this.#w.events;
    for (;;) {
      let on = false;
      let seq: string | null = null;
      for (const raw of (await tail(file, 1000).catch(() => null)) ?? []) {
        const l = agentLine(raw);
        if (!l || l.at < this.#since) continue;
        let m: RegExpExecArray | null;
        if (l.text.startsWith('[events] on: ')) on = true;
        else if ((m = /^\[events\] the mod's hello came: seq (\d+)$/.exec(l.text))) seq = m[1]!;
        else if (l.text.startsWith('[events] game events are off') || l.text.startsWith('[events] no hello datagram came')) {
          return { ok: false, evidence: `agent.log: ${printable(l.text)}` };
        }
      }
      if (on && seq !== null) return { ok: true, evidence: `the mod's hello came from it to orrery-agent.service (seq ${seq})` };
      if (performance.now() >= until) {
        return { ok: false, evidence: `agent.log has no ${on ? `"hello came"` : '"[events] on"'} line within ${secs(this.#w.events)} of the start` };
      }
      await sleep(this.#w.poll);
    }
  }

  /**
   * S6: read-data/write-data put Factorio's files under the data folder (its log there, this run's and this uid's;
   * S1's save in saves/), and nothing under the release since it started.
   */
  async #s6(): Promise<void> {
    const { data, install } = this.#c.server;
    const uid = process.getuid!();
    const found: string[] = [];
    const problems: string[] = [];
    const log = await openPlain(this.#log).catch(() => null);
    if (!log) problems.push(`no factorio-current.log in ${data}`);
    else {
      await log.fh.close();
      if (log.st.mtimeMs < this.#since) problems.push('factorio-current.log was not written since the start');
      else if (log.st.uid !== uid) problems.push(`factorio-current.log belongs to uid ${log.st.uid}, not ${uid}`);
      else found.push(`factorio-current.log (uid ${uid})`);
    }
    if (this.#a) {
      const a = this.#a.name;
      if ((await this.#saves.list()).saves.some((s) => s.name === a)) found.push(`saves/${a}`);
      else problems.push(`S1's ${a} is not in ${data}/saves`);
    }
    const ver = await this.#installed();
    let release = `${install}/releases`;
    if (ver === null) problems.push(`${install}/current is not a link to releases/<version>`);
    else {
      release = join(install, 'releases', ver);
      for (const name of ['factorio-current.log', 'saves']) {
        if (await lstat(join(release, name)).then(() => true, () => false)) problems.push(`${release}/${name} exists`);
      }
      // Since the first run of this release: a re-run of setup may have put it there after an older one started.
      const since = this.#runs.find((r) => r.version === ver)?.since;
      if (since === undefined) problems.push(`no run of Factorio ${ver} was seen, so ${release} was not checked (see S29)`);
      else {
        const changed = await changedSince(release, since);
        if (changed.count > 0) problems.push(`${changed.count} entries under ${release} changed since Factorio started, ${printable(changed.first!)} first`);
      }
    }
    if (problems.length > 0) this.#report.say('FAIL', `S6 ${problems.join('; ')}: fallback, mount the release read-write`);
    else this.#report.say('ok', `S6 Factorio writes under ${data} (${found.join(', ')}), nothing under ${release}`);
    // Names the notes don't confirm Factorio writes: a warning at most.
    const missing: string[] = [];
    for (const name of ['player-data.json', 'mods/mod-settings.dat']) {
      if (!(await lstat(join(data, name)).then(() => true, () => false))) missing.push(name);
    }
    if (missing.length > 0) this.#report.say('warn', `S6 not in ${data} (names not verified, so no FAIL): ${missing.join(', ')}`);
  }

  /** S8: a reply over Source RCON's 4096-byte split arrives whole, as Factorio's one packet. */
  async #s8(): Promise<void> {
    // The biggest harmless reply (never /c or /sc, which flag the save); untested on 2.1, so a failure only notes.
    const help = await this.#run('/help').then(
      (reply) => `/help ${Buffer.byteLength(reply)} bytes`,
      (err: Error) => `/help failed: ${printable(err.message)}`,
    );
    if (this.#largest > SOURCE_SPLIT) this.#report.say('ok', `S8 one packet of ${this.#largest} bytes, read whole (${help})`);
    else this.#report.say('warn', `S8 not exercised (largest reply ${this.#largest} bytes; ${help}): run check again once the friend's mods are in`);
  }

  /** orrery-agent.service's `systemctl show` properties (no polkit needed). */
  async #agentUnit(): Promise<Map<string, string>> {
    const out = await this.#systemctl([
      'show',
      '--timestamp=unix',
      '--property=ActiveState,SubState,Result,ExecMainStatus,NRestarts,MainPID,ActiveEnterTimestamp',
      '--',
      AGENT_UNIT,
    ]);
    const props = new Map<string, string>();
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
    }
    return props;
  }

  /**
   * S16: the private Node runs on this glibc (the check runs on it), and starts under systemd with SELinux enforcing:
   * orrery-agent.service running, not failing with 203/EXEC, and not restarting.
   */
  async #s16(): Promise<void> {
    const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }).header;
    const glibc = typeof header?.glibcVersionRuntime === 'string' ? header.glibcVersionRuntime : 'unknown';
    this.#report.say('ok', `S16 node ${process.version} ${process.arch}, glibc ${glibc}`);
    const running = (p: Map<string, string>) => p.get('ActiveState') === 'active' && p.get('SubState') === 'running';
    const state = (p: Map<string, string>) =>
      `${p.get('ActiveState') ?? '?'} (${p.get('SubState') ?? '?'}), Result=${p.get('Result') ?? '?'}, exit status ${p.get('ExecMainStatus') ?? '?'}`;
    const until = performance.now() + this.#w.agent;
    let p = await this.#agentUnit();
    while (!running(p) && p.get('ExecMainStatus') !== '203' && performance.now() < until) {
      await sleep(this.#w.poll);
      p = await this.#agentUnit();
    }
    if (p.get('ExecMainStatus') === '203') return this.#report.say('FAIL', `S16 ${AGENT_UNIT} 203/EXEC (${state(p)}): fallback, a broader bin_t rule`);
    if (!running(p)) return this.#report.say('FAIL', `S16 ${AGENT_UNIT} is ${state(p)} after ${span(this.#w.agent)}`);
    const restarts = p.get('NRestarts') ?? '?';
    await sleep(this.#w.restarts);
    const q = await this.#agentUnit();
    if (!running(q) || q.get('NRestarts') !== p.get('NRestarts')) {
      return this.#report.say('FAIL', `S16 ${AGENT_UNIT} restarted within ${secs(this.#w.restarts)} (NRestarts ${restarts} -> ${q.get('NRestarts') ?? '?'}, ${state(q)})`);
    }
    const enter = /^@(\d+)$/.exec(q.get('ActiveEnterTimestamp') ?? '');
    this.#agentSince = enter ? Number(enter[1]) * 1000 : null;
    const pid = q.get('MainPID') ?? '';
    const label = /^[1-9]\d*$/.test(pid) ? (await readFile(join(this.#p.proc, pid, 'attr', 'current'), 'utf8').catch(() => '')).replace(/\0/g, '').trim() : '';
    const line = `S16 ${AGENT_UNIT} active (running), NRestarts ${restarts} held over ${secs(this.#w.restarts)}${label ? `, label ${printable(label)}` : ''}`;
    const enforce = (await readFile(this.#p.selinux, 'utf8').catch(() => '')).trim();
    if (enforce === '1') this.#report.say('ok', `${line}, SELinux enforcing`);
    else this.#report.say('warn', `${line}; SELinux is not enforcing, so 203/EXEC was not exercised`);
  }

  /**
   * S21: systemd expands `${RCON_PASSWORD}` in the Quadlet `Exec=` (RCON took the password), and the password is in
   * neither the generated unit nor the .container file. Only the result is printed, never either file.
   */
  async #s21(): Promise<void> {
    const { unit } = this.#c.server;
    const generated = join(this.#p.generator, unit);
    const container = join(this.#p.quadlet, unit.replace(/\.service$/, '.container'));
    const files = [
      { path: generated, text: await small(generated) },
      { path: container, text: await small(container) },
    ];
    const problems: string[] = [];
    for (const f of files) {
      if (f.text === null) problems.push(`can't read ${f.path}`);
      else if (f.text.includes(this.#c.rconPassword)) problems.push(`the RCON password is in ${f.path}`);
    }
    if (files[0]!.text !== null && !files[0]!.text.includes('${RCON_PASSWORD}')) problems.push(`${generated} has no \${RCON_PASSWORD} for systemd to expand`);
    if (this.#auth === 'refused') problems.push('RCON refused the password, so systemd may not have expanded ${RCON_PASSWORD}');
    if (problems.length > 0) this.#report.say('FAIL', `S21 ${problems.join('; ')}: fallback, the sh -c form`);
    else if (this.#auth !== 'ok') this.#report.say('warn', 'S21 the password is in neither unit file, but its expansion is not shown (RCON never answered)');
    else this.#report.say('ok', 'S21 the password is expanded by systemd (RCON took it), and in neither unit file');
  }

  /** S25: Factorio runs as this uid (no user namespace) with no passwd entry for it, and HOME the data folder. */
  async #s25(): Promise<void> {
    const { data } = this.#c.server;
    const uid = process.getuid!();
    const pid = await this.#factorioPid(uid);
    if (pid === null) return this.#report.say('FAIL', `S25 no factorio process of uid ${uid} in ${this.#p.proc}: fallback, bind-mount a one-line passwd file`);
    // The container's environment: only HOME is looked for, and nothing of it is ever printed.
    const environ = await readFile(join(this.#p.proc, pid, 'environ')).then(
      (b) => b.toString('utf8').split('\0'),
      () => null,
    );
    if (environ !== null && !environ.includes(`HOME=${data}`)) return this.#report.say('FAIL', `S25 Factorio (pid ${pid}, uid ${uid}) has HOME other than ${data}`);
    const passwd = await small(join(this.#p.proc, pid, 'root', 'etc', 'passwd'));
    const entry = passwd?.split('\n').some((l) => l.split(':')[2] === String(uid));
    const line = `S25 Factorio (pid ${pid}) runs as uid ${uid}`;
    if (environ === null || passwd === null) {
      this.#report.say('warn', `${line}, but its ${environ === null ? 'environment' : '/etc/passwd'} can't be read (SELinux?): HOME and the passwd entry not shown`);
    } else if (entry) this.#report.say('warn', `${line}, HOME=${data}, but the image has a passwd entry for it: not exercised`);
    else this.#report.say('ok', `${line} with no passwd entry, HOME=${data}`);
  }

  /** The pid of a process named factorio whose real and effective uid are `uid`; null if none. */
  async #factorioPid(uid: number): Promise<string | null> {
    for (const pid of await readdir(this.#p.proc)) {
      if (!/^\d+$/.test(pid)) continue;
      const stat = await readFile(join(this.#p.proc, pid, 'stat'), 'utf8').catch(() => '');
      if (stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) !== 'factorio') continue;
      const ids = /^Uid:\s+(\d+)\s+(\d+)/m.exec(await readFile(join(this.#p.proc, pid, 'status'), 'utf8').catch(() => ''));
      if (ids && Number(ids[1]) === uid && Number(ids[2]) === uid) return pid;
    }
    return null;
  }

  /** S29: setup's mods and every one mod-list.json enables are loaded, in the version `current` points at. */
  async #s29(): Promise<void> {
    const { data, install } = this.#c.server;
    const status = parseStatus(await this.#run('/orrery-status'));
    if (!status) return this.#report.say('FAIL', 'S29 /orrery-status gave no status');
    const enabled = enabledMods((await small(join(data, 'mods', 'mod-list.json'))) ?? '');
    const missing = [...new Set([...SETUP_MODS, ...(enabled ?? [])])].filter((m) => !Object.hasOwn(status.mods, m));
    const ver = await this.#installed();
    const mods = Object.entries(status.mods)
      .map(([name, v]) => `${printable(name)} ${v}`)
      .join(', ');
    const problems: string[] = [];
    if (missing.length > 0) {
      const names = missing.slice(0, 20).map(printable).join(', ');
      problems.push(`not loaded: ${names}${missing.length > 20 ? ` and ${missing.length - 20} more` : ''}`);
    }
    if (status.version !== ver) problems.push(`Factorio ${status.version} runs, but ${install}/current is ${ver ?? 'not a link to releases/<version>'}`);
    const list = enabled === null ? "; mods/mod-list.json can't be read, so only setup's six were looked for" : '';
    if (problems.length > 0) this.#report.say('FAIL', `S29 ${problems.join('; ')}${list}; mods: ${mods}`);
    else this.#report.say('ok', `S29 Factorio ${status.version} (${install}/current)${list}; mods: ${mods}`);
  }

  /** The hub: reachable over TCP (a warning only, for `--no-hub`), and whether the agent was welcomed since its start. */
  async #hub(): Promise<void> {
    const { host, port } = this.#c.hub;
    const why = await reach(host, port, this.#w.hub);
    if (why !== null) return this.#report.say('warn', `hub: can't reach ${host}:${port} (${why}); fine before the hub listens`);
    if (this.#agentSince === null) return this.#report.say('warn', `hub: ${host}:${port} answers; whether the agent was welcomed is unknown (${AGENT_UNIT} isn't running)`);
    const welcome = await this.#welcome(this.#agentSince);
    if (welcome.version !== null) this.#report.say('ok', `hub: ${host}:${port} welcomed ${welcome.version}`);
    else this.#report.say('warn', `hub: ${host}:${port} answers, but no welcome since ${AGENT_UNIT} started: ${welcome.why}`);
  }

  /**
   * The agent's version from `<root>/connected` once it was written since `since` (each welcome writes it); or the
   * latest `[hub]` line agent.log has since then, as soon as that is a rejection, or once `waits.welcome` passed.
   */
  async #welcome(since: number): Promise<{ version: string | null; why: string }> {
    const until = performance.now() + this.#w.welcome;
    for (;;) {
      try {
        const c: unknown = JSON.parse(await readFile(join(this.#c.root, 'connected'), 'utf8'));
        if (isObject(c) && typeof c.version === 'string' && typeof c.time === 'number' && c.time >= since) return { version: printable(c.version), why: '' };
      } catch {
        // not there yet
      }
      let latest: string | null = null;
      for (const raw of (await tail(join(this.#c.root, AGENT_LOG), 1000).catch(() => null)) ?? []) {
        const l = agentLine(raw);
        if (l && l.at >= since && l.text.startsWith('[hub] ')) latest = l.text;
      }
      if (latest?.includes('(rejected: ') || performance.now() >= until) return { version: null, why: latest ? printable(latest) : 'agent.log has no [hub] line since' };
      await sleep(this.#w.poll);
    }
  }
}

/**
 * The first-boot check (setup's last step, `index.ts check`), as a report on stdout, each line printed as its check
 * ends: the config and secrets, a host sample, the server's unit and RCON, then each smoke check the agent can make,
 * the hub, a count, and the checks others make, as a to-do. True only when no check failed: a warning (the hub not
 * listening yet, players on so the stops were skipped) still passes.
 */
export async function check(load: () => Config, version: string, o: CheckOptions = {}): Promise<boolean> {
  const report = new Report();
  console.log(`orrery agent ${version}: first-boot check`);
  let config: Config;
  try {
    config = load();
  } catch (err) {
    report.say('FAIL', `config: ${(err as Error).message}`);
    return false;
  }
  const { hub, server } = config;
  report.say('ok', `config: agent ${config.id}, hub ${hub.host}:${hub.port}, server ${server.id} (${server.unit}), mounts ${config.mounts.join(' ')}`);
  const checks = new Checks(config, report, o);
  try {
    await checks.run();
  } finally {
    checks.close();
  }
  const { ok, FAIL, warn } = report.counts;
  console.log(`summary: ${ok} ok, ${FAIL} FAIL, ${warn} warn`);
  for (const line of OTHERS) console.log(`skip ${line}`);
  return FAIL === 0;
}

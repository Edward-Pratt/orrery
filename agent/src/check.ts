// The first-boot check (`index.ts check`): setup's last step, run as factorio with the two secrets in its environment
// only, after setup started factorio.service and orrery-agent.service. A report on stdout, each line printed as its
// check ends, so setup can show it live; true (exit 0) only when no check failed. Each of the design's first-boot
// smoke checks (docs/notes/factorio-agent.md) the agent can make from its seat gets a line, in the order they run (S1,
// S2, S20, S3, S5, S4, S6, S8, S16, S21, S25, S29); the others end the report, naming who makes them. Whatever RCON or
// a file the container writes says goes through `printable`, and no secret is ever printed.
//
// `check`, the first-boot report (setup's last step, run as factorio after setup started both units; no hub needed):
// a line per check on stdout as it ends (`ok`, `FAIL` or `warn`; an unmarked note before each long wait; `Saves` and
// `ServiceWatch` print their own lines too), then `summary: N ok, M FAIL, K warn` and a `skip` line for each smoke
// check others make (players, owner, friend or setup), as a to-do. True (exit 0) only with no `FAIL`: a warning
// passes. In order: the config and secrets (a bad config ends the report there); a host sample; factorio.service and
// RCON (`check-rcon.ts`); S1, S20, S3 and S5 (`check-stops.ts`), with S2 between S1 and S20 (`check-rcon.ts`); S4
// (`check-events.ts`); S6 (`check-data.ts`); S8 (`check-rcon.ts`); S16 (`check-agent.ts`); S21 and S25
// (`check-container.ts`); S29 (`check-mods.ts`); the hub (`check-hub.ts`). This file keeps that order, the config and
// host lines, the count and the to-do; what the checks share is `check-ctx.ts` (the waits, the paths, the report, the
// check's own RCON session and what earlier checks found), their helpers `check-util.ts`. Every RCON reply, log line,
// mod or file name it prints is `printable`; no secret is printed. `WAITS`, `PATHS` (`/proc`, SELinux's `enforce`, the
// generator and Quadlet folders) and the `systemctl` are options for tests. A first boot leaves the world as
// `restored-<time>-orrery-<time>.zip`, a few paused ticks back; with a hub, the running agent reports the stops.
import { setTimeout as sleep } from 'node:timers/promises';
import { s16 } from './check-agent.ts';
import { s21, s25 } from './check-container.ts';
import { CheckCtx, Report, type CheckOptions } from './check-ctx.ts';
import { s6 } from './check-data.ts';
import { s4 } from './check-events.ts';
import { hub } from './check-hub.ts';
import { s29 } from './check-mods.ts';
import { factorio, s2, s8 } from './check-rcon.ts';
import { s1, s20, s3 } from './check-stops.ts';
import type { Config } from './config.ts';
import { HostSampler } from './host.ts';
import { printable } from './wire.ts';

export { PATHS, WAITS, type CheckOptions } from './check-ctx.ts';
export { enabledMods } from './check-mods.ts';
export { udpOwner } from './check-events.ts';
export { shutdownOf, type Shutdown } from './check-stops.ts';

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
  "S31 owner: a newer Factorio's save does not load in an older one (a game update's forced rollback)",
  "S32 players: an admin's pause with players on stops the tick",
];

/** The checks after the config, in their order, sharing what earlier ones found. */
class Checks {
  #k: CheckCtx;

  constructor(config: Config, report: Report, o: CheckOptions) {
    this.#k = new CheckCtx(config, report, o);
  }

  async run(): Promise<void> {
    await this.#step('host:', () => this.#host());
    if (await factorio(this.#k)) {
      await this.#step('S1', () => s1(this.#k));
      await this.#step('S2', () => s2(this.#k));
      await this.#step('S20', () => s20(this.#k));
      await this.#step('S3', () => s3(this.#k));
    } else for (const s of ['S1', 'S2', 'S20', 'S3', 'S5']) this.#k.report.say('warn', `${s} skipped (no RCON)`);
    await this.#ifUp('S4', () => s4(this.#k));
    await this.#ifUp('S6', () => s6(this.#k));
    await this.#ifUp('S8', () => s8(this.#k));
    await this.#step('S16', () => s16(this.#k));
    await this.#step('S21', () => s21(this.#k));
    await this.#ifUp('S25', () => s25(this.#k));
    await this.#ifUp('S29', () => s29(this.#k));
    await this.#step('hub:', () => hub(this.#k));
  }

  close(): void {
    this.#k.rcon.close();
  }

  /** A check whose unexpected error is its FAIL line, so the rest still run. */
  async #step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.#k.report.say('FAIL', `${name} ${printable((err as Error).message)}`);
    }
  }

  async #ifUp(name: string, fn: () => Promise<void>): Promise<void> {
    if (!this.#k.up) return this.#k.report.say('warn', `${name} skipped (no RCON since the last start)`);
    await this.#step(name, fn);
  }

  async #host(): Promise<void> {
    const sampler = new HostSampler(this.#k.c.mounts, this.#k.hostReaders);
    await sampler.sample();
    await sleep(this.#k.w.cpu);
    const s = (await sampler.sample())!;
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    const disks = s.disks.map((d) => `${d.mount} ${gb(d.free)} of ${gb(d.total)} GB free`).join(', ');
    this.#k.report.say('ok', `host: cpu ${Math.round(s.cpu * 100)}%, load ${s.load.join(' ')}, memory ${gb(s.memory.used)} of ${gb(s.memory.total)} GB used; ${disks}`);
    if (s.disks.length !== this.#k.c.mounts.length) this.#k.report.say('FAIL', 'host: a mount in "mounts" can\'t be read');
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

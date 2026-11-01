import { constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Agents } from './agents.ts';
import type { Environment, GithubIntegration, ServerSettings } from './config.ts';
import type { Db } from './db.ts';
import type { RestartScheduler } from './restarts.ts';
import type { ServerHub } from './servers.ts';
import type { Run } from './services.ts';
import type { AgentMsg, DeployOutcome, DeployPart, DeployRow, HubEvent, Release } from './types.ts';
import type { DeploysAnswer, PartReleases } from './api.ts';

/** A release as GitHub lists it, drafts and prereleases included. */
export type GitHubRelease = Release & { draft: boolean; prerelease: boolean };
/** GitHub's published releases and their assets, passed in so tests need no network. */
export type GitHub = {
  releases: () => Promise<GitHubRelease[]>;
  download: (tag: string, asset: string) => Promise<Uint8Array>;
};

/** The real GitHub REST API, with the token; `fetch` follows an asset's redirect (dropping the token off GitHub). */
export function githubReader(repo: string, token: string): GitHub {
  const api = `https://api.github.com/repos/${repo}`;
  const call = async (url: string, accept = 'application/vnd.github+json') => {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
    return res;
  };
  type Raw = { tag_name: string; draft: boolean; prerelease: boolean; published_at: string | null; assets: { name: string; url: string }[] };
  return {
    releases: async () =>
      ((await (await call(`${api}/releases?per_page=100`)).json()) as Raw[]).map((r) => ({
        tag: r.tag_name,
        draft: r.draft,
        prerelease: r.prerelease,
        publishedAt: Date.parse(r.published_at ?? '') || 0,
        assets: r.assets.map((a) => a.name),
      })),
    download: async (tag, asset) => {
      const release = (await (await call(`${api}/releases/tags/${encodeURIComponent(tag)}`)).json()) as Raw;
      const found = release.assets.find((a) => a.name === asset);
      if (!found) throw new Error(`${tag} has no asset ${asset}`);
      return new Uint8Array(await (await call(found.url, 'application/octet-stream')).arrayBuffer());
    },
  };
}

/** Why a deploy wasn't started: 404 (no such release or server) or 409 (not now, or not this one). */
export class DeployRefused extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** A release's tag; a Factorio mod's `factorio-v` ones aren't deployed here (a game update installs the mod). */
const TAG = /^(hub|web|mod|agent)-v(\d+)\.(\d+)\.(\d+)$/;
const version = (tag: string) => TAG.exec(tag)!.slice(2).map(Number);
/** Newest first, by version. */
const newestFirst = (a: Release, b: Release) => {
  const [x, y] = [version(a.tag), version(b.tag)];
  return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
};
/** The first hub, dashboard and Agent releases that can deploy: an older one would take the deploy flow away. */
export const FLOOR = { hub: 'hub-v2.6.0', web: 'web-v0.5.0', agent: 'agent-v1.0.0' } as const;
/** A renamed Mod release's builds, one per Minecraft target: `orrery-<mc>-<version>.jar`. */
const MOD_BUILD = /^orrery-(.+)-(\d+\.\d+\.\d+)\.jar$/;
/** The Minecraft version of a server without a pack (or whose pack isn't in the library). */
const MC = '1.7.10';
/** Every Mod jar in `mods/`, from before the rename (`gtnhdiscord-`) and after. */
const MOD_JAR = /^(gtnhdiscord|orrery)-.*\.jar$/;
const LOG_LINES = 40;
const HISTORY = 50;
/** A oneshot deploy unit is `activating` while its script runs; inactive or failed once it is over. */
const RUNNING_STATES = new Set(['activating', 'active', 'reloading', 'deactivating']);

type Hub = Pick<ServerHub, 'get' | 'list' | 'on' | 'off' | 'publishTarget' | 'audit' | 'runCommand' | 'modVersion'>;

export type DeploysDeps = {
  hub: Hub;
  db: Db;
  restarts: RestartScheduler;
  github: GitHub;
  run: Run;
  config: GithubIntegration;
  /** The target of this hub's own and its dashboard's deploys. */
  environment: Environment;
  servers: Pick<ServerSettings, 'id' | 'dir'>[];
  /** Whether a server has a Mod token. */
  hasMod: (serverId: string) => boolean;
  /** Only with the agents integration: each Agent, the version it said it runs, its requests and events. */
  agents?: Pick<Agents, 'get' | 'list' | 'request' | 'on' | 'off'>;
  /** Whether a restore runs on a server (undefined: on any; a hub deploy's restart would kill it). */
  restoring: (serverId?: string) => boolean;
  /** What update runs on a server (undefined: on any): `pack update` or `game update`; null: none. */
  updating: (serverId?: string) => string | null;
  /** Whether a library add runs (a hub deploy's restart would lose it). */
  libraryAdding: () => boolean;
  /** Whether a New server install runs (likewise). */
  installing: () => boolean;
  /** The Minecraft version of a server's pack, from its library entry; undefined: none known. */
  mcOf: (serverId: string) => string | undefined;
  /** Where the database copy before a hub deploy goes. */
  dbCopies: string;
};

/**
 * How long the hub waits for an Agent's deploy: for the tag's `agentHello` or its `deployResult` after the `deploy`
 * reply, and for that result after the hello (20 min). Longer than its deploy unit may run (`TimeoutStartSec=15min`
 * in `deploy/orrery-agent-deploy@.service`), so the hub never stops waiting, and lets other work start on the Agent,
 * while the unit still runs.
 */
export const AGENT_DEPLOY_MS = 20 * 60_000;

/** Shortened in tests. */
export type DeploysOptions = { pollMs?: number; watchMs?: number; modTimeoutMs?: number; agentTimeoutMs?: number; countdownMinutes?: number };

/**
 * Releases and deploys: GitHub's published releases (asked hourly and on `check`) against what each part runs, and
 * deploying one, one at a time, recorded in the `deploys` history, audited and announced as `deploy` target notices.
 * The hub and dashboard deploy through their environment's templated units (`<template>@<tag>.service`, only for a
 * tag GitHub listed), whose outcome comes back in `deploy-status.json`; a Mod deploy puts the jar in place itself,
 * at the end of the server's countdown when it runs; an Agent deploys itself (`deploy`), ok once it says hello as
 * the new release. Hub core.
 */
export class Deploys {
  #d: DeploysDeps;
  #pollMs: number;
  #watchMs: number;
  #modTimeoutMs: number;
  #agentTimeoutMs: number;
  #countdownMinutes: number;
  #releases: Release[] = [];
  #checkedAt: number | null = null;
  #error: string | null = null;
  #starting = false; // between the checks and the row, so two requests can't both pass
  #timers = new Set<NodeJS.Timeout>();
  /** Takes each listener of a running Mod or Agent deploy off again. */
  #listeners = new Set<() => void>();
  /**
   * Each Agent whose deploy runs, by its tag: from the row's start until its `deployResult` (or its time is up), so
   * also after its hello closed the row ok, while its deploy unit still gates and may roll back.
   */
  #agentDeploys = new Map<string, string>();

  constructor(
    deps: DeploysDeps,
    { pollMs = 3_600_000, watchMs = 5_000, modTimeoutMs = 10 * 60_000, agentTimeoutMs = AGENT_DEPLOY_MS, countdownMinutes = 5 }: DeploysOptions = {},
  ) {
    this.#d = deps;
    this.#pollMs = pollMs;
    this.#watchMs = watchMs;
    this.#modTimeoutMs = modTimeoutMs;
    this.#agentTimeoutMs = agentTimeoutMs;
    this.#countdownMinutes = countdownMinutes;
  }

  /** Asks GitHub now and every hour, and picks up deploys left running by the hub before this one. */
  start(): void {
    void this.check();
    const poll = setInterval(() => void this.check(), this.#pollMs);
    poll.unref();
    this.#timers.add(poll);
    for (const row of this.#d.db.deploys(HISTORY, { running: true })) {
      // A Mod deploy's countdown, and the wait for an Agent's hello, lived in the hub that started it.
      if (row.part === 'mod' || row.part === 'agent') this.#finish(row, 'failed', 'interrupted: the hub restarted');
      else this.#watch(row);
    }
  }

  stop(): void {
    for (const t of this.#timers) clearTimeout(t);
    for (const off of this.#listeners) off();
  }

  /** Asks GitHub for its releases now; a failure keeps the last list and is reported in `answer`. */
  async check(): Promise<void> {
    try {
      this.#releases = (await this.#d.github.releases())
        .filter((r) => !r.draft && !r.prerelease && TAG.test(r.tag))
        .map(({ tag, publishedAt, assets }) => ({ tag, publishedAt, assets }))
        .sort(newestFirst);
      this.#error = null;
    } catch (err) {
      this.#error = (err as Error).message;
    }
    this.#checkedAt = Date.now();
  }

  /** Whether a hub deploy runs (a restore must wait for it). */
  busy(): boolean {
    return this.#d.db.deploys(HISTORY, { running: true }).some((r) => r.part === 'hub');
  }

  /** The newest Mod release with a build for a Minecraft version (a New server's Mod): its tag and asset; undefined: none. */
  modBuild(mc: string): { tag: string; asset: string } | undefined {
    for (const r of this.#of('mod')) {
      const asset = r.assets.find((a) => MOD_BUILD.exec(a)?.[1] === mc && !a.includes('/'));
      if (asset) return { tag: r.tag, asset };
    }
    return undefined;
  }

  /** A release asset's bytes. */
  download(tag: string, asset: string): Promise<Uint8Array> {
    return this.#d.github.download(tag, asset);
  }

  /** Whether a Mod deploy onto a server runs (a pack update must wait for it). */
  modBusy(serverId: string): boolean {
    return this.#d.db.deploys(HISTORY, { running: true }).some((r) => r.part === 'mod' && r.target === serverId);
  }

  /** Whether an Agent's deploy runs, until its `deployResult` (a game update or a restore of its server must wait for it). */
  agentBusy(agentId: string): boolean {
    return this.#agentDeploys.has(agentId);
  }

  /** What runs against what is published, and the history newest first, 50 rows older than `before`. */
  answer(before?: number): DeploysAnswer {
    const part = (p: 'hub' | 'web'): PartReleases => {
      const releases = this.#of(p);
      return { running: this.#running(p), latest: releases[0]?.tag ?? null, releases };
    };
    const mod = this.#of('mod');
    const agent = this.#of('agent');
    const history = this.#d.db.deploys(HISTORY + 1, { before });
    return {
      hub: part('hub'),
      web: part('web'),
      mod: {
        latest: mod[0]?.tag ?? null,
        releases: mod,
        // Only a minecraft server runs the Mod.
        servers: this.#d.hub
          .list()
          .filter((s) => s.game === 'minecraft')
          .map((s) => ({ id: s.id, name: s.name, running: this.#running('mod', s.id) })),
      },
      agent: {
        latest: agent[0]?.tag ?? null,
        releases: agent,
        hosts: (this.#d.agents?.list() ?? []).map((a) => ({ id: a.id, name: a.name, server: a.server, running: this.#running('agent', a.id) })),
      },
      checkedAt: this.#checkedAt,
      error: this.#error,
      newerAfterDays: this.#d.config.newerAfterDays,
      history: history.slice(0, HISTORY),
      older: history.length > HISTORY,
      packing: this.#d.hub.list().flatMap((s) => (this.#d.updating(s.id) ? [s.id] : [])),
    };
  }

  /**
   * Starts deploying a listed release (`on`: the Mod's server, or the Agent's id; `by` to the audit log, `byName` to
   * players) and resolves with its history row's id once it is under way; the outcome comes as a `deployFinished`
   * notice. Rejects with `DeployRefused`, or another error if systemctl, the download or the Agent's `deploy` fails
   * (the row then closes failed).
   */
  async deploy(part: DeployPart, tag: string, by: string, on?: string, byName = by): Promise<number> {
    // The tag goes into a unit name (the Agent's too): only one GitHub listed for this part, which also matches TAG.
    const release = this.#releases.find((r) => r.tag === tag && tag.startsWith(`${part}-v`));
    if (!release) throw new DeployRefused(404, `No published release ${tag}.`);
    const server = part === 'mod' ? this.#d.hub.get(on ?? '') : undefined;
    if (part === 'mod' && !server) throw new DeployRefused(404, 'No such server.');
    const agent = part === 'agent' ? this.#d.agents?.get(on ?? '') : undefined;
    if (part === 'agent' && !agent) throw new DeployRefused(404, 'No such Agent.');
    if (this.#starting || this.#d.db.deploys(1, { running: true }).length) throw new DeployRefused(409, 'Another deploy is running.');
    // One at a time still: an Agent's deploy unit runs on after its hello closed the row, holding its deploy lock.
    const [finishing, finishingTag] = [...this.#agentDeploys][0] ?? [];
    if (finishing !== undefined) {
      throw new DeployRefused(409, `${this.#d.agents?.get(finishing)?.name ?? finishing}'s deploy of ${finishingTag} hasn't reported its end yet: deploy once it has.`);
    }
    const from = this.#running(part, on);
    if (from === tag) throw new DeployRefused(409, `${tag} is already running.`);
    if (part === 'hub' && this.#d.restoring()) throw new DeployRefused(409, 'A restore is running: deploy the hub once it is done.');
    const updating = part === 'hub' ? this.#d.updating() : null;
    if (updating) throw new DeployRefused(409, `A ${updating} is running: deploy the hub once it is done.`);
    if (part === 'hub' && this.#d.libraryAdding()) throw new DeployRefused(409, 'A library add is running: deploy the hub once it is done.');
    if (part === 'hub' && this.#d.installing()) throw new DeployRefused(409, 'A New server install is running: deploy the hub once it is done.');
    const onServer = server ? this.#d.updating(server.id) : null;
    if (server && onServer) throw new DeployRefused(409, `A ${onServer} is running on ${server.name}: deploy the Mod once it is done.`);
    if (part !== 'mod' && newestFirst(release, { tag: FLOOR[part], publishedAt: 0, assets: [] }) > 0) {
      throw new DeployRefused(409, `${tag} is older than ${FLOOR[part]}, the first release that can deploy.`);
    }
    if (server) return this.#deployMod(release, server.id, server.name, from, by, byName);
    if (agent) return this.#deployAgent(release, agent.id, from, by);

    this.#starting = true;
    try {
      if (part === 'hub') this.#d.db.copyTo(join(this.#d.dbCopies, `hub-before-${tag}-${Date.now()}.db`));
      const row = this.#begin(part, this.#d.environment, from, tag, by);
      try {
        await this.#d.run('systemctl', ['start', '--no-block', '--', this.#unit(row)]);
      } catch (err) {
        this.#finish(row, 'failed', `systemctl failed: ${(err as Error).message}`);
        throw err;
      }
      // Not at once: systemd may answer `show` before it has dispatched the queued start (still inactive).
      this.#watch(row, this.#watchMs);
      return row.id;
    } finally {
      this.#starting = false;
    }
  }

  #of(part: DeployPart): Release[] {
    return this.#releases.filter((r) => r.tag.startsWith(`${part}-v`));
  }

  /** What a part runs (`on`: the Mod's server, or the Agent's id); null: unknown. */
  #running(part: DeployPart, on?: string): string | null {
    const { root, webDir } = this.#d.config.deploys;
    if (part === 'hub') {
      try {
        const name = basename(realpathSync(join(root, 'current')));
        if (name.startsWith('hub-v') && TAG.test(name)) return name;
      } catch {}
      return 'dev';
    }
    if (part === 'web') {
      // The stamp first: install-web.sh writes it on every install, a deploy's or one by hand.
      try {
        const stamp = readFileSync(`${webDir}.release`, 'utf8').trim();
        if (stamp.startsWith('web-v') && TAG.test(stamp)) return stamp;
      } catch {}
      return this.#d.db.deploys(1, { part: 'web', outcome: 'ok' })[0]?.to ?? null;
    }
    if (part === 'agent') {
      // Its hello names its release (`agent-vX.Y.Z`); a bare version gets the prefix, as a Mod's does.
      const v = this.#d.agents?.get(on!)?.version ?? null;
      return v !== null && /^\d+\.\d+\.\d+$/.test(v) ? `agent-v${v}` : v;
    }
    const v = this.#d.hub.modVersion(on!);
    if (v === undefined) return null;
    return /^\d+\.\d+\.\d+$/.test(v) ? `mod-v${v}` : v;
  }

  #unit(row: DeployRow): string {
    const { hubTemplate, webTemplate } = this.#d.config.deploys;
    return `${row.part === 'hub' ? hubTemplate : webTemplate}@${row.to}.service`;
  }

  #begin(part: DeployPart, target: string, from: string | null, to: string, by: string): DeployRow {
    const started = Date.now();
    const id = this.#d.db.startDeploy({ part, target, from, to, by }, started);
    this.#d.hub.audit(by, 'deploy', target, `${part} ${from ?? 'unknown'} → ${to}`);
    this.#d.hub.publishTarget({ target: 'deploy', id: target, type: 'notice', severity: 'info', kind: 'deployStarted', part, from, to, by });
    return { id, part, target, from, to, by, started, finished: null, outcome: 'running', log: '' };
  }

  #finish(row: DeployRow, outcome: Exclude<DeployOutcome, 'running'>, log: string): void {
    this.#d.db.finishDeploy(row.id, outcome, log.split('\n').slice(-LOG_LINES).join('\n'));
    const { part, from, to, target } = row;
    const severity = outcome === 'ok' ? 'good' : 'problem';
    this.#d.hub.publishTarget({ target: 'deploy', id: target, type: 'notice', severity, kind: 'deployFinished', part, from, to, outcome });
  }

  #later(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    this.#timers.add(t);
    return t;
  }

  /** Waits for a hub or dashboard deploy unit to end, then closes its row from the status file it wrote. */
  #watch(row: DeployRow, delayMs = 0): void {
    const poll = async () => {
      try {
        const out = await this.#d.run('systemctl', ['show', '--property=ActiveState', '--', this.#unit(row)]);
        if (RUNNING_STATES.has(/^ActiveState=(.*)$/m.exec(out)?.[1] ?? '')) return void this.#later(poll, this.#watchMs);
      } catch (err) {
        console.error(`[deploys] reading ${this.#unit(row)} failed:`, (err as Error).message);
        return void this.#later(poll, this.#watchMs);
      }
      const status = this.#status();
      // A file from an earlier deploy of the same tag (one rolled back, then tried again) isn't this one's.
      if (status && status.tag === row.to && Date.parse(status.finished) + 1000 > row.started) {
        this.#finish(row, status.outcome, status.log);
      } else this.#finish(row, 'failed', 'interrupted: the deploy unit ended without reporting');
    };
    if (delayMs) this.#later(poll, delayMs);
    else void poll();
  }

  #status(): { tag: string; outcome: Exclude<DeployOutcome, 'running'>; finished: string; log: string } | undefined {
    try {
      const s = JSON.parse(readFileSync(join(this.#d.config.deploys.root, 'deploy-status.json'), 'utf8'));
      const ok = ['ok', 'failed', 'rolled back'].includes(s.outcome) && typeof s.tag === 'string' && typeof s.finished === 'string';
      return ok ? { ...s, log: typeof s.log === 'string' ? s.log : '' } : undefined;
    } catch {
      return undefined;
    }
  }

  async #deployMod(release: Release, serverId: string, serverName: string, from: string | null, by: string, byName: string): Promise<number> {
    const { dir } = this.#d.servers.find((s) => s.id === serverId) ?? {};
    if (!dir) throw new DeployRefused(409, `${serverName} has no server folder.`);
    if (!this.#d.hasMod(serverId)) throw new DeployRefused(409, `${serverName} has no Mod token.`);
    if (this.#d.restarts.pending(serverId)) throw new DeployRefused(409, `A countdown is running on ${serverName}: cancel it first.`);
    const v = version(release.tag).join('.');
    const builds = release.assets.map((a) => MOD_BUILD.exec(a)).filter((m) => m !== null);
    let asset: string;
    let jar: string;
    if (builds.length) {
      const mc = this.#d.mcOf(serverId) ?? MC;
      const build = builds.find((m) => m[1] === mc);
      if (!build) throw new DeployRefused(409, `${release.tag} has no Mod build for Minecraft ${mc}.`);
      asset = build[0];
      jar = `orrery-${mc}-${v}.jar`;
    } else {
      // From before the rename: one gtnhdiscord jar, which reads its token from gtnhdiscord.cfg.
      const jars = release.assets.filter((a) => a.endsWith('.jar') && !a.endsWith('-dev.jar') && !a.endsWith('-sources.jar'));
      if (jars.length !== 1) throw new DeployRefused(409, `${release.tag} has no single Mod jar.`);
      if (!existsSync(join(dir, 'config', 'gtnhdiscord.cfg'))) {
        throw new DeployRefused(409, `${release.tag} reads config/gtnhdiscord.cfg, which ${serverName} doesn't have.`);
      }
      asset = jars[0]!;
      jar = `gtnhdiscord-${v}.jar`;
    }
    const mods = join(dir, 'mods');
    const part = join(mods, `.${jar}.part`);
    this.#starting = true;
    let row: DeployRow;
    try {
      row = this.#begin('mod', serverId, from, release.tag, by);
      try {
        const bytes = await this.#d.github.download(release.tag, asset);
        await mkdir(mods, { recursive: true });
        await writeFile(part, bytes);
      } catch (err) {
        await rm(part, { force: true });
        this.#finish(row, 'failed', `download failed: ${(err as Error).message}`);
        throw err;
      }
    } finally {
      this.#starting = false;
    }
    // A rename never rewrites the file a running JVM has open; Forge crashes on two copies, so the others go.
    // A renamed jar reads orrery.cfg: the old config is copied over once, and kept for a pre-rename release.
    const swap = async () => {
      if (jar.startsWith('orrery-')) {
        await copyFile(join(dir, 'config', 'gtnhdiscord.cfg'), join(dir, 'config', 'orrery.cfg'), constants.COPYFILE_EXCL).catch((err) => {
          if (!['ENOENT', 'EEXIST'].includes(err.code)) throw err;
        });
      }
      await rename(part, join(mods, jar));
      for (const f of await readdir(mods)) if (MOD_JAR.test(f) && f !== jar) await rm(join(mods, f), { force: true });
    };
    if (!this.#d.hub.get(serverId)?.online) {
      try {
        await swap();
      } catch (err) {
        this.#finish(row, 'failed', `swap failed: ${(err as Error).message}`);
        throw err;
      }
      this.#finish(row, 'ok', 'applied at next start');
      return row.id;
    }

    let swapped = false;
    let timeout: NodeJS.Timeout | undefined;
    const off = () => this.#d.hub.off('event', listen);
    const done = (outcome: 'ok' | 'failed', log: string) => {
      off();
      this.#listeners.delete(off);
      clearTimeout(timeout);
      if (timeout) this.#timers.delete(timeout);
      this.#finish(row, outcome, log);
    };
    const listen = (e: HubEvent) => {
      if (e.serverId !== serverId) return;
      if (!swapped && e.type === 'notice' && (e.kind === 'restartCancelled' || e.kind === 'restartCancelledDown')) {
        void rm(part, { force: true });
        done('failed', 'cancelled');
      } else if (swapped && e.type === 'connected' && this.#d.hub.modVersion(serverId) === v) {
        done('ok', `${serverName} runs ${release.tag}`);
      }
    };
    this.#d.hub.on('event', listen);
    this.#listeners.add(off);
    // The server may have gone down, or a countdown started, during the download: close the row, don't leave it running.
    try {
      this.#d.restarts.schedule(serverId, this.#countdownMinutes, by, byName, {
        fire: async () => {
          try {
            await swap();
          } catch (err) {
            done('failed', `swap failed: ${(err as Error).message}`);
            throw err;
          }
          swapped = true;
          timeout = this.#later(() => done('failed', `${serverName} didn't come back with ${release.tag} in time`), this.#modTimeoutMs);
          await this.#d.hub.runCommand(serverId, 'stop', by); // the linked service, or the countdown restart, brings it back
        },
      });
    } catch (err) {
      await rm(part, { force: true });
      done('failed', `no countdown: ${(err as Error).message}`);
      throw new DeployRefused(409, `${serverName} changed during the download: ${(err as Error).message}`);
    }
    return row.id;
  }

  /**
   * An Agent deploys itself: its `deploy` request starts its own deploy unit (the reply means started), which restarts
   * it. Ok once it says hello again as the tag; its `deployResult` for the tag records any other end (`rolled back`:
   * it came back on the old release; `failed`), also after that hello closed the row ok (the unit's gate failed after
   * it), once; failed when neither comes in time. The Agent is busy until its result, or `agentTimeoutMs` after that
   * hello.
   */
  async #deployAgent(release: Release, agentId: string, from: string | null, by: string): Promise<number> {
    const agents = this.#d.agents!; // it found the Agent
    const agent = agents.get(agentId)!;
    const name = this.#d.hub.get(agent.server)?.name ?? agent.server;
    if (!agent.connected) throw new DeployRefused(409, `${agent.name} isn't connected.`);
    const updating = this.#d.updating(agent.server);
    if (updating) throw new DeployRefused(409, `A ${updating} is running on ${name}: deploy the Agent once it is done.`);
    if (this.#d.restoring(agent.server)) throw new DeployRefused(409, `A restore is running on ${name}: deploy the Agent once it is done.`);
    if (this.#d.restarts.pending(agent.server)) throw new DeployRefused(409, `A countdown is running on ${name}: cancel it first.`);
    const { tag } = release;
    let row!: DeployRow;
    let open = true; // the row; its listeners stay on until the result
    let timeout: NodeJS.Timeout | undefined;
    const arm = (fn: () => void) => {
      clearTimeout(timeout);
      if (timeout) this.#timers.delete(timeout);
      timeout = this.#later(fn, this.#agentTimeoutMs);
    };
    const up = (id: string) => {
      if (!open || id !== agentId || this.#running('agent', agentId) !== tag) return;
      open = false;
      this.#finish(row, 'ok', `${agent.name} runs ${tag}`);
      arm(stop); // its unit gates on after this hello: its result may still say otherwise
    };
    const result = (id: string, msg: Extract<AgentMsg, { type: 'deployResult' }>) => {
      if (id !== agentId || msg.tag !== tag) return;
      const running = this.#running('agent', agentId);
      // Ok only when its hello named the tag, whatever its deploy says.
      const unshown = msg.outcome === 'ok' && running !== tag;
      const outcome = unshown ? 'failed' : msg.outcome;
      const log = unshown ? `${msg.log}\n${agent.name} says ok, but runs ${running ?? 'an unknown release'}` : msg.log;
      if (open) return done(outcome, log);
      stop(); // one result per deploy: a repeat, or an older deploy's, changes nothing
      this.#amend(row, outcome, log);
    };
    const off = () => {
      agents.off('agentUp', up);
      agents.off('deployResult', result);
    };
    const stop = () => {
      off();
      this.#listeners.delete(off);
      clearTimeout(timeout);
      if (timeout) this.#timers.delete(timeout);
      this.#agentDeploys.delete(agentId);
    };
    const done = (outcome: Exclude<DeployOutcome, 'running'>, log: string) => {
      if (!open) return;
      open = false;
      stop();
      this.#finish(row, outcome, log);
    };
    this.#starting = true;
    try {
      row = this.#begin('agent', agentId, from, tag, by);
      this.#agentDeploys.set(agentId, tag);
      agents.on('agentUp', up);
      agents.on('deployResult', result);
      this.#listeners.add(off);
      try {
        await agents.request(agentId, { type: 'deploy', tag });
      } catch (err) {
        done('failed', `the Agent didn't start it: ${(err as Error).message}`);
        throw err;
      }
    } finally {
      this.#starting = false;
    }
    if (open) arm(() => done('failed', `${agent.name} didn't come back with ${tag} in time`));
    return row.id;
  }

  /** An Agent's deploy closed ok on its hello, which its `deployResult` then tells otherwise (or ok, with its log). */
  #amend(row: DeployRow, outcome: Exclude<DeployOutcome, 'running'>, log: string): void {
    this.#d.db.amendDeploy(row.id, outcome, log.split('\n').slice(-LOG_LINES).join('\n'));
    if (outcome === 'ok') return; // as announced
    const { part, from, to, target } = row;
    this.#d.hub.publishTarget({ target: 'deploy', id: target, type: 'notice', severity: 'problem', kind: 'deployFinished', part, from, to, outcome });
  }
}

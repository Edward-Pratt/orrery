import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Environment, GithubIntegration, ServerSettings } from './config.ts';
import type { Db } from './db.ts';
import type { RestartScheduler } from './restarts.ts';
import type { ServerHub } from './servers.ts';
import type { Run } from './services.ts';
import type { DeployOutcome, DeployPart, DeployRow, HubEvent, Release } from './types.ts';
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

const TAG = /^(hub|web|mod)-v(\d+)\.(\d+)\.(\d+)$/;
const version = (tag: string) => TAG.exec(tag)!.slice(2).map(Number);
/** Newest first, by version. */
const newestFirst = (a: Release, b: Release) => {
  const [x, y] = [version(a.tag), version(b.tag)];
  return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
};
/** The first hub and dashboard releases that can deploy: an older one would take the deploy flow away. */
export const FLOOR = { hub: 'hub-v2.6.0', web: 'web-v0.5.0' } as const;
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
  /** Whether any restore runs (a hub deploy's restart would kill it). */
  restoring: () => boolean;
  /** Whether a pack update runs on a server (undefined: on any). */
  packing: (serverId?: string) => boolean;
  /** Where the database copy before a hub deploy goes. */
  dbCopies: string;
};

/** Shortened in tests. */
export type DeploysOptions = { pollMs?: number; watchMs?: number; modTimeoutMs?: number; countdownMinutes?: number };

/**
 * Releases and deploys: GitHub's published releases (asked hourly and on `check`) against what each part runs, and
 * deploying one, one at a time, recorded in the `deploys` history, audited and announced as `deploy` target notices.
 * The hub and dashboard deploy through their environment's templated units (`<template>@<tag>.service`, only for a
 * tag GitHub listed), whose outcome comes back in `deploy-status.json`; a Mod deploy puts the jar in place itself,
 * at the end of the server's countdown when it runs. Hub core.
 */
export class Deploys {
  #d: DeploysDeps;
  #pollMs: number;
  #watchMs: number;
  #modTimeoutMs: number;
  #countdownMinutes: number;
  #releases: Release[] = [];
  #checkedAt: number | null = null;
  #error: string | null = null;
  #starting = false; // between the checks and the row, so two requests can't both pass
  #timers = new Set<NodeJS.Timeout>();
  #listeners = new Set<(e: HubEvent) => void>();

  constructor(deps: DeploysDeps, { pollMs = 3_600_000, watchMs = 5_000, modTimeoutMs = 10 * 60_000, countdownMinutes = 5 }: DeploysOptions = {}) {
    this.#d = deps;
    this.#pollMs = pollMs;
    this.#watchMs = watchMs;
    this.#modTimeoutMs = modTimeoutMs;
    this.#countdownMinutes = countdownMinutes;
  }

  /** Asks GitHub now and every hour, and picks up deploys left running by the hub before this one. */
  start(): void {
    void this.check();
    const poll = setInterval(() => void this.check(), this.#pollMs);
    poll.unref();
    this.#timers.add(poll);
    for (const row of this.#d.db.deploys(HISTORY, { running: true })) {
      // A Mod deploy's countdown lived in the hub that started it.
      if (row.part === 'mod') this.#finish(row, 'failed', 'interrupted: the hub restarted');
      else this.#watch(row);
    }
  }

  stop(): void {
    for (const t of this.#timers) clearTimeout(t);
    for (const l of this.#listeners) this.#d.hub.off('event', l);
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

  /** Whether a Mod deploy onto a server runs (a pack update must wait for it). */
  modBusy(serverId: string): boolean {
    return this.#d.db.deploys(HISTORY, { running: true }).some((r) => r.part === 'mod' && r.target === serverId);
  }

  /** What runs against what is published, and the history newest first, 50 rows older than `before`. */
  answer(before?: number): DeploysAnswer {
    const part = (p: 'hub' | 'web'): PartReleases => {
      const releases = this.#of(p);
      return { running: this.#running(p), latest: releases[0]?.tag ?? null, releases };
    };
    const mod = this.#of('mod');
    const history = this.#d.db.deploys(HISTORY + 1, { before });
    return {
      hub: part('hub'),
      web: part('web'),
      mod: {
        latest: mod[0]?.tag ?? null,
        releases: mod,
        servers: this.#d.hub.list().map((s) => ({ id: s.id, name: s.name, running: this.#running('mod', s.id) })),
      },
      checkedAt: this.#checkedAt,
      error: this.#error,
      newerAfterDays: this.#d.config.newerAfterDays,
      history: history.slice(0, HISTORY),
      older: history.length > HISTORY,
      packing: this.#d.hub.list().flatMap((s) => (this.#d.packing(s.id) ? [s.id] : [])),
    };
  }

  /**
   * Starts deploying a listed release (`serverId`: the Mod's server; `by` to the audit log, `byName` to players)
   * and resolves with its history row's id once it is under way; the outcome comes as a `deployFinished` notice.
   * Rejects with `DeployRefused`, or another error if systemctl or the download fails (the row then closes failed).
   */
  async deploy(part: DeployPart, tag: string, by: string, serverId?: string, byName = by): Promise<number> {
    // The tag goes into a unit name: only one GitHub listed for this part, which also matches TAG.
    const release = this.#releases.find((r) => r.tag === tag && tag.startsWith(`${part}-v`));
    if (!release) throw new DeployRefused(404, `No published release ${tag}.`);
    const server = part === 'mod' ? this.#d.hub.get(serverId ?? '') : undefined;
    if (part === 'mod' && !server) throw new DeployRefused(404, 'No such server.');
    if (this.#starting || this.#d.db.deploys(1, { running: true }).length) throw new DeployRefused(409, 'Another deploy is running.');
    const from = this.#running(part, serverId);
    if (from === tag) throw new DeployRefused(409, `${tag} is already running.`);
    if (part === 'hub' && this.#d.restoring()) throw new DeployRefused(409, 'A restore is running: deploy the hub once it is done.');
    if (part === 'hub' && this.#d.packing()) throw new DeployRefused(409, 'A pack update is running: deploy the hub once it is done.');
    if (server && this.#d.packing(server.id)) throw new DeployRefused(409, `A pack update is running on ${server.name}: deploy the Mod once it is done.`);
    if (part !== 'mod' && newestFirst(release, { tag: FLOOR[part], publishedAt: 0, assets: [] }) > 0) {
      throw new DeployRefused(409, `${tag} is older than ${FLOOR[part]}, the first release that can deploy.`);
    }
    if (server) return this.#deployMod(release, server.id, server.name, from, by, byName);

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

  #running(part: DeployPart, serverId?: string): string | null {
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
    const v = this.#d.hub.modVersion(serverId!);
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
    const jars = release.assets.filter((a) => a.endsWith('.jar') && !a.endsWith('-dev.jar') && !a.endsWith('-sources.jar'));
    if (jars.length !== 1) throw new DeployRefused(409, `${release.tag} has no single Mod jar.`);

    const v = version(release.tag).join('.');
    const mods = join(dir, 'mods');
    const jar = `gtnhdiscord-${v}.jar`;
    const part = join(mods, `.${jar}.part`);
    this.#starting = true;
    let row: DeployRow;
    try {
      row = this.#begin('mod', serverId, from, release.tag, by);
      try {
        const bytes = await this.#d.github.download(release.tag, jars[0]!);
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
    const swap = async () => {
      await rename(part, join(mods, jar));
      for (const f of await readdir(mods)) if (/^gtnhdiscord-.*\.jar$/.test(f) && f !== jar) await rm(join(mods, f), { force: true });
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
    const done = (outcome: 'ok' | 'failed', log: string) => {
      this.#d.hub.off('event', listen);
      this.#listeners.delete(listen);
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
    this.#listeners.add(listen);
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
}

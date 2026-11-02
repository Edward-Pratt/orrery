// `Restores`: puts a backup back on a server through its `RestoreSource` (`list`, the names it may restore, and
// `run`): `folderRestore`, over a server folder with `deploy/restore-backup.sh` through the injected `RunRestore`
// (`execRestore`: bash, no shell parsing the name, the script's settings `GTNH_DIR`/`BACKUP_DIR`/`GTNH_SERVICE` in
// its environment, its prompt answered), or `agentRestore`, for a server an Agent runs, its `restore` request over
// the saves it last pushed (the Agent copies the save as the newest, which the next start loads), answered within
// `AGENT_RESTORE_MS` (10 min, not the 30 s of other requests: the copy of a big save can take longer); refusing
// (`RestoreRefused`: 404/409) unless the server's linked service is stopped (an Agent's: its pushed state), the name
// is one its source lists, and no restore runs on it, nor a hub deploy (`Deploys.busy()`) or its Agent's own deploy
// (`Deploys.agentBusy`, until its result) nor a pack or game update on it (`updating(id)`, which names the kind; a
// save of its game settings too, `GameSettings.busy`); `busy(id?)` says whether a restore runs (on any: a hub deploy
// waits for it; on a server: a pack or game update, and its Agent's deploy, do); a restore done tells
// `Packs.restored` (it ends a rollback's offer); every attempt on a known server audited as `restore`. Hub core.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Agents } from './agents.ts';
import { listBackups } from './backups.ts';
import type { ServerHub } from './servers.ts';
import type { Services } from './services.ts';
import type { Backup } from './types.ts';

/** `deploy/restore-backup.sh`'s settings, passed in its environment. */
export type RestoreEnv = { GTNH_DIR: string; BACKUP_DIR: string; GTNH_SERVICE: string };
/** Runs the restore script on a backup, answering its prompt: resolves with its output, rejects with its error output. */
export type RunRestore = (name: string, env: RestoreEnv) => Promise<string>;

const SCRIPT = fileURLToPath(new URL('../../deploy/restore-backup.sh', import.meta.url));
const PROMPT = 'Continue? [y/N] ';

/** The real script, through bash (no shell parses the name), as the hub's own user: the server's, as it requires. */
export const execRestore: RunRestore = (name, env) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'bash',
      [SCRIPT, name],
      { env: { ...process.env, ...env }, timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.replace(PROMPT, '').trim() || err.message)) : resolve(stdout)),
    );
    child.stdin?.end('y\n');
  });

/**
 * How one server's Backups are put back: `list`, the Backups it has (only a name in it is ever restored), and `run`,
 * the restore of one of them (`unit`: the server's linked service's unit), resolving with what it printed.
 */
export type RestoreSource = { list: () => Promise<Backup[]>; run: (name: string, unit: string) => Promise<string> };

/** A server folder's restore: `deploy/restore-backup.sh` through `run`, over its Backup folder's listing. */
export function folderRestore(run: RunRestore, dir: string, backupDir: string): RestoreSource {
  return { list: () => listBackups(backupDir), run: (name, unit) => run(name, { GTNH_DIR: dir, BACKUP_DIR: backupDir, GTNH_SERVICE: unit }) };
}

/**
 * How long an Agent's `restore` may take to answer: it copies the whole save first (a few hundred MB on a slow disk),
 * so the 30 s of the other requests would report a restore failed that still goes on.
 */
export const AGENT_RESTORE_MS = 10 * 60_000;

/**
 * A server an Agent runs: its `restore` request (the Agent checks the name against its own listing and that its unit
 * is stopped, then copies the save as the newest, which the next start loads), over the saves it pushed (`list`),
 * answered within `AGENT_RESTORE_MS`.
 */
export function agentRestore(agents: Pick<Agents, 'request'>, agentId: string, list: () => Promise<Backup[]>): RestoreSource {
  return {
    list,
    run: async (name) => {
      await agents.request(agentId, { type: 'restore', name }, { timeoutMs: AGENT_RESTORE_MS });
      return `${name} is copied as the newest save: the server loads it on its next start.`;
    },
  };
}

/**
 * What else a restore must not race: a deploy (`deploying`: a hub deploy, whose restart would kill a restore halfway,
 * or the server's Agent's own, which restarts it; null for none) and a pack or game update on the server (`updating`:
 * which, null for none); `restored` hears of each one done.
 */
export type RestoreChecks = {
  deploying?: (serverId: string) => 'hub' | 'agent' | null;
  updating?: (serverId: string) => string | null;
  restored?: (serverId: string) => void;
};

/** Why a restore wasn't run: 404 (no such server or backup) or 409 (not now). */
export class RestoreRefused extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Puts a listed backup back on a server through its `RestoreSource` (a folder's script, or its Agent), only while
 * the server's linked service is stopped, one at a time per server. Every attempt on a known server is audited. Hub
 * core.
 */
export class Restores {
  #hub: Pick<ServerHub, 'get' | 'audit'>;
  #services: Pick<Services, 'ofServer'>;
  #sources: Map<string, RestoreSource>;
  #o: Required<RestoreChecks>;
  #running = new Set<string>();

  /** `sources`: each server that can be restored, by id. */
  constructor(hub: Pick<ServerHub, 'get' | 'audit'>, services: Pick<Services, 'ofServer'>, sources: Map<string, RestoreSource>, o: RestoreChecks = {}) {
    this.#hub = hub;
    this.#o = { deploying: () => null, updating: () => null, restored: () => {}, ...o };
    this.#services = services;
    this.#sources = sources;
  }

  /** Whether a restore runs on a server (`serverId` undefined: on any). */
  busy(serverId?: string): boolean {
    return serverId === undefined ? this.#running.size > 0 : this.#running.has(serverId);
  }

  /** Resolves with what the restore printed; rejects with `RestoreRefused`, or the script's (or the Agent's) error. */
  async restore(serverId: string, name: string, by: string): Promise<string> {
    const server = this.#hub.get(serverId);
    if (!server) throw new RestoreRefused(404, 'No such server.');
    let run: () => Promise<string>;
    try {
      run = await this.#check(serverId, server.name, name);
    } catch (err) {
      this.#hub.audit(by, 'restore', serverId, `${name}: refused: ${(err as Error).message}`);
      throw err;
    }
    this.#running.add(serverId);
    try {
      const output = await run();
      this.#hub.audit(by, 'restore', serverId, `${name}: done`);
      this.#o.restored(serverId);
      return output;
    } catch (err) {
      this.#hub.audit(by, 'restore', serverId, `${name}: failed: ${(err as Error).message}`);
      throw err;
    } finally {
      this.#running.delete(serverId);
    }
  }

  /** The restore to run, once every check passed. */
  async #check(serverId: string, serverName: string, name: string): Promise<() => Promise<string>> {
    const service = this.#services.ofServer(serverId);
    if (!service) throw new RestoreRefused(409, `${serverName} has no linked service: restore it on the host with deploy/restore-backup.sh.`);
    const source = this.#sources.get(serverId);
    if (!source) throw new RestoreRefused(409, `${serverName} has no server folder.`);
    // Only a name the hub listed itself (its folder's, or its Agent's latest saves) reaches the script or the Agent.
    if (!(await source.list()).some((b) => b.name === name)) throw new RestoreRefused(404, `No backup ${name}.`);
    const updating = this.#o.updating(serverId);
    if (updating) throw new RestoreRefused(409, `A ${updating} is running on ${serverName}: restore once it is done.`);
    if (service.state !== 'inactive' && service.state !== 'failed') {
      throw new RestoreRefused(409, `${service.unit} is ${service.state ?? 'not read yet'}: stop it first.`);
    }
    // Checked after the last await, and marked running in the same turn, so two requests can't both pass.
    if (this.#running.has(serverId)) throw new RestoreRefused(409, `A restore is already running on ${serverName}.`);
    const deploying = this.#o.deploying(serverId);
    if (deploying === 'hub') throw new RestoreRefused(409, 'A hub deploy is running: restore once it is done.');
    if (deploying === 'agent') throw new RestoreRefused(409, `${serverName}'s Agent is being deployed: restore once it is done.`);
    return () => source.run(name, service.unit);
  }
}

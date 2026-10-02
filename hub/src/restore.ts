import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listBackups } from './backups.ts';
import type { ServerSettings } from './config.ts';
import type { ServerHub } from './servers.ts';
import type { Services } from './services.ts';

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
 * What else a restore must not race: a hub deploy (`deploying`: its restart would kill a restore halfway) and a pack
 * update on the server (`packing`); `restored` hears of each one done.
 */
export type RestoreChecks = { deploying?: () => boolean; packing?: (serverId: string) => boolean; restored?: (serverId: string) => void };

/** Why a restore wasn't run: 404 (no such server or backup) or 409 (not now). */
export class RestoreRefused extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Puts a listed backup back over a server's world with `deploy/restore-backup.sh`, only while the server's linked
 * service is stopped, one at a time per server. Every attempt on a known server is audited. Hub core.
 */
export class Restores {
  #hub: Pick<ServerHub, 'get' | 'audit'>;
  #services: Pick<Services, 'ofServer'>;
  #servers: Map<string, Pick<ServerSettings, 'dir' | 'backupDir'>>;
  #run: RunRestore;
  #o: Required<RestoreChecks>;
  #running = new Set<string>();

  constructor(
    hub: Pick<ServerHub, 'get' | 'audit'>,
    services: Pick<Services, 'ofServer'>,
    servers: Pick<ServerSettings, 'id' | 'dir' | 'backupDir'>[],
    run: RunRestore,
    o: RestoreChecks = {},
  ) {
    this.#hub = hub;
    this.#o = { deploying: () => false, packing: () => false, restored: () => {}, ...o };
    this.#services = services;
    this.#servers = new Map(servers.map((s) => [s.id, s]));
    this.#run = run;
  }

  /** Whether a restore runs on a server (`serverId` undefined: on any). */
  busy(serverId?: string): boolean {
    return serverId === undefined ? this.#running.size > 0 : this.#running.has(serverId);
  }

  /** Resolves with the script's output; rejects with `RestoreRefused`, or the script's error. */
  async restore(serverId: string, name: string, by: string): Promise<string> {
    const server = this.#hub.get(serverId);
    if (!server) throw new RestoreRefused(404, 'No such server.');
    let env: RestoreEnv;
    try {
      env = await this.#check(serverId, server.name, name);
    } catch (err) {
      this.#hub.audit(by, 'restore', serverId, `${name}: refused: ${(err as Error).message}`);
      throw err;
    }
    this.#running.add(serverId);
    try {
      const output = await this.#run(name, env);
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

  async #check(serverId: string, serverName: string, name: string): Promise<RestoreEnv> {
    const service = this.#services.ofServer(serverId);
    if (!service) throw new RestoreRefused(409, `${serverName} has no linked service: restore it on the host with deploy/restore-backup.sh.`);
    const { dir, backupDir } = this.#servers.get(serverId) ?? {};
    if (!dir || !backupDir) throw new RestoreRefused(409, `${serverName} has no server folder.`);
    if (this.#o.packing(serverId)) throw new RestoreRefused(409, `A pack update is running on ${serverName}: restore once it is done.`);
    // Only a name the hub listed itself reaches the script, never one from the request as such.
    if (!(await listBackups(backupDir)).some((b) => b.name === name)) throw new RestoreRefused(404, `No backup ${name}.`);
    if (service.state !== 'inactive' && service.state !== 'failed') {
      throw new RestoreRefused(409, `${service.unit} is ${service.state ?? 'not read yet'}: stop it first.`);
    }
    // Checked after the last await, and marked running in the same turn, so two requests can't both pass.
    if (this.#running.has(serverId)) throw new RestoreRefused(409, `A restore is already running on ${serverName}.`);
    if (this.#o.deploying()) throw new RestoreRefused(409, 'A hub deploy is running: restore once it is done.');
    return { GTNH_DIR: dir, BACKUP_DIR: backupDir, GTNH_SERVICE: service.unit };
  }
}

// The agent's own deploys (docs/protocol.md, `deploy` and `deployResult`): the hub's `deploy` starts
// orrery-agent-deploy@<tag>.service, which runs setup's root-owned copy of deploy/deploy-agent.sh as factorio (polkit,
// 60-orrery-agent.rules, allows exactly that start); the outcome that script writes to <root>/deploy-status.json goes
// back to the hub as `deployResult`, once per deploy.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMsg } from '../../hub/src/types.ts';
import { head } from './files.ts';
import { writeAtomic } from './hub.ts';
import { redact } from './logs.ts';
import { systemctl, type Systemctl } from './service.ts';
import { LIMITS } from './wire.ts';

/** A release of the agent, `agent-vX.Y.Z`: the only tags whose deploy unit polkit lets the agent start. */
const TAG = /^agent-v\d+\.\d+\.\d+$/;
export const isTag = (tag: string): boolean => tag.length <= LIMITS.text && TAG.test(tag);

/** The deploy unit's instance for `tag`, exactly the name 60-orrery-agent.rules allows (`%i` in the unit: unescaped). */
export const deployUnit = (tag: string): string => `orrery-agent-deploy@${tag}.service`;

/** `systemctl start --no-block -- <unit>`: back once the job is queued, so the deploy never holds the hub's reply. */
export const deployArgs = (tag: string): string[] => ['start', '--no-block', '--', deployUnit(tag)];

/** The status file deploy-agent.sh writes in the agent's folder when a deploy ends (it removes it when one starts). */
export const DEPLOY_STATUS = 'deploy-status.json';

/** The deploy log lines a `deployResult` carries: deploy-agent.sh's excerpt is as many. */
export const LOG_LINES = 40;

/** A oneshot deploy unit's states while its script runs, as hub/src/deploys.ts reads deploy-hub.sh's. */
const RUNNING = new Set(['activating', 'active', 'reloading', 'deactivating']);

/**
 * Every instance of the deploy unit systemd knows, one per line, `<unit> <load> <active> <sub> <description>`
 * (`--plain`: no bullets), so a deploy of any tag still running is seen. Reading units needs no polkit.
 */
export const LIST_ARGS: readonly string[] = ['list-units', '--all', '--plain', '--no-legend', '--full', '--', 'orrery-agent-deploy@*.service'];
const UNIT = /^orrery-agent-deploy@agent-v\d+\.\d+\.\d+\.service$/;

/** The status file holds 40 lines of log; more than this can't be the script's (cut short, it fails to parse). */
const STATUS_BYTES = 1024 * 1024;

export type DeployResultMsg = Extract<AgentMsg, { type: 'deployResult' }>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A deploy's log as `deployResult` carries it: its last 40 lines, URL query strings stripped (`redact`), and the end
 * kept within the hub's 16 KiB (`LIMITS.deployLog`), never splitting a surrogate pair.
 */
export function logExcerpt(log: string): string {
  const text = redact(log.split('\n').slice(-LOG_LINES).join('\n'));
  if (text.length <= LIMITS.deployLog) return text;
  const end = text.slice(-LIMITS.deployLog);
  return /^[\uDC00-\uDFFF]/.test(end) ? end.slice(1) : end;
}

/**
 * `deploy-status.json` as deploy-agent.sh writes it, `{ tag, from, outcome: "ok" | "failed" | "rolled back",
 * finished, log }`: the `deployResult` it makes (the outcome as is, the log as `logExcerpt`) and its key, the tag and
 * `finished` (a deploy's identity: the same tag can be deployed again). Null for anything else, a tag that isn't
 * `agent-vX.Y.Z` included, so no unit name is ever built from one.
 */
export function readStatus(text: string): { key: string; msg: DeployResultMsg } | null {
  let s: unknown;
  try {
    s = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(s)) return null;
  const { tag, outcome, finished, log } = s;
  if (typeof tag !== 'string' || !isTag(tag) || typeof finished !== 'string' || typeof log !== 'string') return null;
  if (outcome !== 'ok' && outcome !== 'failed' && outcome !== 'rolled back') return null;
  return { key: JSON.stringify([tag, finished]), msg: { type: 'deployResult', tag, outcome, log: logExcerpt(log) } };
}

export type DeploysOptions = {
  /** The agent's folder, `/srv/orrery-agent`: `deploy-status.json`. */
  root: string;
  /** The agent's bookkeeping, `<root>/state`: `deploy.json`, the last outcome the hub took. */
  state: string;
  /** This release, `agent-vX.Y.Z`: a deploy of it is refused. */
  version: string;
  /** Whether a game update runs: a deploy is refused then. */
  busy: () => boolean;
  /** `deployResult` on the Agent connection: false while it isn't up. */
  send: (msg: DeployResultMsg) => boolean;
  run?: Systemctl;
  /** How often `deploy-status.json` is looked at. */
  pollMs?: number;
};

/**
 * The agent's deploys. `deploy(tag)`: a well-formed tag only, refused for the release running, while a game update
 * runs, and while a deploy unit (any tag's) hasn't ended (deploy-agent.sh would exit before writing its status, so the
 * hub would never hear its end), then `systemctl start --no-block -- orrery-agent-deploy@<tag>.service` (resolves once
 * systemd took the job: the reply means started). The outcome: every `pollMs` (and on each connect, `connected`) `<root>/deploy-status.json` is read; one
 * not sent yet goes out as `deployResult` once its unit has ended (systemctl show: no longer activating, active,
 * reloading or deactivating, as the script still prunes after writing it), and is recorded in `<state>/deploy.json`
 * only once the Agent connection took it. It is polled, not read once at connect: the script writes it after the
 * restarted agent connected, and a deploy that failed before its restart never restarts the agent at all.
 */
export class Deploys {
  #o: Required<DeploysOptions>;
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;
  /** Checks one at a time, in order: a poll and a connect never send one outcome twice. */
  #queue: Promise<void> = Promise.resolve();
  /** The key of the last outcome the hub took; undefined until `deploy.json` is read. */
  #sent: string | null | undefined;
  #logged = '';

  constructor(options: DeploysOptions) {
    this.#o = { run: systemctl(), pollMs: 5000, ...options };
  }

  get #file(): string {
    return join(this.#o.state, 'deploy.json');
  }

  /** The hub's `deploy`: starts the deploy unit for `tag`, nothing from the request but the checked tag in its name. */
  async deploy(tag: string): Promise<void> {
    if (!isTag(tag)) throw new Error(`${JSON.stringify(tag)} is not an agent-vX.Y.Z tag`);
    if (tag === this.#o.version) throw new Error(`${tag} is already running`);
    if (this.#o.busy()) throw new Error('a game update is running');
    const live = await this.#live();
    if (live) throw new Error(`a deploy is running (${live})`);
    const unit = deployUnit(tag);
    try {
      await this.#o.run(deployArgs(tag));
    } catch (err) {
      throw new Error(`systemctl start ${unit} failed: ${(err as Error).message.trim()}`);
    }
    console.log(`[deploy] started ${unit}`);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#loop();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  /** The Agent connection is up again: an outcome it hasn't taken goes now. */
  connected(): void {
    void this.check();
  }

  /** Sends the outcome in `deploy-status.json` if the hub hasn't taken it and its unit has ended. Never rejects. */
  check(): Promise<void> {
    this.#queue = this.#queue.then(() => this.#check()).catch((err: Error) => this.#once(`[deploy] can't check the deploy's outcome: ${err.message}`));
    return this.#queue;
  }

  async #loop(): Promise<void> {
    await this.check();
    if (!this.#stopped) this.#timer = setTimeout(() => void this.#loop(), this.#o.pollMs);
  }

  async #check(): Promise<void> {
    const text = await head(join(this.#o.root, DEPLOY_STATUS), STATUS_BYTES);
    if (text === null) return; // none since the last deploy started
    const status = readStatus(text);
    if (!status) return this.#once(`[deploy] ${DEPLOY_STATUS} is not deploy-agent.sh's: not sent`);
    if (status.key === (await this.#lastSent())) return;
    const unit = deployUnit(status.msg.tag);
    let active: string;
    try {
      active = /^ActiveState=(.*)$/m.exec(await this.#o.run(['show', '--property=ActiveState', '--', unit]))?.[1] ?? '';
    } catch (err) {
      return this.#once(`[deploy] can't read ${unit}: ${(err as Error).message.trim()}`);
    }
    if (RUNNING.has(active) || !this.#o.send(status.msg)) return; // the script is finishing, or no hub: later
    this.#sent = status.key;
    this.#logged = '';
    console.log(`[deploy] ${status.msg.tag}: ${status.msg.outcome}, sent to the hub`);
    try {
      await mkdir(this.#o.state, { recursive: true });
      await writeAtomic(this.#file, JSON.stringify({ sent: status.key }) + '\n');
    } catch (err) {
      console.error(`[deploy] can't write ${this.#file}: ${(err as Error).message}`);
    }
  }

  /** A deploy unit that hasn't ended, any tag's, as `<unit> is <state>`; null if none. */
  async #live(): Promise<string | null> {
    let out: string;
    try {
      out = await this.#o.run([...LIST_ARGS]);
    } catch (err) {
      throw new Error(`can't tell whether a deploy is running: ${(err as Error).message.trim()}`);
    }
    for (const line of out.split('\n')) {
      const [unit = '', , active = ''] = line.replace(/^\s*[●*]?\s*/, '').split(/\s+/); // a bullet, should one show
      if (UNIT.test(unit) && RUNNING.has(active)) return `${unit} is ${active}`;
    }
    return null;
  }

  /** The key `deploy.json` records (read once); null if none. */
  async #lastSent(): Promise<string | null> {
    if (this.#sent === undefined) {
      const text = await head(this.#file, 64 * 1024);
      let sent: unknown = null;
      try {
        if (text !== null) sent = (JSON.parse(text) as { sent?: unknown }).sent;
      } catch {}
      this.#sent = typeof sent === 'string' ? sent : null;
    }
    return this.#sent;
  }

  #once(line: string): void {
    if (line !== this.#logged) console.error(line);
    this.#logged = line;
  }
}

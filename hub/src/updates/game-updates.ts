// `GameUpdates` (with agents and systemd), for a server an Agent runs (`has`; others 404): the state the flows share
// (`GameCtx`, `game-ctx.ts`, with why an update can't start now), the start and stop, and the public API, each method
// a call into the flow that does it: `state` (`GameState`: what its Agent last reported in `installed`, in memory, null
// before; the history; the running update with its steps; `blocked`); `catalog`, `browse`, `thumbnail` and `check`
// (`game-catalog.ts`, their bodies and queries checked in `game-messages.ts`); `update` and `cancel` (`game-run.ts`,
// the hub's stop `game-stop.ts`, the job's steps, waits and end `game-job.ts`); `busy(id?)` (for `updating`), one per
// server. This file re-exports `fitsLine` and `redact`. At start, a `running` row of its servers left by a restart is
// closed as `failed`, interrupted during its step: before the swap the Agent is told to cancel it when it connects;
// either way the Agent's later `updateDone` is recorded on the row and announced, matched by the update's id: the last
// hub's is gone, so the first id the Agent echoes in an `updateStep` (it resends a running update's latest on
// connecting), else its next `updateDone`'s; when it refuses the reconnect's `updateCancel` with no step echoed first,
// nothing runs and that row takes none; so is a late one after the hub gave an update up (by its id). A new update on
// the server ends that wait (the Agent takes one only once the last one's end is sent). Audited (`game update`, `game
// update cancel`), announced as `packUpdateStarted`/`packUpdateStep` (stream only)/`packUpdateFinished`. Hub core.

import type { Agents } from '../agents/agents.ts';
import type { GameCatalog, GameState, ModBrowse, ModCheckAnswer } from '../api.ts';
import type { ServerSettings } from '../config.ts';
import type { Db } from '../stats/db.ts';
import type { FactorioCatalog } from './factorio.ts';
import type { RestartScheduler } from '../servers/restarts.ts';
import type { ServerHub } from '../servers/servers.ts';
import type { Services } from '../services/services.ts';
import { browse, catalog, check, thumbnail } from './game-catalog.ts';
import { blockedReason, has, nameOf, type GameCtx, type Installed, type Late } from './game-ctx.ts';
import { cancellable, HISTORY, SWAPPED, tellCancel, type Job } from './game-job.ts';
import { cancelUpdate, onDone, onStep, startUpdate } from './game-run.ts';

export { fitsLine, redact } from './game-messages.ts';

/** Shortened in tests. */
export type GameUpdatesOptions = {
  /** How long a stop (countdown included) may take, and then the unit to be inactive (15 min each). */
  stopMs?: number;
  /** How often a stopping unit is read again (2 s). */
  pollMs?: number;
  /** How long the Agent may say nothing about the update it runs before the hub gives it up (15 min). */
  quietMs?: number;
};

export type GameUpdatesDeps = {
  hub: Pick<ServerHub, 'get' | 'on' | 'off' | 'publish' | 'audit'>;
  db: Db;
  agents: Pick<Agents, 'list' | 'get' | 'request' | 'on'>;
  services: Pick<Services, 'ofServer' | 'act' | 'read'>;
  restarts: Pick<RestartScheduler, 'cancel' | 'pending'>;
  catalog: Pick<FactorioCatalog, 'releases' | 'resolve' | 'sha256' | 'download' | 'link' | 'browse' | 'thumbnail' | 'check'>;
  /** The servers, for their names. */
  servers: Pick<ServerSettings, 'id' | 'name'>[];
  /** Whether a restore runs on a server. */
  restoring: (serverId: string) => boolean;
  /**
   * What deploy runs that an update must not race (`agentId`: the server's Agent): a hub deploy (its restart would
   * leave the update to the Agent alone), or the Agent's own (it restarts itself); null: none.
   */
  deploying: (agentId: string) => 'hub' | 'agent' | null;
  /** Whether a save of a server's game settings is under way (`GameSettings.busy`): an update waits for it. */
  settingsSaving?: (serverId: string) => boolean;
};

/**
 * Game updates of the factorio servers Agents run (`has`), Packs-like: the hub resolves the Factorio version and the
 * mods (`FactorioCatalog`) and decides; the Agent carries it out. `update` sends the Agent `update` (the release, and
 * each mod's signed download link, resolved right before); the Agent prepares and saves, then waits (`stop`
 * `waiting`) while the hub stops the server through `Services.act`, with the usual countdown when players are on,
 * and sends `updateResume` once the unit is inactive; the Agent swaps, starts it, gates and rolls back, and ends with
 * `updateDone`. `updateCancel` before the swap. One per server, each a `pack_updates` row, audited and announced as
 * `packUpdate*` notices, with every detail from the Agent redacted. Hub core.
 */
export class GameUpdates {
  #d: GameUpdatesDeps;
  #c: GameCtx; // what the game update flows share with this (`game-ctx.ts`)
  #agentOf = new Map<string, string>();
  #serverOf = new Map<string, string>();
  #installed = new Map<string, Installed>();
  #jobs = new Map<string, Job>();
  #starting = new Set<string>();
  #late = new Map<string, Late>();
  /** Agents to tell `updateCancel` when they connect: the hub dropped an update of theirs before its swap. */
  #cancelOnConnect = new Set<string>();
  /** Stops each wait and ticker without resolving it: a closing hub leaves a running update as a crash would. */
  #halts = new Set<() => void>();

  constructor(deps: GameUpdatesDeps, o: GameUpdatesOptions = {}) {
    this.#d = deps;
    this.#c = {
      d: deps,
      o: { stopMs: 15 * 60_000, pollMs: 2_000, quietMs: 15 * 60_000, ...o },
      agentOf: this.#agentOf,
      serverOf: this.#serverOf,
      installed: this.#installed,
      jobs: this.#jobs,
      starting: this.#starting,
      late: this.#late,
      cancelOnConnect: this.#cancelOnConnect,
      halts: this.#halts,
      closed: false,
    };
    for (const a of deps.agents.list()) {
      this.#agentOf.set(a.server, a.id);
      this.#serverOf.set(a.id, a.server);
    }
  }

  /**
   * Closes the updates the last hub left running as interrupted (the Agent is told to cancel one from before its swap
   * when it connects, and its later end is recorded on the row), and listens to the Agents. Before any Agent connects.
   */
  start(): void {
    const c = this.#c;
    for (const row of this.#d.db.packUpdates(undefined, 1000)) {
      if (!this.has(row.serverId)) continue; // a pack update's: Packs closes those
      const swapped = SWAPPED.has(row.step);
      const why = `interrupted during ${row.step}: the hub restarted. ${swapped ? "The Agent's result is recorded when it comes." : 'The Agent is told to cancel it when it connects.'}`;
      this.#d.db.setPackUpdate(row.id, { outcome: 'failed', finished: Date.now(), log: [row.log, why].filter(Boolean).join('\n') });
      if (!swapped) this.#cancelOnConnect.add(this.#agentOf.get(row.serverId)!);
      this.#late.set(row.serverId, { row: row.id, update: null, from: row.from, to: row.to, started: row.started });
    }
    const { agents } = this.#d;
    agents.on('agentUp', (agentId) => {
      if (!this.#cancelOnConnect.delete(agentId)) return;
      tellCancel(c, agentId, () => {
        // Refused: nothing runs there. An update whose id it didn't echo first (it resends a running one's step on
        // connecting, before it reads this) has no end to come, and a stray one must not land on its row.
        const serverId = this.#serverOf.get(agentId)!;
        if (this.#late.get(serverId)?.update === null) this.#late.delete(serverId);
      });
    });
    agents.on('installed', (agentId, msg) => {
      const serverId = this.#serverOf.get(agentId);
      if (serverId !== undefined) this.#installed.set(serverId, { factorio: msg.factorio, mods: msg.mods });
    });
    agents.on('updateStep', (agentId, msg) => onStep(c, agentId, msg));
    agents.on('updateDone', (agentId, msg) => onDone(c, agentId, msg));
  }

  stop(): void {
    this.#c.closed = true;
    for (const halt of this.#halts) halt();
    for (const job of this.#jobs.values()) clearTimeout(job.quiet);
  }

  /** Whether a server has game updates: an Agent runs it. */
  has(serverId: string): boolean {
    return has(this.#c, serverId);
  }

  /** Whether a game update runs on a server (`serverId` undefined: on any). */
  busy(serverId?: string): boolean {
    if (serverId === undefined) return this.#jobs.size > 0 || this.#starting.size > 0;
    return this.#jobs.has(serverId) || this.#starting.has(serverId);
  }

  /** What the server runs, its history, the running update and why one can't start now. */
  state(serverId: string): GameState {
    nameOf(this.#c, serverId);
    const job = this.#jobs.get(serverId);
    return {
      installed: this.#installed.get(serverId) ?? null,
      history: this.#d.db.packUpdates(serverId, HISTORY).map(({ serverId: _, restored: __, ...row }) => row),
      running: job
        ? { id: job.id, from: job.from, to: job.to, by: job.byName, started: job.started, steps: job.steps, cancellable: cancellable(job) }
        : null,
      blocked: blockedReason(this.#c, serverId),
    };
  }

  /** The releases on offer, and the picked mods resolved for the Factorio version, with what that would change. */
  catalog(serverId: string, body: unknown): Promise<GameCatalog> {
    return catalog(this.#c, serverId, body);
  }

  /**
   * The mod browser: a page of the portal's mods for the line of the Factorio version in `query` (`factorio`, `q`,
   * `category`, `sort`, `page`), through the catalog. 400 for a bad parameter, 502 if the portal can't be read.
   */
  browse(serverId: string, query: Record<string, string | undefined>): Promise<ModBrowse> {
    return browse(this.#c, serverId, query);
  }

  /**
   * The Import mod list's check: whether the portal has each name for the line of the Factorio version (`factorio`,
   * `names`), through the catalog's list for that line. 400 for a bad body, 502 if the portal can't be read.
   */
  check(serverId: string, body: unknown): Promise<ModCheckAnswer> {
    return check(this.#c, serverId, body);
  }

  /** A portal mod's thumbnail (a PNG) for the mod browser; null when it has none or the name isn't a mod's. */
  thumbnail(serverId: string, name: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return thumbnail(this.#c, serverId, name);
  }

  /**
   * Starts a game update and resolves with its history row's id once the Agent has been sent it; the rest runs in the
   * background. Refused (`GameRefused`) unless it can run now, every dependency is met and something changes.
   */
  update(serverId: string, body: unknown, by: string, byName: string): Promise<number> {
    return startUpdate(this.#c, serverId, body, by, byName);
  }

  /** Cancels the running update before its swap: while the Agent prepares, or during the stop's countdown. */
  cancel(serverId: string, by: string, byName: string): Promise<void> {
    return cancelUpdate(this.#c, serverId, by, byName);
  }
}

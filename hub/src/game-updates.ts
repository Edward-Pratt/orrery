import { randomUUID } from 'node:crypto';
import type { Agents } from './agents.ts';
import type { GameCatalog, GameModPick, GameState, GameUpdateRequest } from './api.ts';
import type { ServerSettings } from './config.ts';
import type { Db } from './db.ts';
import { GAME_MODS, GameRefused, gameLabel, validName, VERSION, type FactorioCatalog, type Resolution } from './factorio.ts';
import { LIMITS } from './protocol.ts';
import type { RestartScheduler } from './restarts.ts';
import type { HubEvent, ServerHub } from './servers.ts';
import type { Services } from './services.ts';
import type { AgentMsg, FactorioDownload, FactorioMod, FactorioModDownload, PackFinished, PackStep, PackStepState, Severity } from './types.ts';
import { formatDuration } from './units.ts';

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
  catalog: Pick<FactorioCatalog, 'releases' | 'resolve' | 'sha256' | 'download' | 'link'>;
  /** The servers, for their names. */
  servers: Pick<ServerSettings, 'id' | 'name'>[];
  /** Whether a restore runs on a server. */
  restoring: (serverId: string) => boolean;
  /** Whether a hub deploy runs (its restart would leave the update to the Agent alone). */
  deploying: () => boolean;
};

const STEPS: PackStep[] = ['prepare', 'backup', 'stop', 'swap', 'gate'];
/** Steps from which the Agent has changed the server: no cancel any more. */
const SWAPPED = new Set<PackStep>(['swap', 'gate', 'rollback']);
const HISTORY = 50;
const LOG_LINES = 40;
/** How often the countdown's detail goes on the stream. */
const TICK_MS = 1_000;

/**
 * Text from the Agent with every URL's query string, any other `?key=value` and every `token=`, `secure=` and
 * `username=` value taken out, before it is a step's detail, a log line or a notice (the Agent strips them too).
 */
export function redact(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?#"'<>]*)\?[^\s#"'<>]*/gi, '$1')
    .replace(/(\S)\?[\w.~%-]+=[^\s#"'<>]*/g, '$1')
    .replace(/\b(token|secure|username)=[^&\s"'<>]*/gi, '$1=[redacted]');
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** A game update request's body, checked: 400 otherwise. */
function request(body: unknown): GameUpdateRequest {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof b.factorio !== 'string' || !VERSION.test(b.factorio)) throw new GameRefused(400, 'Give a Factorio version, like 2.1.24.');
  if (!Array.isArray(b.mods) || b.mods.length > LIMITS.mods) throw new GameRefused(400, `Give the mods to have (mods, at most ${LIMITS.mods}).`);
  const mods: GameModPick[] = [];
  for (const m of b.mods as unknown[]) {
    const { name, version = null } = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !validName(name)) throw new GameRefused(400, 'Give each mod by its name on the mod portal.');
    if (version !== null && (typeof version !== 'string' || !VERSION.test(version))) {
      throw new GameRefused(400, `${name}: give a version like 1.2.3, or null for the newest that fits.`);
    }
    if (GAME_MODS.has(name)) throw new GameRefused(400, `${name} comes with Factorio: it isn't picked.`);
    if (mods.some((p) => p.name === name)) throw new GameRefused(400, `${name} is picked twice.`);
    mods.push({ name, version });
  }
  return { factorio: b.factorio, mods };
}

type Installed = { factorio: string; mods: FactorioMod[] };
type Plan = Resolution & { changes: string[]; from: string; to: string };
type Job = {
  /** Its history row. */
  id: number;
  /** The `update` request's id, which the Agent's steps and end carry. */
  update: string;
  serverId: string;
  agentId: string;
  name: string;
  from: string;
  to: string;
  actor: string;
  byName: string;
  started: number;
  steps: PackStepState[];
  /** Where Cancel is accepted now. */
  window: 'prepare' | 'countdown' | null;
  /** The Agent has swapped (or rolls back): nothing to cancel. */
  swapped: boolean;
  /** The hub's stop began (the Agent waits for it); `resumed`: the Agent was told to go on. */
  stopping: boolean;
  resumed: boolean;
  /** The Agent was told to cancel: its end follows. */
  cancelling: boolean;
  /** The row's step, as last written. */
  rowStep: PackStep;
  log: string[];
  backup: string | null;
  quiet: NodeJS.Timeout | undefined;
};
/** An update the hub closed before the Agent said how it ended: its later `updateDone` is recorded on the row (`update` null: any). */
type Late = { row: number; update: string | null; from: string; to: string; started: number };

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
  #o: Required<GameUpdatesOptions>;
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
  #closed = false;

  constructor(deps: GameUpdatesDeps, o: GameUpdatesOptions = {}) {
    this.#d = deps;
    this.#o = { stopMs: 15 * 60_000, pollMs: 2_000, quietMs: 15 * 60_000, ...o };
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
      if (this.#cancelOnConnect.delete(agentId)) this.#tellCancel(agentId);
    });
    agents.on('installed', (agentId, msg) => {
      const serverId = this.#serverOf.get(agentId);
      if (serverId !== undefined) this.#installed.set(serverId, { factorio: msg.factorio, mods: msg.mods });
    });
    agents.on('updateStep', (agentId, msg) => this.#onStep(agentId, msg));
    agents.on('updateDone', (agentId, msg) => this.#onDone(agentId, msg));
  }

  stop(): void {
    this.#closed = true;
    for (const halt of this.#halts) halt();
    for (const job of this.#jobs.values()) clearTimeout(job.quiet);
  }

  /** Whether a server has game updates: an Agent runs it. */
  has(serverId: string): boolean {
    return this.#agentOf.has(serverId);
  }

  /** Whether a game update runs on a server (`serverId` undefined: on any). */
  busy(serverId?: string): boolean {
    if (serverId === undefined) return this.#jobs.size > 0 || this.#starting.size > 0;
    return this.#jobs.has(serverId) || this.#starting.has(serverId);
  }

  /** What the server runs, its history, the running update and why one can't start now. */
  state(serverId: string): GameState {
    this.#name(serverId);
    const job = this.#jobs.get(serverId);
    return {
      installed: this.#installed.get(serverId) ?? null,
      history: this.#d.db.packUpdates(serverId, HISTORY).map(({ serverId: _, restored: __, ...row }) => row),
      running: job
        ? { id: job.id, from: job.from, to: job.to, by: job.byName, started: job.started, steps: job.steps, cancellable: this.#cancellable(job) }
        : null,
      blocked: this.#blocked(serverId),
    };
  }

  /** The releases on offer, and the picked mods resolved for the Factorio version, with what that would change. */
  async catalog(serverId: string, body: unknown): Promise<GameCatalog> {
    this.#name(serverId);
    const req = request(body);
    const installed = this.#installed.get(serverId) ?? { factorio: req.factorio, mods: [] };
    const [versions, plan] = await Promise.all([this.#d.catalog.releases(), this.#plan(req, installed)]);
    return { versions, mods: plan.mods.map(({ sha1: _, downloadUrl: __, ...m }) => m), unresolved: plan.unresolved, changes: plan.changes };
  }

  /**
   * Starts a game update and resolves with its history row's id once the Agent has been sent it; the rest runs in the
   * background. Refused (`GameRefused`) unless it can run now, every dependency is met and something changes.
   */
  async update(serverId: string, body: unknown, by: string, byName: string): Promise<number> {
    const name = this.#name(serverId);
    const req = request(body);
    const blocked = this.#blocked(serverId);
    if (blocked) throw new GameRefused(409, blocked);
    const installed = this.#installed.get(serverId)!; // blocked without it
    this.#starting.add(serverId);
    try {
      const plan = await this.#plan(req, installed);
      if (plan.unresolved.length) {
        throw new GameRefused(409, `Unmet dependencies: ${plan.unresolved.map((u) => `${u.mod} needs ${u.dependency}: ${u.reason}`).join(' ')}`);
      }
      if (!plan.changes.length && req.factorio === installed.factorio) throw new GameRefused(409, `Nothing to change: ${name} runs ${plan.from} already.`);
      const sha256 = await this.#d.catalog.sha256(req.factorio);
      if (!sha256) throw new GameRefused(400, `factorio.com lists no headless build of Factorio ${req.factorio} for the Agent's machine.`);
      // Right before the update: the signed links are short-lived.
      const mods: FactorioModDownload[] = [];
      for (const m of plan.mods) mods.push({ name: m.name, version: m.version, sha1: m.sha1, url: await this.#d.catalog.link(m.downloadUrl) });
      const now = this.#blocked(serverId, true); // things may have changed while the portal answered
      if (now) throw new GameRefused(409, now);
      const job: Job = {
        id: 0,
        update: randomUUID(),
        serverId,
        agentId: this.#agentOf.get(serverId)!,
        name,
        from: plan.from,
        to: plan.to,
        actor: by,
        byName,
        started: Date.now(),
        steps: STEPS.map((step) => ({ step, state: 'waiting', detail: '' })),
        window: 'prepare',
        swapped: false,
        stopping: false,
        resumed: false,
        cancelling: false,
        rowStep: 'prepare',
        log: [],
        backup: null,
        quiet: undefined,
      };
      job.id = this.#d.db.startPackUpdate(serverId, { from: job.from, to: job.to, changes: plan.changes, by: byName, started: job.started });
      this.#jobs.set(serverId, job);
      this.#d.hub.audit(by, 'game update', serverId, `${job.from} → ${job.to}${plan.changes.length ? `: ${plan.changes.join(', ')}` : ''}`);
      this.#d.hub.publish(serverId, { severity: 'info', kind: 'packUpdateStarted', from: job.from, to: job.to, by: byName });
      void this.#begin(job, { version: req.factorio, url: this.#d.catalog.download(req.factorio), sha256 }, mods);
      return job.id;
    } finally {
      this.#starting.delete(serverId);
    }
  }

  /** Cancels the running update before its swap: while the Agent prepares, or during the stop's countdown. */
  async cancel(serverId: string, by: string, byName: string): Promise<void> {
    const name = this.#name(serverId);
    const job = this.#jobs.get(serverId);
    if (!job) throw new GameRefused(409, `No game update is running on ${name}.`);
    if (!this.#cancellable(job)) throw new GameRefused(409, 'Too late to cancel: only before the swap, while it prepares or during the countdown.');
    this.#d.hub.audit(by, 'game update cancel', serverId, `${job.from} → ${job.to}`);
    if (job.window === 'countdown') return void this.#d.restarts.cancel(serverId, by, byName); // the stop sees it cancelled
    job.cancelling = true;
    try {
      await this.#d.agents.request(job.agentId, { type: 'updateCancel' });
    } catch (err) {
      job.cancelling = false;
      throw new GameRefused(502, `The Agent didn't cancel: ${redact((err as Error).message)}`);
    }
    this.#arm(job); // its end follows
  }

  // The update itself.

  /**
   * The update's mods and what it changes: the mod diff, by portal mods (the game's own come with its version, enabled
   * as they are); from and to count every enabled mod.
   */
  async #plan(req: GameUpdateRequest, installed: Installed): Promise<Plan> {
    const gameMods = new Set(installed.mods.filter((m) => GAME_MODS.has(m.name)).map((m) => m.name));
    const resolved = await this.#d.catalog.resolve(req.factorio, req.mods, gameMods);
    const was = installed.mods.filter((m) => !GAME_MODS.has(m.name));
    const changes: string[] = [];
    for (const m of resolved.mods) {
      const old = was.find((w) => w.name === m.name);
      if (!old) changes.push(`Added: ${m.name} ${m.version}`);
      else if (old.version !== m.version) changes.push(`Updated: ${m.name} ${old.version} → ${m.version}`);
    }
    const picked = new Set(req.mods.map((p) => p.name)); // one that can't be resolved isn't removed: it is unresolved
    for (const w of was) if (!resolved.mods.some((m) => m.name === w.name) && !picked.has(w.name)) changes.push(`Removed: ${w.name} ${w.version}`);
    return { ...resolved, changes, from: gameLabel(installed.factorio, installed.mods.length), to: gameLabel(req.factorio, gameMods.size + resolved.mods.length) };
  }

  async #begin(job: Job, factorio: FactorioDownload, mods: FactorioModDownload[]): Promise<void> {
    this.#step(job, 'prepare', 'running', 'Sent to the Agent');
    this.#arm(job);
    try {
      await this.#d.agents.request(job.agentId, { type: 'update', factorio, mods }, job.update);
    } catch (err) {
      if (this.#closed || this.#jobs.get(job.serverId) !== job) return;
      this.#step(job, 'prepare', 'failed', redact((err as Error).message));
      this.#tellCancel(job.agentId); // without an answer in time, it may have started all the same
      this.#end(job, 'failed in staging');
    }
  }

  #onStep(agentId: string, msg: Extract<AgentMsg, { type: 'updateStep' }>): void {
    const job = this.#jobOf(agentId);
    if (!job || msg.id !== job.update) return;
    this.#arm(job);
    // The stop is the hub's: the Agent's `stop` `waiting` asks for it.
    if (msg.step === 'stop') {
      if (msg.state === 'waiting' && !job.stopping && !job.cancelling) void this.#stop(job);
      return;
    }
    if (SWAPPED.has(msg.step)) {
      job.swapped = true;
      job.window = null;
    }
    this.#step(job, msg.step, msg.state, redact(msg.detail));
  }

  #onDone(agentId: string, msg: Extract<AgentMsg, { type: 'updateDone' }>): void {
    const serverId = this.#serverOf.get(agentId);
    if (serverId === undefined) return;
    const job = this.#jobs.get(serverId);
    if (job && msg.id === job.update) {
      if (msg.backup !== undefined) job.backup = redact(msg.backup);
      return this.#end(job, msg.outcome, true);
    }
    const late = this.#late.get(serverId);
    if (!late || (late.update !== null && late.update !== msg.id)) return;
    this.#late.delete(serverId);
    const row = this.#d.db.packUpdates(serverId, HISTORY).find((r) => r.id === late.row);
    const finished = Date.now();
    const backup = msg.backup === undefined ? undefined : redact(msg.backup);
    this.#d.db.setPackUpdate(late.row, {
      outcome: msg.outcome,
      finished,
      ...(backup !== undefined && { backup }),
      log: [row?.log, `Then the Agent ended it: ${msg.outcome}.`].filter(Boolean).join('\n'),
    });
    this.#finished(serverId, msg.outcome, late.from, late.to, finished - late.started, backup ?? null);
  }

  /** The hub's step: stops the server (with the countdown when players are on), then tells the Agent to go on. */
  async #stop(job: Job): Promise<void> {
    job.stopping = true;
    job.window = null;
    this.#arm(job); // off while the hub stops: its own waits are bounded
    const service = this.#d.services.ofServer(job.serverId)!; // a factorio server has one, an Agent's
    let stopped = false;
    try {
      const unit = (await this.#d.services.read(service.id))?.state;
      if (unit === 'inactive' || unit === 'failed') this.#step(job, 'stop', 'done', 'Already stopped');
      else {
        this.#step(job, 'stop', 'running', 'Stopping');
        const countdown = this.#wait(job.serverId, (e) =>
          e.type === 'notice' ? (e.kind === 'restartNow' ? 'fired' : e.kind === 'restartCancelled' || e.kind === 'restartCancelledDown' ? 'cancelled' : undefined) : undefined,
        this.#o.stopMs);
        let at: number | null;
        try {
          at = await this.#d.services.act(service.id, 'stop', job.actor, job.byName);
        } catch (err) {
          countdown.stop();
          throw err;
        }
        stopped = true;
        if (at === null) countdown.stop();
        else {
          job.window = 'countdown';
          const players = this.#d.hub.get(job.serverId)?.players.length ?? 0;
          const tick = this.#ticker(() => this.#step(job, 'stop', 'running', `${plural(players, 'player')} online: stopping in ${clock(at! - Date.now())}`));
          const how = await countdown.done;
          tick();
          job.window = null;
          if (how === 'cancelled') {
            stopped = false;
            return await this.#countdownCancelled(job);
          }
          if (how === undefined) throw new Error("The countdown didn't end in time.");
        }
        await this.#inactive(service.id);
        this.#step(job, 'stop', 'done', at === null ? 'Stopped' : 'Stopped after the countdown');
      }
      job.resumed = true;
      this.#arm(job);
      await this.#d.agents.request(job.agentId, { type: 'updateResume' });
    } catch (err) {
      if (this.#closed || this.#jobs.get(job.serverId) !== job) return;
      const why = redact((err as Error).message);
      if (job.resumed) this.#log(job, `The Agent didn't take the go-ahead: ${why}`);
      else this.#step(job, 'stop', 'failed', why);
      // Nothing swapped: the Agent drops the update, and a server the hub stopped starts again.
      this.#tellCancel(job.agentId);
      if (stopped) await this.#d.services.act(service.id, 'start', job.actor, job.byName).catch(() => {});
      this.#end(job, stopped ? 'failed before swap' : 'failed in staging');
    }
  }

  async #countdownCancelled(job: Job): Promise<void> {
    this.#log(job, 'The countdown was cancelled.');
    job.cancelling = true;
    try {
      await this.#d.agents.request(job.agentId, { type: 'updateCancel' });
      this.#arm(job); // its end follows
    } catch (err) {
      if (this.#closed || this.#jobs.get(job.serverId) !== job) return;
      if (!this.#d.agents.get(job.agentId)?.connected) this.#cancelOnConnect.add(job.agentId);
      this.#log(job, `The Agent didn't cancel: ${redact((err as Error).message)}`);
      this.#end(job, 'cancelled');
    }
  }

  /** The Agent said nothing about the update for `quietMs`: the hub gives it up (its later end still goes on the row). */
  #silent(job: Job): void {
    if (this.#closed || this.#jobs.get(job.serverId) !== job) return;
    const why = `No word from the Agent for ${formatDuration(this.#o.quietMs)}`;
    const at = job.steps.find((s) => s.state === 'running');
    if (at) this.#step(job, at.step, 'failed', why);
    else this.#log(job, why);
    if (!job.swapped && !job.resumed) this.#tellCancel(job.agentId);
    this.#end(job, job.cancelling ? 'cancelled' : job.swapped || job.resumed ? 'failed' : 'failed in staging');
  }

  /** (Re)starts the wait for the Agent's next word; off while the hub's own stop runs. */
  #arm(job: Job): void {
    clearTimeout(job.quiet);
    job.quiet = undefined;
    if (this.#closed || (job.stopping && !job.resumed && !job.cancelling)) return;
    job.quiet = setTimeout(() => this.#silent(job), this.#o.quietMs);
  }

  /** `updateCancel` to an Agent, answered or not; one that isn't connected gets it when it connects. */
  #tellCancel(agentId: string): void {
    this.#d.agents.request(agentId, { type: 'updateCancel' }).catch(() => {
      if (!this.#d.agents.get(agentId)?.connected) this.#cancelOnConnect.add(agentId);
    });
  }

  /** Closes the row, announces the end; `fromAgent`: the Agent's `updateDone`, else its later one is recorded too. */
  #end(job: Job, outcome: PackFinished, fromAgent = false): void {
    if (this.#closed) return;
    clearTimeout(job.quiet);
    this.#jobs.delete(job.serverId);
    if (!fromAgent) this.#late.set(job.serverId, { row: job.id, update: job.update, from: job.from, to: job.to, started: job.started });
    if (outcome === 'cancelled') this.#log(job, 'Cancelled before the swap.');
    const finished = Date.now();
    this.#d.db.setPackUpdate(job.id, { outcome, finished, backup: job.backup, log: job.log.slice(-LOG_LINES).join('\n') });
    this.#d.hub.audit(job.actor, 'game update', job.serverId, `${job.from} → ${job.to}: ${outcome}`);
    this.#finished(job.serverId, outcome, job.from, job.to, finished - job.started, job.backup);
  }

  #finished(serverId: string, outcome: PackFinished, from: string, to: string, ms: number, backup: string | null): void {
    const severity: Severity = outcome === 'ok' ? 'good' : ['rolled back', 'failed', 'failed before swap'].includes(outcome) ? 'problem' : 'info';
    this.#d.hub.publish(serverId, { severity, kind: 'packUpdateFinished', outcome, from, to, ms, ...(outcome === 'rolled back' && backup && { backup }) });
  }

  /** Sets a step's state and puts it on the stream; the row keeps the step the update is at. */
  #step(job: Job, step: PackStep, state: PackStepState['state'], detail: string): void {
    const i = job.steps.findIndex((x) => x.step === step);
    if (i === -1) job.steps.push({ step, state, detail });
    else job.steps[i] = { step, state, detail };
    if (state !== 'waiting' && job.rowStep !== step) {
      job.rowStep = step;
      this.#d.db.setPackUpdate(job.id, { step });
    }
    if (state !== 'running') this.#log(job, `${step}: ${state}${detail ? `: ${detail}` : ''}`);
    this.#d.hub.publish(job.serverId, { severity: 'info', kind: 'packUpdateStep', step, state, detail, cancellable: this.#cancellable(job) });
  }

  #log(job: Job, line: string): void {
    job.log.push(line);
    this.#d.db.setPackUpdate(job.id, { log: job.log.slice(-LOG_LINES).join('\n') });
  }

  #cancellable(job: Job): boolean {
    return job.window !== null && !job.swapped && !job.cancelling;
  }

  #jobOf(agentId: string): Job | undefined {
    const serverId = this.#serverOf.get(agentId);
    return serverId === undefined ? undefined : this.#jobs.get(serverId);
  }

  /** Why an update can't start on the server now; null: it can. `starting`: the caller's own start is under way. */
  #blocked(serverId: string, starting = false): string | null {
    const name = this.#name(serverId);
    if (this.#jobs.has(serverId) || (!starting && this.#starting.has(serverId))) return `A game update is running on ${name}.`;
    if (!this.#d.agents.get(this.#agentOf.get(serverId)!)?.connected) return `${name}'s Agent isn't connected.`;
    if (!this.#installed.has(serverId)) return `${name}'s Agent hasn't said what it runs yet.`;
    if (this.#d.restoring(serverId)) return `A restore is running on ${name}.`;
    if (this.#d.deploying()) return 'A hub deploy is running.';
    if (this.#d.restarts.pending(serverId)) return `A countdown is running on ${name}: cancel it first.`;
    return null;
  }

  /** A server's name; 404 unless it has game updates. */
  #name(serverId: string): string {
    if (!this.has(serverId)) throw new GameRefused(404, 'No such server.');
    return this.#d.servers.find((s) => s.id === serverId)?.name ?? serverId;
  }

  /** Polls the unit until it is stopped. */
  async #inactive(serviceId: string): Promise<void> {
    const end = Date.now() + this.#o.stopMs;
    for (;;) {
      const state = (await this.#d.services.read(serviceId))?.state;
      if (state === 'inactive' || state === 'failed') return;
      if (Date.now() > end) throw new Error(`The service didn't stop within ${formatDuration(this.#o.stopMs)}.`);
      await new Promise((r) => setTimeout(r, this.#o.pollMs));
    }
  }

  /** Runs `fn` now and every second until the returned stop is called. */
  #ticker(fn: () => void): () => void {
    fn();
    const timer = setInterval(fn, TICK_MS);
    const stop = () => {
      clearInterval(timer);
      this.#halts.delete(stop);
    };
    this.#halts.add(stop);
    return stop;
  }

  /** Waits for a server event `pick` turns into a value; `done` resolves with it, or undefined after `ms` or `stop`. */
  #wait<T>(serverId: string, pick: (e: HubEvent) => T | undefined, ms: number): { done: Promise<T | undefined>; stop: () => void } {
    let stop!: () => void;
    const done = new Promise<T | undefined>((resolve) => {
      const listen = (e: HubEvent) => {
        if (e.serverId !== serverId) return;
        const v = pick(e);
        if (v !== undefined) {
          resolve(v); // first: stop resolves with undefined
          stop();
        }
      };
      const timer = setTimeout(() => stop(), ms);
      const halt = () => {
        clearTimeout(timer);
        this.#d.hub.off('event', listen);
        this.#halts.delete(halt);
      };
      stop = () => {
        halt();
        resolve(undefined);
      };
      this.#d.hub.on('event', listen);
      this.#halts.add(halt);
    });
    return { done, stop };
  }
}

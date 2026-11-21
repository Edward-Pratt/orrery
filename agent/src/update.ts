// Game updates, the agent's side (docs/protocol.md, "Agent connection"): the hub decides what to run, the agent checks
// it, stages it, swaps it in, gates it and rolls it back. Steps: prepare, backup, stop (the hub's, with its countdown),
// swap, gate, and rollback when the gate fails. The hub's input is checked like any other (agent/CLAUDE.md, "Trust
// boundaries"); the hashes come from factorio.com and the mod portal, never from the hub alone.
//
// `Updates`, game updates one at a time: its state and public API, here. `update`: the hub's request checked first
// (`checkUpdate`, `update-checks.ts`; a refusal is the reply's `error`). Refused too while a deploy of the agent runs
// (`idle`, `Deploys.idle`, checked before `checkUpdate`, once `busy` already holds off a deploy), as the deploy's
// restart would cut the update short. Accepted, it runs (`update-run.ts`): prepare (`update-prepare.ts`, downloads
// `update-download.ts`), backup and the hub's stop (`update-backup.ts`), swap, gate and rollback (`update-swap.ts`);
// the steps go out through the throttle (`update-steps.ts`), the latest again on `connected`. Every end empties both
// `.incoming` folders, removes `mods.next`, releases the save and keeps the newest 3 releases, the running one and the
// one the update came from (`update-release.ts`). `<state>/update.json` (the agent's folder; nothing under the data
// folder is ever read for it; `update-job.ts`) records each phase before it acts: `start` after a restart ends one
// before the swap as failed (the old server started again if the hub had stopped it: after `updateResume`, or in the
// stop step when it ran at the backup and is stopped now) and rolls one back from the swap on; a finished one's
// `updateDone` is sent again. `updateDone` (`from`/`to`: `labels`; `backup`) kept, with `update.json`, until its write
// on the Agent connection succeeded (`deliver`), and sent again on each connect until then. Every detail and error is
// cut to 2 KiB and goes through `redact`; URLs in them are written without query string or fragment. `busy` while one
// runs, is checked or is recovered after a restart (a restore and a deploy are refused then). Roots, `Http`, the
// decompressor, the arch and every wait are injectable (`UpdatesOptions`, `update-ctx.ts`, with the context the flows
// share). This file re-exports the public names of its modules.
import { readFile, rm } from 'node:fs/promises';
import type { AgentMsg, PackFinished, PackStep } from '../../hub/src/types.ts';
import type { Status } from './status.ts';
import { unxz } from './unpack.ts';
import { checkUpdate, labels } from './update-checks.ts';
import { BEAT_MS, GATE_MS, STALL_MS, STEP_MS, STOP_WAIT_MS, type UpdatesCtx, type UpdatesOptions } from './update-ctx.ts';
import { http } from './update-download.ts';
import { BEFORE_SWAP, doneMsg, hubStopped, jobFile, readJob, reason, save, stopped, type Job, type Running } from './update-job.ts';
import { clean, current, prune } from './update-release.ts';
import { run } from './update-run.ts';
import { send, step } from './update-steps.ts';
import { rollback, startOld } from './update-swap.ts';
import type { Request } from './wire.ts';

export { ALLOWED_HOSTS, allowedUrl, checkUpdate, GAME_MODS, installedOf, labels, type InstalledMsg } from './update-checks.ts';
export { BEAT_MS, GATE_MS, STALL_MS, STEP_MS, STOP_WAIT_MS, type UnitControl, type UpdatesOptions } from './update-ctx.ts';
export { type Http } from './update-download.ts';
export { KEEP_RELEASES } from './update-release.ts';

/**
 * Game updates on this agent's server, one at a time (agent/CLAUDE.md, `src/update.ts`; the steps in `update-run.ts`).
 *
 * `<state>/update.json` (the agent's own folder: a file of that name under `<data>` is never read) records each phase
 * before it acts, so a restart of the agent ends an update before the swap as failed and rolls one back from the swap
 * on. Steps go out as `updateStep` (one per step per second at most, unless the state changes; the latest again on
 * each connect; a running one again after `BEAT_MS` without one), the end as `updateDone` (`from` and `to`: `labels`),
 * kept until its write on the Agent connection succeeded, and sent again on each connect until then. No detail carries a query string.
 */
export class Updates {
  #o: Required<UpdatesOptions>;
  #c: UpdatesCtx; // what the game update flows share with this (`update-ctx.ts`)
  #running: Running | null = null;
  #done: Extract<AgentMsg, { type: 'updateDone' }> | null = null;
  #removing: Promise<unknown> = Promise.resolve();
  /** An `update` being checked: a second one meanwhile is refused. */
  #starting = false;
  /** What `/orrery-status` said last: the next update's `from`. */
  #known: Status | null = null;
  /** Its latest answer since the gate's start, null before one: the gate's evidence. */
  #latest: Status | null = null;

  constructor(options: UpdatesOptions) {
    this.#o = {
      http,
      decompress: unxz,
      arch: process.arch,
      gateMs: GATE_MS,
      stopWaitMs: STOP_WAIT_MS,
      pollMs: 1000,
      stepMs: STEP_MS,
      beatMs: BEAT_MS,
      stallMs: STALL_MS,
      clock: () => performance.now(),
      ...options,
    };
    this.#c = {
      o: this.#o,
      running: () => this.#running,
      latest: () => this.#latest,
      clearLatest: () => {
        this.#latest = null;
      },
      finish: (r, outcome) => this.#finish(r, outcome),
    };
  }

  /**
   * Whether an update runs, or one is being checked or recovered after a restart (`#starting`, the gap before it
   * runs): a restore and a deploy are refused then.
   */
  get busy(): boolean {
    return this.#running !== null || this.#starting;
  }

  get #file(): string {
    return jobFile(this.#c);
  }

  /**
   * After a restart of the agent: an update `update.json` records ends now. Before the swap: as failed, nothing changed
   * (the old server started again if the hub had stopped it); from the swap on: rolled back. A finished one's
   * `updateDone` is sent again.
   */
  async start(): Promise<void> {
    let job: Job | null = null;
    this.#starting = true; // no update from the hub before this one is known
    try {
      job = readJob(JSON.parse(await readFile(this.#file, 'utf8')));
      if (!job) {
        console.error(`[update] ${this.#file} is not an update: removed`);
        await rm(this.#file, { force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[update] can't read ${this.#file}: ${reason(err)}`);
    } finally {
      this.#starting = false;
    }
    if (!job) return;
    if (job.backup) this.#o.saves.hold(job.backup);
    if (job.phase === 'done') {
      this.#done = doneMsg(job);
      return this.#flush();
    }
    const r = this.#begin(job);
    console.log(`[update] the agent restarted during update ${job.id} (${job.phase})`);
    if (BEFORE_SWAP.includes(job.phase)) {
      step(this.#c, r, job.phase as PackStep, 'failed', 'The agent restarted before the swap: nothing was changed');
      await clean(this.#c);
      const unit = await this.#o.unit.read().catch(() => null);
      // In the stop phase before `updateResume`, a stopped unit is the hub's stop only if the server ran at the backup;
      // after it, too: the hub resumes an update of a server stopped before it without stopping anything.
      const restart = hubStopped(job) || (job.phase === 'stop' && job.wasActive === true && unit !== null && stopped(unit));
      if (restart) await startOld(this.#c);
      return this.#finish(r, restart ? 'failed before swap' : 'failed in staging');
    }
    if (job.phase !== 'rollback') step(this.#c, r, job.phase as PackStep, 'failed', 'The agent restarted before the health gate passed');
    await this.#finish(r, await rollback(this.#c, r));
  }

  /** Stops the step throttle's timers (the agent exits; `update.json` stays for the next start). */
  stop(): void {
    clearTimeout(this.#running?.later);
    clearTimeout(this.#running?.beat);
  }

  /** Each `/orrery-status` answer: the gate's evidence, and the next update's `from`. */
  status(s: Status): void {
    this.#known = s;
    this.#latest = s;
  }

  /** The Agent connection is up again: the running update's latest step, and an `updateDone` not yet sent. */
  connected(): void {
    const r = this.#running;
    if (r?.current) send(this.#c, r, r.current);
    this.#flush();
  }

  /**
   * The hub's `update`: checked, then started; resolves once accepted (the reply), the steps follow. Refused while
   * another runs, one's `updateDone` waits to be sent, or a deploy of the agent runs (`idle`).
   */
  async update(req: Request<'update'>): Promise<void> {
    if (this.#running) throw new Error(`the update ${this.#running.job.id} is running`);
    if (this.#starting) throw new Error('another update is being checked');
    if (this.#done) throw new Error(`the update ${this.#done.id} has not been reported yet`);
    this.#starting = true; // before the deploy check: a deploy is refused from here on (busy)
    try {
      await this.#o.idle();
      checkUpdate(req, this.#o.arch);
      const previous = await current(this.#c);
      const fromVersion = previous.slice('releases/'.length);
      const known = this.#known?.version === fromVersion ? this.#known.mods : null;
      await this.#removing;
      const job: Job = {
        id: req.id,
        factorio: req.factorio.version,
        mods: req.mods.map(({ name, version }) => ({ name, version })),
        expect: null,
        from: { factorio: fromVersion, mods: known },
        label: labels(this.#o.installed(), fromVersion, req),
        previous,
        backup: null,
        phase: 'prepare',
        outcome: null,
        resumed: false,
      };
      await save(this.#c, job);
      console.log(`[update] ${job.id}: from ${job.label.from} to ${job.label.to}`);
      void run(this.#c, this.#begin(job), req);
    } catch (err) {
      throw new Error(reason(err));
    } finally {
      this.#starting = false;
    }
  }

  /**
   * The hub's `updateResume`: it stopped the server for the update waiting in its stop step. Its request id is its
   * own (docs/protocol.md): it acts on the one update running.
   */
  async resume(): Promise<void> {
    const r = this.#running;
    if (!r) throw new Error('no update is running');
    if (!r.wake) throw new Error(`the update ${r.job.id} is not waiting for the server to stop`);
    r.wake('resume');
  }

  /**
   * The hub's `updateCancel`, with a request id of its own, on the one update running: only before the swap; the
   * downloads stop and `.incoming` is cleaned. It never stops the unit, and starts it only when it ran at the backup
   * and is stopped now (`startAfterCancel`, `update-swap.ts`): the hub starts a server it stopped, unless it
   * restarted meanwhile.
   */
  async cancel(): Promise<void> {
    const r = this.#running;
    if (!r) throw new Error('no update is running');
    if (!BEFORE_SWAP.includes(r.job.phase)) throw new Error(`the update ${r.job.id} is past the swap: too late to cancel`);
    r.cancelled = true;
    r.abort.abort();
    r.wake?.('cancel');
  }

  #begin(job: Job): Running {
    const r: Running = { job, abort: new AbortController(), wake: null, cancelled: false, current: null, pending: null, sent: new Map(), later: undefined, beat: undefined };
    this.#running = r;
    return r;
  }

  async #finish(r: Running, outcome: PackFinished): Promise<void> {
    const { job } = r;
    clearTimeout(r.later);
    clearTimeout(r.beat);
    job.phase = 'done';
    job.outcome = outcome;
    await save(this.#c, job).catch((err: Error) => console.error(`[update] can't write ${this.#file}: ${reason(err)}`));
    if (job.backup) this.#o.saves.release(job.backup);
    await clean(this.#c);
    await prune(this.#c, job.previous).catch((err: Error) => console.error(`[update] can't prune ${this.#o.install}/releases: ${reason(err)}`));
    console.log(`[update] ${job.id}: ${outcome}`);
    this.#running = null;
    this.#done = doneMsg(job);
    this.#flush();
  }

  /**
   * The pending `updateDone`, sent if the Agent connection is up: only once its write succeeded is it done with, and
   * `update.json` goes. Until then it stays pending, and goes again on each connect (the hub ignores a repeat).
   */
  #flush(): void {
    const msg = this.#done;
    if (!msg) return;
    void this.#o.deliver(msg).then((written) => {
      if (!written || this.#done !== msg) return;
      this.#done = null;
      this.#removing = rm(this.#file, { force: true }).catch((err: Error) => console.error(`[update] can't remove ${this.#file}: ${reason(err)}`));
    });
  }
}

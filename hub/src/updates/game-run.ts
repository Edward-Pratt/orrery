// A game update's run, for `GameUpdates`: `startUpdate` (`update(id, body, by, byName)`: 400 bad input
// (`game-messages.ts`); 409 when `blocked`, with unmet dependencies, without `orrery` among the resolved mods (the
// Agent's gate reads it) or over `LIMITS.mods` of them, nothing to change, or no account for the links, all before any
// link or row; 400 for a version factorio.com lists no ARM64 build of; resolves each mod's signed link right before,
// refuses (409) an `update` line that wouldn't fit `LIMITS.lineBytes` with its newline (`fitsLine`), checks `blocked`
// again, opens the `pack_updates` row (from and to as `gameLabel`, the mod diff in `changes`), audits `game update`,
// announces `packUpdateStarted`, and sends the Agent `update` with its own request id, which the Agent's steps and end
// carry; the rest in the background); the steps are the Agent's (`onStep`), its `detail` and errors through `redact`:
// `prepare`, `backup`, then on its `stop` `waiting` the hub's stop (`game-stop.ts`); `swap`, `gate`, `rollback` and
// `updateDone` (`onDone`), its outcome and pre-update save, which end it; an `update` request refused (`AgentRefused`)
// ends it `failed in staging` with no `updateCancel` (only no reply in time or a dropped connection sends one);
// `cancelUpdate` before the swap (409 after), audited `game update cancel`: during the countdown it is cancelled
// (`RestartScheduler.cancel`), else the Agent is sent `updateCancel` (502 when it doesn't take it). An update's end is
// taken once: a repeat (the Agent resends it until its write went out) is ignored; a late one, of an update the hub
// closed, goes on that row as `game-updates.ts` says. Hub core.

import { randomUUID } from 'node:crypto';
import { AgentRefused } from '../agents/agents.ts';
import { LIMITS } from '../protocol.ts';
import type { AgentMsg, FactorioDownload, FactorioModDownload } from '../types.ts';
import { GameRefused } from './factorio.ts';
import { planUpdate } from './game-catalog.ts';
import { blockedReason, jobOf, nameOf, type GameCtx } from './game-ctx.ts';
import { announceEnd, arm, cancellable, end, HISTORY, setStep, STEPS, SWAPPED, tellCancel, type Job } from './game-job.ts';
import { fitsLine, redact, request } from './game-messages.ts';
import { hubStop } from './game-stop.ts';

export async function startUpdate(c: GameCtx, serverId: string, body: unknown, by: string, byName: string): Promise<number> {
  const name = nameOf(c, serverId);
  const req = request(body);
  const blocked = blockedReason(c, serverId);
  if (blocked) throw new GameRefused(409, blocked);
  const installed = c.installed.get(serverId)!; // blocked without it
  c.starting.add(serverId);
  try {
    const plan = await planUpdate(c, req, installed);
    if (plan.unresolved.length) {
      throw new GameRefused(409, `Unmet dependencies: ${plan.unresolved.map((u) => `${u.mod} needs ${u.dependency}: ${u.reason}`).join(' ')}`);
    }
    // The Agent's own rules, checked before anything is asked or written: it refuses an update breaking them.
    if (!plan.mods.some((m) => m.name === 'orrery')) throw new GameRefused(409, "The mods must include orrery: the Agent's health gate reads it.");
    if (plan.mods.length > LIMITS.mods) throw new GameRefused(409, `More than ${LIMITS.mods} mods: the Agent takes at most that many.`);
    if (!plan.changes.length && req.factorio === installed.factorio) throw new GameRefused(409, `Nothing to change: ${name} runs ${plan.from} already.`);
    const sha256 = await c.d.catalog.sha256(req.factorio);
    if (!sha256) throw new GameRefused(400, `factorio.com lists no headless build of Factorio ${req.factorio} for the Agent's machine.`);
    // Right before the update: the signed links are short-lived.
    const mods: FactorioModDownload[] = [];
    for (const m of plan.mods) mods.push({ name: m.name, version: m.version, sha1: m.sha1, url: await c.d.catalog.link(m.downloadUrl) });
    const factorio: FactorioDownload = { version: req.factorio, url: c.d.catalog.download(req.factorio), sha256 };
    const update = randomUUID();
    if (!fitsLine({ type: 'update', factorio, mods, id: update })) throw new GameRefused(409, `The update is over the Agent port's ${LIMITS.lineBytes}-byte line: pick fewer mods.`);
    const now = blockedReason(c, serverId, true); // things may have changed while the portal answered
    if (now) throw new GameRefused(409, now);
    const job: Job = {
      id: 0,
      update,
      serverId,
      agentId: c.agentOf.get(serverId)!,
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
    job.id = c.d.db.startPackUpdate(serverId, { from: job.from, to: job.to, changes: plan.changes, by: byName, started: job.started });
    // The Agent takes an update only once the last one's end is sent: nothing more of that one comes.
    c.late.delete(serverId);
    c.jobs.set(serverId, job);
    c.d.hub.audit(by, 'game update', serverId, `${job.from} → ${job.to}${plan.changes.length ? `: ${plan.changes.join(', ')}` : ''}`);
    c.d.hub.publish(serverId, { severity: 'info', kind: 'packUpdateStarted', from: job.from, to: job.to, by: byName });
    void begin(c, job, factorio, mods);
    return job.id;
  } finally {
    c.starting.delete(serverId);
  }
}

export async function cancelUpdate(c: GameCtx, serverId: string, by: string, byName: string): Promise<void> {
  const name = nameOf(c, serverId);
  const job = c.jobs.get(serverId);
  if (!job) throw new GameRefused(409, `No game update is running on ${name}.`);
  if (!cancellable(job)) throw new GameRefused(409, 'Too late to cancel: only before the swap, while it prepares or during the countdown.');
  c.d.hub.audit(by, 'game update cancel', serverId, `${job.from} → ${job.to}`);
  if (job.window === 'countdown') return void c.d.restarts.cancel(serverId, by, byName); // the stop sees it cancelled
  job.cancelling = true;
  try {
    await c.d.agents.request(job.agentId, { type: 'updateCancel' });
  } catch (err) {
    job.cancelling = false;
    throw new GameRefused(502, `The Agent didn't cancel: ${redact((err as Error).message)}`);
  }
  arm(c, job); // its end follows
}

async function begin(c: GameCtx, job: Job, factorio: FactorioDownload, mods: FactorioModDownload[]): Promise<void> {
  setStep(c, job, 'prepare', 'running', 'Sent to the Agent');
  arm(c, job);
  try {
    await c.d.agents.request(job.agentId, { type: 'update', factorio, mods }, { id: job.update });
  } catch (err) {
    if (c.closed || c.jobs.get(job.serverId) !== job) return;
    setStep(c, job, 'prepare', 'failed', redact((err as Error).message));
    // Without an answer in time, or cut off, it may have started all the same; refused, it never took it (and a
    // cancel would hit whatever update it does run).
    if (!(err instanceof AgentRefused)) tellCancel(c, job.agentId);
    end(c, job, 'failed in staging');
  }
}

export function onStep(c: GameCtx, agentId: string, msg: Extract<AgentMsg, { type: 'updateStep' }>): void {
  const job = jobOf(c, agentId);
  if (!job) {
    // The update a restarted hub closed, still running there: its end must carry this id.
    const late = c.late.get(c.serverOf.get(agentId) ?? '');
    if (late?.update === null) late.update = msg.id;
    return;
  }
  if (msg.id !== job.update) return;
  arm(c, job);
  // The stop is the hub's: the Agent's `stop` `waiting` asks for it.
  if (msg.step === 'stop') {
    if (msg.state === 'waiting' && !job.stopping && !job.cancelling) void hubStop(c, job);
    return;
  }
  if (SWAPPED.has(msg.step)) {
    job.swapped = true;
    job.window = null;
  }
  setStep(c, job, msg.step, msg.state, redact(msg.detail));
}

export function onDone(c: GameCtx, agentId: string, msg: Extract<AgentMsg, { type: 'updateDone' }>): void {
  const serverId = c.serverOf.get(agentId);
  if (serverId === undefined) return;
  const job = c.jobs.get(serverId);
  if (job && msg.id === job.update) {
    if (msg.backup !== undefined) job.backup = redact(msg.backup);
    return end(c, job, msg.outcome, true);
  }
  const late = c.late.get(serverId);
  if (!late || (late.update !== null && late.update !== msg.id)) return;
  c.late.delete(serverId);
  const row = c.d.db.packUpdates(serverId, HISTORY).find((r) => r.id === late.row);
  const finished = Date.now();
  const backup = msg.backup === undefined ? undefined : redact(msg.backup);
  c.d.db.setPackUpdate(late.row, {
    outcome: msg.outcome,
    finished,
    ...(backup !== undefined && { backup }),
    log: [row?.log, `Then the Agent ended it: ${msg.outcome}.`].filter(Boolean).join('\n'),
  });
  announceEnd(c, serverId, msg.outcome, late.from, late.to, finished - late.started, backup ?? null);
}

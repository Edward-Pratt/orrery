// The deploy rows and the watch, for `Deploys`: each deploy is a row in the `deploys` history (`begin`, `finish`;
// `amend` once an Agent's `deployResult` tells otherwise after its hello closed the row ok), its log cut to its last
// 40 lines, audited as `deploy` and announced as `deployStarted`/`deployFinished` target notices (`target` `deploy`).
// Its hub and dashboard deploys' `target` is config's `environment`, a Mod's its server, an Agent's its id. A hub or
// dashboard deploy's unit (`<template>@<tag>.service`) is polled every 5 s until it is no longer activating and the
// row closed from `<root>/deploy-status.json` (only that tag's, finished after the row started; else `failed`,
// interrupted) — also by the next hub at start, as the hub's own deploy restarts it (`watch`). `DeployCtx` is what the deploy flows outside
// the class share with `Deploys`. Hub core.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeployOutcome, DeployPart, DeployRow } from '../types.ts';
import type { DeploysDeps } from './deploys.ts';

export const LOG_LINES = 40;
export const HISTORY = 50;
/** A oneshot deploy unit is `activating` while its script runs; inactive or failed once it is over. */
const RUNNING_STATES = new Set(['activating', 'active', 'reloading', 'deactivating']);

/** What the deploy flows need of `Deploys`: its deps, its options, its timers, listeners and Agent deploys (by reference) and the start lock. */
export type DeployCtx = {
  d: DeploysDeps;
  watchMs: number;
  modTimeoutMs: number;
  agentTimeoutMs: number;
  countdownMinutes: number;
  starting: boolean; // between the checks and the row, so two requests can't both pass
  // The class's own, by reference: see `Deploys`.
  timers: Set<NodeJS.Timeout>;
  listeners: Set<() => void>;
  agentDeploys: Map<string, string>;
};

export function unit(c: DeployCtx, row: DeployRow): string {
  const { hubTemplate, webTemplate } = c.d.config.deploys;
  return `${row.part === 'hub' ? hubTemplate : webTemplate}@${row.to}.service`;
}

export function begin(c: DeployCtx, part: DeployPart, target: string, from: string | null, to: string, by: string): DeployRow {
  const started = Date.now();
  const id = c.d.db.startDeploy({ part, target, from, to, by }, started);
  c.d.hub.audit(by, 'deploy', target, `${part} ${from ?? 'unknown'} → ${to}`);
  c.d.hub.publishTarget({ target: 'deploy', id: target, type: 'notice', severity: 'info', kind: 'deployStarted', part, from, to, by });
  return { id, part, target, from, to, by, started, finished: null, outcome: 'running', log: '' };
}

export function finish(c: DeployCtx, row: DeployRow, outcome: Exclude<DeployOutcome, 'running'>, log: string): void {
  c.d.db.finishDeploy(row.id, outcome, log.split('\n').slice(-LOG_LINES).join('\n'));
  const { part, from, to, target } = row;
  const severity = outcome === 'ok' ? 'good' : 'problem';
  c.d.hub.publishTarget({ target: 'deploy', id: target, type: 'notice', severity, kind: 'deployFinished', part, from, to, outcome });
}

/** An Agent's deploy closed ok on its hello, which its `deployResult` then tells otherwise (or ok, with its log). */
export function amend(c: DeployCtx, row: DeployRow, outcome: Exclude<DeployOutcome, 'running'>, log: string): void {
  c.d.db.amendDeploy(row.id, outcome, log.split('\n').slice(-LOG_LINES).join('\n'));
  if (outcome === 'ok') return; // as announced
  const { part, from, to, target } = row;
  c.d.hub.publishTarget({ target: 'deploy', id: target, type: 'notice', severity: 'problem', kind: 'deployFinished', part, from, to, outcome });
}

export function later(c: DeployCtx, fn: () => void, ms: number): NodeJS.Timeout {
  const t = setTimeout(() => {
    c.timers.delete(t);
    fn();
  }, ms);
  c.timers.add(t);
  return t;
}

/** Waits for a hub or dashboard deploy unit to end, then closes its row from the status file it wrote. */
export function watch(c: DeployCtx, row: DeployRow, delayMs = 0): void {
  const poll = async () => {
    try {
      const out = await c.d.run('systemctl', ['show', '--property=ActiveState', '--', unit(c, row)]);
      if (RUNNING_STATES.has(/^ActiveState=(.*)$/m.exec(out)?.[1] ?? '')) return void later(c, () => void poll(), c.watchMs);
    } catch (err) {
      console.error(`[deploys] reading ${unit(c, row)} failed:`, (err as Error).message);
      return void later(c, () => void poll(), c.watchMs);
    }
    const status = readStatus(c);
    // A file from an earlier deploy of the same tag (one rolled back, then tried again) isn't this one's.
    if (status && status.tag === row.to && Date.parse(status.finished) + 1000 > row.started) {
      finish(c, row, status.outcome, status.log);
    } else finish(c, row, 'failed', 'interrupted: the deploy unit ended without reporting');
  };
  if (delayMs) later(c, () => void poll(), delayMs);
  else void poll();
}

function readStatus(c: DeployCtx): { tag: string; outcome: Exclude<DeployOutcome, 'running'>; finished: string; log: string } | undefined {
  try {
    const s = JSON.parse(readFileSync(join(c.d.config.deploys.root, 'deploy-status.json'), 'utf8'));
    const ok = ['ok', 'failed', 'rolled back'].includes(s.outcome) && typeof s.tag === 'string' && typeof s.finished === 'string';
    return ok ? { ...s, log: typeof s.log === 'string' ? s.log : '' } : undefined;
  } catch {
    return undefined;
  }
}

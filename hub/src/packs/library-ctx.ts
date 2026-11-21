// What the library flows outside the class share with `Library` (`LibraryCtx`): its deps, the library folder, the
// running add, the next add number and whether the hub is closing (all read and written here, so `stop()` reaches a
// running add); and what every add uses: `cancelled`, `progress` (refused once the hub is closing), `finish` (removes
// what it wrote, frees the one add slot, audits its end: `library add` or `library runtime add`, target `library`)
// and `publish`, the `libraryAdd` target events (`target` `library`, `id` `packs` or `runtimes`: progress, then
// finished ok/cancelled/failed with a reason; not posted to Discord). `LibraryRefused` (400/404/409). Hub core.

import { rm } from 'node:fs/promises';
import type { RunningLibraryAdd } from '../api.ts';
import type { LibraryAdd, TargetEvent } from '../types.ts';
import type { LibraryDeps } from './library.ts';

/** Why a library action wasn't done: 400 (bad input), 404 (no such entry) or 409 (not now). */
export class LibraryRefused extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** How often a download's byte count goes on the stream. */
export const TICK_MS = 1_000;

export type Add = RunningLibraryAdd & { actor: string; source: string; abort: AbortController; cancelled: boolean; storing: boolean };

/** What the library flows need of `Library`: see the header. */
export type LibraryCtx = {
  d: LibraryDeps;
  /** `<root>/library`. */
  dir: string;
  add: Add | undefined;
  next: number;
  closed: boolean;
};

export function cancelled(add: Add): void {
  if (add.cancelled) throw new Error('Cancelled.');
}

export function progress(c: LibraryCtx, add: Add, detail: string): void {
  if (c.closed) throw new Error('The hub is closing.');
  add.detail = detail;
  publish(c, add, { phase: 'progress', detail });
}

export async function finish(c: LibraryCtx, add: Add, outcome: 'ok' | 'cancelled' | 'failed', reason: string, temp: string): Promise<void> {
  await rm(temp, { recursive: true, force: true }).catch(() => {});
  c.add = undefined;
  if (c.closed) return;
  c.d.hub.audit(add.actor, add.kind === 'pack' ? 'library add' : 'library runtime add', 'library', `${add.name} ${add.version}: ${outcome}${reason ? `: ${reason}` : ''}`);
  publish(c, add, { phase: 'finished', outcome, reason });
}

function publish(c: LibraryCtx, add: Add, e: Pick<Extract<LibraryAdd, { phase: 'progress' }>, 'phase' | 'detail'> | Pick<Extract<LibraryAdd, { phase: 'finished' }>, 'phase' | 'outcome' | 'reason'>): void {
  c.d.hub.publishTarget({ target: 'library', id: add.kind === 'pack' ? 'packs' : 'runtimes', type: 'libraryAdd', add: add.add, name: add.name, version: add.version, by: add.by, ...e } as TargetEvent);
}

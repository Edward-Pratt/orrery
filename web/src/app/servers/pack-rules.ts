/**
 * The Pack tab's shared rules, pure: which sheet is open, a Java runtime's label, the update dialog's description, and
 * a running update with a `packUpdateStep` notice applied. The tab itself is `pack.ts`.
 */
import type { ConfigEdit, Extra, LibraryState, Notice, RunningPackUpdate } from '@hub/api';

export type Sheet = { kind: 'update' } | { kind: 'extra'; extra?: Extra; replace?: boolean } | { kind: 'edit'; edit?: ConfigEdit };

/** A runtime's label from the library, its name when the library doesn't list it, or the host's own java. */
export const runtimeLabel = (library: LibraryState | null, name: string | null) => (name ? (library?.runtimes.find((r) => r.name === name)?.label ?? name) : 'System java');

/** What an update or apply does, for its dialog: the countdown only while players are online. */
export function confirmText(players: number): string {
  return `Backs up, then stops the server${players ? ` (a 5-minute countdown: ${players} player${players === 1 ? '' : 's'} online)` : ''}, swaps the files, and rolls back if the Mod doesn't say hello within 10 minutes.`;
}

/** The running update with a step's notice applied: that step replaced in place, or added at the end. */
export function withStep(r: RunningPackUpdate, e: Extract<Notice, { kind: 'packUpdateStep' }>): RunningPackUpdate {
  const steps = r.steps.some((s) => s.step === e.step) ? r.steps.map((s) => (s.step === e.step ? { step: e.step, state: e.state, detail: e.detail } : s)) : [...r.steps, { step: e.step, state: e.state, detail: e.detail }];
  return { ...r, steps, cancellable: e.cancellable };
}

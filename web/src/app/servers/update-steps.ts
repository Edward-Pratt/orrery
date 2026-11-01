import { DatePipe } from '@angular/common';
import { Component, input, output } from '@angular/core';
import type { PackFinished, PackStep, PackStepState, PackUpdateRow } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideLoaderCircle, lucideX } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { formatDuration } from '../units';

/** What a pack update calls its steps; a game update's Backup is its Save. */
export const PACK_STEPS: Record<PackStep, string> = { prepare: 'Prepare', backup: 'Backup', stop: 'Stop', swap: 'Swap', gate: 'Health gate', rollback: 'Rollback' };
const RESULT: Record<PackFinished | 'running', string> = {
  running: 'text-muted-foreground',
  ok: 'text-status-ok',
  'rolled back': 'text-status-down',
  failed: 'text-status-down',
  'failed before swap': 'text-status-down',
  'failed in staging': 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
};

/** The latest update, when it failed while preparing: where to, and its cause (the log's last line that isn't a step's), for the red box. */
export function failedPrep(history: PackUpdateRow[]): { to: string; why: string } | null {
  const last = history[0];
  return last?.outcome === 'failed in staging' ? { to: last.to, why: last.log.split('\n').filter((l) => !/^\w+: (done|failed)/.test(l)).at(-1) ?? '' } : null;
}

/**
 * The update running now, a pack's or a game's: every step in order with its live detail, and Cancel while the hub
 * says it can be (`cancellable`, whichever step that is).
 */
@Component({
  selector: 'app-update-steps',
  imports: [DatePipe, NgIcon, HlmButton],
  viewProviders: [provideIcons({ lucideCheck, lucideLoaderCircle, lucideX })],
  template: `
    @let r = update();
    <section class="rounded-xl border bg-card p-5" data-updating>
      <h2 class="font-semibold">{{ title() }}</h2>
      <p class="mb-4 text-sm text-muted-foreground">Started by {{ r.by }} at {{ r.started | date: 'HH:mm' }}. You can leave this page.</p>
      <ol class="flex flex-col gap-3">
        @for (s of r.steps; track s.step; let i = $index) {
          <li class="flex gap-3" [attr.data-step]="s.step" [attr.data-state]="s.state">
            <span
              class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs"
              [class]="s.state === 'done' ? 'bg-status-ok text-white' : s.state === 'failed' ? 'bg-status-down text-white' : s.state === 'running' ? 'text-brand' : 'border text-muted-foreground'"
            >
              @switch (s.state) {
                @case ('done') {
                  <ng-icon name="lucideCheck" />
                }
                @case ('failed') {
                  <ng-icon name="lucideX" />
                }
                @case ('running') {
                  <ng-icon name="lucideLoaderCircle" class="animate-spin" />
                }
                @default {
                  {{ i + 1 }}
                }
              }
            </span>
            <div class="min-w-0 flex-1 text-sm" [class.text-muted-foreground]="s.state === 'waiting'">
              <p class="font-medium">{{ labels()[s.step] }}</p>
              @if (s.detail) {
                <p class="text-muted-foreground" data-detail>{{ s.detail }}</p>
              }
            </div>
          </li>
        }
      </ol>
      @if (r.cancellable) {
        <button hlmBtn size="sm" variant="outline" class="mt-4" [disabled]="busy()" (click)="cancel.emit()" data-cancel>Cancel update</button>
      }
    </section>
  `,
})
export class UpdateSteps {
  readonly title = input.required<string>();
  readonly update = input.required<{ by: string; started: number; steps: PackStepState[]; cancellable: boolean }>();
  readonly labels = input(PACK_STEPS);
  /** A request of the page is in flight: Cancel waits. */
  readonly busy = input(false);
  readonly cancel = output();
}

/** The updates a server had, newest first: when, from and to with the changes, the result with how long it took, and who (hidden on a phone). */
@Component({
  selector: 'app-update-history',
  imports: [DatePipe],
  template: `
    <section data-history>
      <h2 class="mb-2 text-base font-semibold">History</h2>
      @if (rows().length) {
        <table class="w-full text-left text-sm">
          <thead class="text-muted-foreground">
            <tr>
              <th class="py-1 pr-4 font-normal">When</th>
              <th class="pr-4 font-normal">Version</th>
              <th class="pr-4 font-normal">Result</th>
              <th class="hidden pr-4 font-normal sm:table-cell" data-by-column>By</th>
            </tr>
          </thead>
          <tbody>
            @for (h of rows(); track h.id) {
              <tr class="border-t align-top" [attr.data-update-row]="h.id">
                <td class="py-1.5 pr-4 whitespace-nowrap">{{ h.started | date: 'd MMM, HH:mm' }}</td>
                <td class="pr-4">
                  {{ h.from === h.to ? h.to : h.from + ' → ' + h.to }}
                  @if (h.changes?.length) {
                    <span class="block text-xs text-muted-foreground">{{ changesPrefix() }}{{ h.changes!.join(', ') }}</span>
                  }
                </td>
                <td class="pr-4" [class]="result[h.outcome]">
                  {{ h.outcome }}
                  @if (h.finished) {
                    <span class="text-xs text-muted-foreground">{{ took(h.finished - h.started) }}</span>
                  }
                </td>
                <td class="hidden pr-4 sm:table-cell">{{ h.by }}</td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <p class="text-sm text-muted-foreground" data-no-history>{{ empty() }}</p>
      }
    </section>
  `,
})
export class UpdateHistory {
  readonly rows = input.required<PackUpdateRow[]>();
  /** Said when there are none. */
  readonly empty = input.required<string>();
  /** Before a row's changes ("changes applied: " for a pack's apply onto the same version). */
  readonly changesPrefix = input('');
  protected readonly result = RESULT;
  protected took = (ms: number) => formatDuration(ms);
}

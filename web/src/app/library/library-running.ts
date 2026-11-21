import { Component, input, output } from '@angular/core';
import type { LibraryAdd, RunningLibraryAdd } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arCircleAlert } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';

/**
 * The Library page's running add's card (either kind) with its progress and Cancel, and how the last add watched
 * here ended: a failure, or the hub's note on one that was already there. Hidden while there is neither.
 */
@Component({
  selector: 'app-library-running',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButton, HlmSpinner],
  viewProviders: [provideIcons({ arCircleAlert })],
  template: `
    <div class="mb-4 flex max-w-4xl flex-col gap-4 empty:hidden">
      @if (running(); as r) {
        <div class="ar-panel flex flex-wrap items-center gap-3 p-4 text-sm" data-running>
          <hlm-spinner />
          <span class="min-w-0 flex-1">
            Adding <b>{{ r.name }} {{ r.version }}</b><span class="text-muted-foreground"> (by {{ r.by }})</span>
            <span class="block text-xs text-muted-foreground" data-detail>{{ r.detail }}</span>
          </span>
          <button hlmBtn variant="outline" size="sm" [disabled]="busy()" (click)="cancel.emit()" data-cancel>Cancel</button>
        </div>
      }
      @if (ended(); as e) {
        <div
          class="ar-callout items-center gap-3 text-sm"
          [class]="e.outcome === 'failed' ? 'ar-callout--danger' : ''"
          [attr.data-ended]="e.outcome"
        >
          @if (e.outcome === 'failed') {
            <ng-icon name="arCircleAlert" class="text-status-down" />
            <span>Adding {{ e.name }} {{ e.version }} failed: {{ e.reason }}</span>
          } @else {
            <span>{{ e.reason }}</span>
          }
        </div>
      }
    </div>
  `,
})
export class LibraryRunning {
  readonly running = input.required<RunningLibraryAdd | null>();
  readonly ended = input.required<Extract<LibraryAdd, { phase: 'finished' }> | null>();
  readonly busy = input.required<boolean>();
  readonly cancel = output();
}

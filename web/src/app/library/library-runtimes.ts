import { DatePipe } from '@angular/common';
import { Component, input, output } from '@angular/core';
import type { LibraryRuntime, LibraryState, RunningLibraryAdd } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arCoffee, arPlus } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';
import { formatBytes } from '../units';

/**
 * The Library page's Java runtimes: each with its Java version, size and the servers set to it, Add runtime (none
 * while an add runs) and each one's Delete, which the page asks about; an empty state.
 */
@Component({
  selector: 'app-library-runtimes',
  host: { class: 'contents' },
  imports: [DatePipe, NgIcon, HlmButton],
  viewProviders: [provideIcons({ arCoffee, arPlus })],
  template: `
    @let s = state();
    <section class="mt-8 flex max-w-4xl flex-col gap-4" data-runtimes>
      <div class="flex items-center gap-3">
        <div>
          <h2 class="ar-t-heading-sm">Java runtimes</h2>
          <p class="text-sm text-muted-foreground">Temurin JDKs from Adoptium. Each server runs on the one set on its Pack tab, or on the host's own java.</p>
        </div>
        <button hlmBtn size="sm" class="ml-auto shrink-0" [disabled]="!!running()" (click)="add.emit()" data-add-runtime>
          <ng-icon name="arPlus" /> Add runtime
        </button>
      </div>
      @if (s.runtimes.length) {
        <ul class="ar-panel divide-y">
          @for (r of s.runtimes; track r.name) {
            <li class="flex flex-wrap items-start gap-x-4 gap-y-1 p-3 text-sm" [attr.data-runtime]="r.name">
              <div class="min-w-0 flex-1">
                <p class="font-medium" data-name>{{ r.label }}</p>
                <p class="text-xs text-muted-foreground" data-meta>Java {{ r.feature }} · {{ bytes(r.size) }} · added by {{ r.by }} {{ r.at | date: 'd MMM y HH:mm' }}</p>
                <p class="truncate font-mono text-xs text-muted-foreground" [title]="r.sha256">sha256 {{ r.sha256 }}</p>
              </div>
              <span class="text-xs text-muted-foreground" data-used>{{ r.usedBy.length ? 'set on ' + r.usedBy.join(', ') : 'set on no server' }}</span>
              <button hlmBtn variant="ghost" size="sm" [disabled]="busy()" (click)="remove.emit(r)" data-delete>Delete</button>
            </li>
          }
        </ul>
      } @else {
        <div class="ar-empty text-sm text-muted-foreground" data-runtimes-empty>
          <ng-icon name="arCoffee" class="text-2xl" />
          <p>No runtimes yet: every server runs on the host's own java.</p>
        </div>
      }
    </section>
  `,
})
export class LibraryRuntimes {
  protected readonly bytes = formatBytes;

  readonly state = input.required<LibraryState>();
  readonly running = input.required<RunningLibraryAdd | null>();
  readonly busy = input.required<boolean>();
  readonly add = output();
  readonly remove = output<LibraryRuntime>();
}

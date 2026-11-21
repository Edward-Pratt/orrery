import { DatePipe } from '@angular/common';
import { Component, input, output } from '@angular/core';
import type { LibraryPack, LibraryState, RunningLibraryAdd } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arPackage, arPlus } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { formatBytes } from '../units';

/**
 * The Library page's Packs: the Environment's pack versions, newest first, with Add pack (none while an add runs) and
 * each one's Delete, which the page asks about; an empty state, why the hub didn't answer, or a skeleton until it does.
 */
@Component({
  selector: 'app-library-packs',
  host: { class: 'contents' },
  imports: [DatePipe, NgIcon, HlmButton, HlmSkeleton],
  viewProviders: [provideIcons({ arPackage, arPlus })],
  template: `
    <section class="flex max-w-4xl flex-col gap-4" data-packs>
      <div class="flex items-center gap-3">
        <h2 class="ar-t-heading-sm">Packs</h2>
        <button hlmBtn size="sm" class="ml-auto" [disabled]="!!running()" (click)="add.emit()" data-add>
          <ng-icon name="arPlus" /> Add pack
        </button>
      </div>
      @if (state(); as s) {
        @if (s.packs.length) {
          <ul class="ar-panel divide-y">
            @for (p of s.packs; track p.id) {
              <li class="flex flex-wrap items-start gap-x-4 gap-y-1 p-3 text-sm" [attr.data-pack]="p.id">
                <div class="min-w-0 flex-1">
                  <p class="font-medium" data-name>{{ p.name }} {{ p.version }}</p>
                  <p class="text-xs text-muted-foreground" data-meta>
                    Minecraft {{ p.mc }} · {{ p.loader }} · {{ bytes(p.size) }} · added by {{ p.by }} {{ p.at | date: 'd MMM y HH:mm' }}
                  </p>
                  <p class="truncate text-xs text-muted-foreground" [title]="p.source" data-source>{{ p.source }}</p>
                  <p class="truncate font-mono text-xs text-muted-foreground" [title]="p.sha256" data-sha>sha256 {{ p.sha256 }}</p>
                </div>
                <span class="text-xs text-muted-foreground" data-used>{{ p.usedBy.length ? 'used by ' + p.usedBy.join(', ') : 'used by no server' }}</span>
                <button hlmBtn variant="ghost" size="sm" [disabled]="busy()" (click)="remove.emit(p)" data-delete>Delete</button>
              </li>
            }
          </ul>
        } @else {
          <div class="ar-empty" data-empty>
            <ng-icon name="arPackage" class="text-2xl text-muted-foreground" />
            <p class="mt-2 font-medium">No packs yet</p>
            <p class="text-sm text-muted-foreground">Add a pack version from a link or an upload: servers install and update from here.</p>
          </div>
        }
      } @else if (missing(); as why) {
        <p class="text-muted-foreground">{{ why }}</p>
      } @else {
        <hlm-skeleton class="ar-skeleton--block h-24" data-skeleton />
      }
    </section>
  `,
})
export class LibraryPacks {
  protected readonly bytes = formatBytes;

  readonly state = input.required<LibraryState | null>();
  readonly missing = input.required<string | null>();
  readonly running = input.required<RunningLibraryAdd | null>();
  readonly busy = input.required<boolean>();
  readonly add = output();
  readonly remove = output<LibraryPack>();
}

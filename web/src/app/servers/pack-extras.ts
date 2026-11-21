import { DatePipe } from '@angular/common';
import { Component, input, output } from '@angular/core';
import type { Extra, PackState } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arLock, arMore, arPlus } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import type { Sheet } from './pack-rules';

/**
 * The Pack tab's Extras: files put on top of the pack on every update, each with its pills and a ⋯ menu (Replace file,
 * Edit label and note, Remove; none on a removed one, struck through), and the orrery Mod as a locked last row. Add
 * and the menu's items only say what to open or remove: the page holds the sheets and the requests.
 */
@Component({
  selector: 'app-pack-extras',
  host: { class: 'contents' },
  imports: [DatePipe, NgIcon, HlmButton, HlmDropdownMenuImports],
  viewProviders: [provideIcons({ arLock, arMore, arPlus })],
  template: `
    @let p = state();
    <section data-extras>
      <div class="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 class="ar-t-heading-sm">Extras</h2>
          <p class="text-sm text-muted-foreground">Files put on top of the pack on every update: new ones, or replacing the pack's.</p>
        </div>
        <button hlmBtn size="sm" variant="outline" (click)="open.emit({ kind: 'extra' })" data-add-extra><ng-icon name="arPlus" /> Add extra</button>
      </div>
      <ul class="ar-panel divide-y">
        @for (e of p.extras; track e.id) {
          <li class="flex items-start gap-3 px-3 py-2.5 text-sm" [class.opacity-60]="e.removed" [attr.data-extra]="e.target">
            <div class="min-w-0 flex-1">
              <p class="truncate font-mono text-xs" [class.line-through]="e.removed">{{ e.target }}</p>
              <p class="text-xs text-muted-foreground">
                <span class="ar-tag mr-1" data-where>{{ e.replaces ? "replaces the pack's file" : 'new path' }}</span>
                @if (e.label) {
                  {{ e.label }} ·
                }
                {{ e.by }}, {{ e.at | date: 'd MMM y' }}
                @if (e.note) {
                  · <i>{{ e.note }}</i>
                }
              </p>
            </div>
            @if (e.change) {
              <span class="ar-tag ar-tag--warn" data-change>{{ e.change }}</span>
            }
            @if (!e.removed) {
              <button hlmBtn variant="ghost" size="icon-sm" aria-label="More actions" [hlmDropdownMenuTrigger]="menu" data-more><ng-icon name="arMore" /></button>
              <ng-template #menu>
                <div hlmDropdownMenu class="w-48">
                  <button hlmDropdownMenuItem (click)="open.emit({ kind: 'extra', extra: e, replace: true })" data-replace>Replace file…</button>
                  <button hlmDropdownMenuItem (click)="open.emit({ kind: 'extra', extra: e })" data-relabel>Edit label and note…</button>
                  <button hlmDropdownMenuItem (click)="remove.emit(e)" data-remove>Remove</button>
                </div>
              </ng-template>
            }
          </li>
        }
        <li class="flex items-center gap-3 bg-muted px-3 py-2.5 text-sm" data-mod-row>
          <ng-icon name="arLock" class="text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-xs">{{ p.mod ?? 'mods/orrery-*.jar' }}</p>
            <p class="text-xs text-muted-foreground">The orrery Mod: put back on every update. Deployed from Host.</p>
          </div>
        </li>
      </ul>
    </section>
  `,
})
export class PackExtras {
  readonly state = input.required<PackState>();
  readonly open = output<Sheet>();
  readonly remove = output<Extra>();
}

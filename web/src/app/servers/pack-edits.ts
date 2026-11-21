import { Component, input, output } from '@angular/core';
import type { ConfigEdit, PackState } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arCircleAlert, arMore, arPlus } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import type { Sheet } from './pack-rules';

/**
 * The Pack tab's Config edits: find-and-replace in the pack's files, each with a ⋯ menu (Edit, Remove) and a red line
 * when it matched nothing in the last update tried. Add and the menu's items only say what to open or remove: the page
 * holds the sheets and the requests.
 */
@Component({
  selector: 'app-pack-edits',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButton, HlmDropdownMenuImports],
  viewProviders: [provideIcons({ arCircleAlert, arMore, arPlus })],
  template: `
    @let p = state();
    <section data-edits>
      <div class="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 class="ar-t-heading-sm">Config edits</h2>
          <p class="text-sm text-muted-foreground">Find-and-replace in the pack's files, applied last. One that matches nothing stops the update before the server is touched.</p>
        </div>
        <button hlmBtn size="sm" variant="outline" (click)="open.emit({ kind: 'edit' })" data-add-edit><ng-icon name="arPlus" /> Add edit</button>
      </div>
      <ul class="ar-panel divide-y">
        @for (c of p.edits; track c.id) {
          <li class="flex items-start gap-3 px-3 py-2.5 text-sm" [attr.data-edit]="c.id">
            <div class="min-w-0 flex-1">
              <p class="font-mono text-xs">
                {{ c.path }}
                @if (c.note) {
                  <span class="font-sans text-muted-foreground">· {{ c.note }}</span>
                }
              </p>
              <p class="mt-1 font-mono text-xs break-all">
                <span class="rounded bg-muted px-1">{{ c.find }}</span> → <span class="rounded bg-muted px-1">{{ c.replace }}</span>
              </p>
              @if (c.failedOn) {
                <p class="mt-1 flex items-center gap-1 text-xs text-destructive" data-unmatched>
                  <ng-icon name="arCircleAlert" /> Matched nothing in {{ c.failedOn }} (the last update tried).
                </p>
              }
            </div>
            <button hlmBtn variant="ghost" size="icon-sm" aria-label="More actions" [hlmDropdownMenuTrigger]="emenu" data-more><ng-icon name="arMore" /></button>
            <ng-template #emenu>
              <div hlmDropdownMenu class="w-44">
                <button hlmDropdownMenuItem (click)="open.emit({ kind: 'edit', edit: c })" data-change-edit>Edit…</button>
                <button hlmDropdownMenuItem (click)="remove.emit(c)" data-remove>Remove</button>
              </div>
            </ng-template>
          </li>
        } @empty {
          <li class="px-3 py-2.5 text-sm text-muted-foreground">None yet.</li>
        }
      </ul>
    </section>
  `,
})
export class PackEdits {
  readonly state = input.required<PackState>();
  readonly open = output<Sheet>();
  readonly remove = output<ConfigEdit>();
}

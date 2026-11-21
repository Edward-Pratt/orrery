import { Component, input, output } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';

/** Where the update sheet's catalog answer stands, for the footer: how many changes, or why there's no count. */
export type BrowseStatus = { checking: boolean; changes: number | null; unresolved: number; error: boolean };

/**
 * The Browse view's sticky footer: the changes the update holds so far, from the sheet's catalog answer (a live
 * region), and Review the update, back to the update view. The view itself is `mod-browser.ts`.
 */
@Component({
  selector: 'app-mod-browser-footer',
  host: { class: 'contents' },
  imports: [HlmButton, HlmSpinner],
  template: `
    <div class="sticky bottom-0 mt-auto flex flex-wrap items-center justify-between gap-2 border-t bg-popover px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-browse-footer>
      <p class="flex min-w-0 items-center gap-2" aria-live="polite" data-browse-changes>
        @if (status().checking) {
          <hlm-spinner /> <span class="text-muted-foreground">Checking with the mod portal…</span>
        } @else if (status().error) {
          <span class="text-destructive">The catalog refused: review the update.</span>
        } @else if (status().unresolved) {
          <span class="text-destructive">{{ status().unresolved === 1 ? "A dependency can't be met" : status().unresolved + " dependencies can't be met" }}</span>
        } @else if (status().changes !== null) {
          <span>{{ status().changes === 1 ? '1 change' : status().changes + ' changes' }}</span>
        }
      </p>
      <button hlmBtn (click)="back.emit()" data-browse-review>Review the update</button>
    </div>
  `,
})
export class ModBrowserFooter {
  readonly status = input.required<BrowseStatus>();
  /** Back to the update view. */
  readonly back = output<void>();
}

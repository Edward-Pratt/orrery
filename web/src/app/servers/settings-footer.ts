import { Component, input, output } from '@angular/core';
import type { GameSettingsState } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';

/**
 * The Settings tab's sticky footer: what a save would apply now and what at the next restart (or when the server
 * starts, while stopped), which `extra` keys a save drops, and Save (disabled until a valid change, and with the hub's
 * `blocked`) with why it can't go. The page holds the form and the save; this shows them and says what was clicked.
 */
@Component({
  selector: 'app-settings-footer',
  host: { class: 'contents' },
  imports: [HlmButton, HlmSpinner],
  template: `
    @let s = state();
    <footer class="sticky bottom-0 -mx-4 flex max-w-3xl flex-col gap-2 border-t bg-[var(--glass)] px-4 py-3 text-sm backdrop-blur-[var(--blur-glass)] md:mx-0 md:px-0" data-footer>
      @if (dirty()) {
        <p data-applies>{{ applies() }}</p>
      }
      @if (s.extra.length) {
        <p class="text-xs text-muted-foreground" data-extra>Saving rewrites server-settings.json without: {{ s.extra.join(', ') }}.</p>
      }
      <div class="flex flex-wrap items-center gap-3">
        <button hlmBtn [disabled]="!canSave()" (click)="save.emit()" data-save>
          @if (saving()) {
            <hlm-spinner />
          }
          Save
        </button>
        @if (s.blocked && !readOnly()) {
          <span class="text-muted-foreground" data-blocked>{{ s.blocked }}</span>
        } @else if (dirty() && !valid()) {
          <span class="text-destructive" data-invalid>Fix the fields marked above first.</span>
        }
      </div>
    </footer>
  `,
})
export class SettingsFooter {
  readonly state = input.required<GameSettingsState>();
  readonly dirty = input.required<boolean>();
  readonly applies = input.required<string>();
  readonly canSave = input.required<boolean>();
  readonly saving = input.required<boolean>();
  readonly readOnly = input.required<boolean>();
  readonly valid = input.required<boolean>();
  readonly save = output();
}

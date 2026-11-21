import { Component, input, output } from '@angular/core';
import type { GameSettingsState } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { labels } from './settings-rules';

/**
 * The Settings tab's banners above the cards: a rollback (`rolledBack`), an Agent too old (its deploy text) or one
 * that leaves the fields read-only, keys waiting for a restart with Restart… (online only), a stopped server, and a
 * file that can't be read. The page holds the state and the restart; this shows them and says what was clicked.
 */
@Component({
  selector: 'app-settings-banners',
  host: { class: 'contents' },
  imports: [HlmButton, HlmSpinner],
  template: `
    @let s = state();
    @if (s.rolledBack; as r) {
      <div class="ar-callout ar-callout--danger block" role="alert" data-rolled-back>
        <b class="text-destructive">The server didn't start with the settings saved last,</b> so the Agent put back the ones it last started with: {{ r }}
      </div>
    }
    @if (old()) {
      <p class="ar-panel px-3 py-2" data-old-agent>{{ s.blocked }}</p>
    } @else if (readOnly()) {
      <p class="ar-panel px-3 py-2 text-muted-foreground" data-read-only>{{ s.blocked }}@if (!unreported()) { The fields show its last report.}</p>
    }
    @if (s.pending.length) {
      <div class="ar-callout ar-callout--warn flex flex-wrap items-center justify-between gap-2" data-pending>
        <span>Waiting for a restart: {{ labels(s.pending) }}.</span>
        @if (online()) {
          <button hlmBtn variant="outline" size="sm" [disabled]="restarting()" (click)="restart.emit()" data-restart>
            @if (restarting()) {
              <hlm-spinner />
            }
            Restart…
          </button>
        }
      </div>
    }
    @if (stopped()) {
      <p class="ar-callout block text-muted-foreground" data-stopped>The server is stopped: changes are written now and apply when it starts.</p>
    }
    @if (s.problem; as p) {
      <p class="ar-callout ar-callout--warn block" data-problem>server-settings.json can't be read ({{ p }}). Saving writes a new one from these fields.</p>
    }
  `,
})
export class SettingsBanners {
  readonly state = input.required<GameSettingsState>();
  readonly old = input.required<boolean>();
  readonly readOnly = input.required<boolean>();
  readonly unreported = input.required<boolean>();
  readonly online = input.required<boolean>();
  readonly restarting = input.required<boolean>();
  readonly stopped = input.required<boolean>();
  readonly restart = output();
  protected readonly labels = labels;
}

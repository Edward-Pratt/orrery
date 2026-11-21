import { DatePipe } from '@angular/common';
import { Component, input, output } from '@angular/core';
import type { InstalledPack, LibraryState, PackState } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arCheck } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';
import { runtimeLabel, type Sheet } from './pack-rules';

/**
 * The Pack tab's summary card, once a pack is installed: the installed pack with its one primary action (Update pack,
 * or Apply N changes beside it while changes are pending; both disabled with the hub's `blocked` or offline), the
 * amber pending box, the Java runtime row (a `<select>` of System java and the library's runtimes with "pending
 * restart", or the two unit lines to add when the unit doesn't name the link), the red box for a failure while
 * preparing, and the "Done" line after an update watched here. The page holds the state and the requests.
 */
@Component({
  selector: 'app-pack-summary',
  host: { class: 'contents' },
  imports: [DatePipe, NgIcon, HlmButton],
  viewProviders: [provideIcons({ arCheck })],
  template: `
    @let p = state();
    <section class="ar-panel p-5" data-summary>
      @if (done(); as d) {
        <p class="mb-3 flex items-center gap-1 text-sm font-medium text-status-ok" data-done><ng-icon name="arCheck" /> Done: {{ d }} is running.</p>
      }
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <p class="text-xs font-medium text-muted-foreground">Installed pack</p>
          <h2 class="ar-t-heading-md" data-installed>{{ installed().name }} {{ installed().version }}</h2>
          <p class="text-sm break-all text-muted-foreground" data-installed-by>
            {{ installed().how }} by {{ installed().by }}, {{ installed().at | date: 'd MMM y' }} ·
            @if (isUrl(installed().source)) {
              <a class="underline" [href]="installed().source" target="_blank" rel="noopener">source</a>
            } @else {
              {{ installed().source }}
            }
            · sha256 <span class="font-mono text-xs" [title]="installed().sha256">{{ installed().sha256.slice(0, 12) }}…</span>
          </p>
        </div>
        <div class="flex flex-col items-start gap-1">
          <div class="flex gap-2">
            <button hlmBtn [variant]="p.pending.length ? 'outline' : 'default'" [disabled]="!!blocked() || busy()" (click)="open.emit({ kind: 'update' })" data-update>
              Update pack
            </button>
            @if (p.pending.length) {
              <button hlmBtn [disabled]="!!blocked() || busy()" (click)="apply.emit()" data-apply>Apply {{ p.pending.length }} change{{ p.pending.length === 1 ? '' : 's' }}</button>
            }
          </div>
          @if (blocked(); as why) {
            <p class="text-xs text-muted-foreground" data-update-why>{{ why }}</p>
          }
        </div>
      </div>
      @if (p.pending.length) {
        <div class="ar-callout ar-callout--warn mt-4 block text-sm" data-pending>
          <b class="text-status-warn">{{ p.pending.length }} change{{ p.pending.length === 1 ? '' : 's' }} pending</b>, not on the server until applied (a
          restart, with a backup first):
          <ul class="mt-1 list-inside list-disc text-muted-foreground">
            @for (c of p.pending; track c.kind + c.path) {
              <li>
                <span class="font-mono text-xs">{{ c.path }}</span> {{ c.kind === 'edit' ? 'edits ' : '' }}{{ c.change }}
              </li>
            }
          </ul>
        </div>
      }
      <div class="mt-4 border-t pt-3 text-sm" data-runtime-row>
        <p class="text-xs font-medium text-muted-foreground">Java runtime</p>
        @if (p.runtime.unitLines; as lines) {
          <p data-runtime-now>{{ runtimeLabel(p.runtime.name) }}</p>
          <p class="mt-1 text-xs text-muted-foreground">To pick a runtime here, add these two lines to the server's unit as root, then restart it:</p>
          <pre class="mt-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs" data-unit-lines>{{ lines.join('\n') }}</pre>
        } @else {
          <div class="flex flex-wrap items-center gap-2">
            <select
              class="ar-input w-auto"
              [disabled]="busy() || !library()"
              [value]="p.runtime.name ?? ''"
              (change)="runtime.emit($any($event.target).value || null)"
              aria-label="Java runtime"
              data-runtime-select
            >
              <option value="">System java</option>
              @for (r of library()?.runtimes ?? []; track r.name) {
                <option [value]="r.name">{{ r.label }}</option>
              }
            </select>
            @if (p.runtime.pending) {
              <span class="ar-tag ar-tag--warn" data-runtime-pending>pending restart</span>
            }
          </div>
        }
      </div>
      @if (failedPrep(); as f) {
        <div class="ar-callout ar-callout--danger mt-4 block text-sm" data-failed-prep>
          <b class="text-destructive">Update to {{ f.to }} failed while preparing.</b> The server wasn't touched. {{ f.why }}
        </div>
      }
    </section>
  `,
})
export class PackSummary {
  readonly state = input.required<PackState>();
  /** The state's installed pack, which the page shows this card for. */
  readonly installed = input.required<InstalledPack>();
  readonly done = input.required<string | null>();
  readonly blocked = input.required<string | null>();
  readonly busy = input.required<boolean>();
  readonly library = input.required<LibraryState | null>();
  readonly failedPrep = input.required<{ to: string; why: string } | null>();
  readonly open = output<Sheet>();
  readonly apply = output();
  readonly runtime = output<string | null>();

  protected isUrl = (s: string) => /^https:\/\//.test(s);
  protected runtimeLabel = (name: string | null) => runtimeLabel(this.library(), name);
}

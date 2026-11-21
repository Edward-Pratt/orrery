import { Component, input, output } from '@angular/core';
import type { CompareReport, LibraryPack, LibraryState } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arLock, arPackage } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { formatBytes } from '../units';
import { PackSource } from './pack-source';

/**
 * The Pack tab's empty state, Adopt: a version picked from the library, Compare, then the report with its keep boxes
 * (all unticked to start) and Adopt, which asks nothing. The page holds the report, the ticks and the requests; this
 * shows them and says what was clicked.
 */
@Component({
  selector: 'app-pack-adopt',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButton, HlmSpinner, PackSource],
  viewProviders: [provideIcons({ arLock, arPackage })],
  template: `
    @if (!report()) {
      <div class="ar-empty" data-adopt>
        <ng-icon name="arPackage" class="text-2xl text-muted-foreground" />
        <p class="mt-2 font-medium">orrery doesn't know this server's pack yet</p>
        <p class="mx-auto mb-4 max-w-md text-sm text-muted-foreground">
          Pick the pack version the server runs now from the library. It compares the two: nothing on the server changes.
        </p>
        <div class="mx-auto flex max-w-md flex-col gap-2 text-left text-sm">
          <app-pack-source [library]="library()" [pick]="pick()" (pickChange)="pickChange.emit($event)" />
          <button hlmBtn class="mt-2" [disabled]="busy() || !picked()" (click)="compare.emit()" data-compare>
            @if (busy()) {
              <hlm-spinner />
            }
            Compare with the server
          </button>
        </div>
      </div>
    } @else {
      <section data-report>
        <h2 class="ar-t-heading-sm">Adopt {{ report()!.name }} {{ report()!.version }}</h2>
        <p class="mb-4 text-sm text-muted-foreground" data-matching>
          {{ report()!.matching.toLocaleString('en') }} files match the pack. These don't. Ticked files are kept as Extras and put back on every
          update; unticked ones are left alone now and dropped by the next update.
        </p>
        <h3 class="ar-t-ui-strong mt-4 mb-1">Recognised</h3>
        <p class="mb-2 text-xs text-muted-foreground">The orrery Mod: put back on every update, never an Extra.</p>
        <ul class="ar-panel divide-y">
          @for (m of report()!.mod; track m) {
            <li class="flex items-center gap-3 px-3 py-2 text-sm" data-report-mod>
              <ng-icon name="arLock" class="text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ m }}</span>
              <span class="text-xs text-muted-foreground">the orrery Mod</span>
            </li>
          } @empty {
            <li class="px-3 py-2 text-sm text-muted-foreground">No Mod jar in mods/.</li>
          }
        </ul>
        @for (g of groups; track g.key) {
          <h3 class="ar-t-ui-strong mt-4 mb-1">{{ g.title }}</h3>
          <p class="mb-2 text-xs text-muted-foreground">{{ g.hint }}</p>
          <ul class="ar-panel divide-y" [attr.data-group]="g.key">
            @for (f of report()![g.key]; track f.path) {
              <li class="flex items-center gap-3 px-3 py-2 text-sm">
                <input type="checkbox" class="ar-check__box" [checked]="keep().has(f.path)" (change)="toggled.emit(f.path)" [attr.aria-label]="'Keep ' + f.path" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ f.path }}</span>
                <span class="text-xs text-muted-foreground">{{ bytes(f.size) }}</span>
              </li>
            } @empty {
              <li class="px-3 py-2 text-sm text-muted-foreground">None.</li>
            }
          </ul>
        }
        <div class="mt-4 flex items-center gap-3">
          <button hlmBtn [disabled]="busy()" (click)="adopt.emit()" data-adopt-keep>Adopt, keep {{ keep().size }} file{{ keep().size === 1 ? '' : 's' }}</button>
          <button hlmBtn variant="ghost" (click)="back.emit()">Back</button>
        </div>
      </section>
    }
  `,
})
export class PackAdopt {
  readonly report = input.required<CompareReport | null>();
  readonly keep = input.required<Set<string>>();
  readonly busy = input.required<boolean>();
  readonly library = input.required<LibraryState | null>();
  readonly pick = input.required<number | null>();
  readonly picked = input.required<LibraryPack | null>();
  readonly pickChange = output<number | null>();
  readonly compare = output();
  readonly toggled = output<string>();
  readonly adopt = output();
  readonly back = output();
  protected readonly bytes = formatBytes;
  protected readonly groups = [
    { key: 'notInPack', title: 'Not in the pack', hint: 'Keep → an Extra at the same path.' },
    {
      key: 'different',
      title: 'Different from the pack',
      hint: "Keep → an Extra replacing the pack's file. For a one-line change a Config edit is better: add it after adopting.",
    },
  ] as const;
}

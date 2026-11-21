import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PackRollback } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arCircleAlert } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';

/**
 * The Pack tab's amber line after a rollback: which update rolled back and that the world may have changed on load, and
 * its restore offer, which opens Backups with `?restore=<backup>` preselected (a typed restore like any).
 */
@Component({
  selector: 'app-pack-rolled-back',
  host: { class: 'contents' },
  imports: [RouterLink, NgIcon, HlmButton],
  viewProviders: [provideIcons({ arCircleAlert })],
  template: `
    @let rb = rolledBack();
    <div class="ar-callout ar-callout--warn -mx-4 flex flex-wrap items-center gap-3 border-y text-sm md:mx-0 md:rounded-lg md:border" data-rolled-back>
      <ng-icon name="arCircleAlert" class="text-status-warn" />
      <span class="flex-1">
        Pack update to {{ rb.to }} <b>rolled back</b>: no hello in time. {{ version() }} is running again, but the world may have been changed
        on load.
      </span>
      @if (rb.backup) {
        <a hlmBtn size="sm" variant="outline" routerLink="../backups" [queryParams]="{ restore: rb.backup }" data-restore-offer>Restore pre-update backup</a>
      }
    </div>
  `,
})
export class PackRolledBack {
  readonly rolledBack = input.required<PackRollback>();
  /** The installed version, running again. */
  readonly version = input.required<string>();
}

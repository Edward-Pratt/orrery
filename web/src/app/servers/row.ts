import { DecimalPipe, PercentPipe } from '@angular/common';
import { Component, computed, inject, input, output } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { ServerCard } from '@hub/api';
import { serverState, Status } from '../status';
import { ServerActions } from './actions';

/**
 * One server on the overview: its state, numbers and the actions that state allows (Restart and Console online, Start
 * offline, the countdown and Cancel while a restart is pending). A linked server's Start and Stop are its service's.
 * Tapping the row outside its buttons opens the server page. `changed` asks the page to fetch the cards again.
 */
@Component({
  selector: 'app-server-row',
  imports: [DecimalPipe, PercentPipe, RouterLink, ServerActions, Status],
  template: `
    @let c = card();
    <div
      class="flex cursor-pointer flex-col gap-2 rounded-lg border p-3 hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-4"
      [attr.data-server]="c.id"
      (click)="open($event)"
    >
      <div class="flex min-w-0 items-center justify-between gap-3 sm:w-64 sm:justify-start">
        <a [routerLink]="['/servers', c.id]" class="truncate font-medium hover:underline">{{ c.name }}</a>
        <app-status data-state [health]="state().health" [label]="state().label" class="text-sm" />
      </div>
      <dl class="flex flex-wrap gap-x-4 text-sm text-muted-foreground sm:flex-1">
        @if (c.features.tps) {
          <div class="flex gap-1"><dt>TPS</dt><dd data-tps class="text-foreground">{{ c.tps === null ? '–' : (c.tps | number: '1.1-1') }}</dd></div>
        }
        <div class="flex gap-1"><dt>Players</dt><dd data-players class="text-foreground" [attr.title]="c.players.join(', ')">{{ c.players.length }}</dd></div>
        <div class="flex gap-1"><dt>Uptime 24 h</dt><dd data-uptime class="text-foreground">{{ c.uptimeDay === null ? 'unknown' : (c.uptimeDay | percent: '1.0-1') }}</dd></div>
      </dl>
      <app-server-actions [card]="c" (changed)="changed.emit()" />
    </div>
  `,
})
export class ServerRow {
  readonly #router = inject(Router);
  readonly card = input.required<ServerCard>();
  /** After an action (or its failure), to fetch the cards again. */
  readonly changed = output<void>();
  protected readonly state = computed(() => serverState(this.card()));

  open(e: Event): void {
    if (!(e.target as Element).closest('a, button')) void this.#router.navigate(['/servers', this.card().id]);
  }
}

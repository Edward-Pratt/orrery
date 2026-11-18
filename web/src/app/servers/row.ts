import { DecimalPipe, PercentPipe } from '@angular/common';
import { Component, computed, inject, input, output } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { ServerCard } from '@hub/api';
import { serverState, Status } from '../status';
import { ServerActions } from './actions';

/**
 * One server on the overview: its state, numbers ("Paused" for the rate while a factorio server is paused) and the
 * actions that state allows (Restart and Console online, Start offline, the countdown and Cancel while a restart is
 * pending). A linked server's Start and Stop are its service's. Tapping the row outside its buttons opens the server
 * page. `changed` asks the page to fetch the cards again.
 */
@Component({
  selector: 'app-server-row',
  host: { class: 'contents' },
  imports: [DecimalPipe, PercentPipe, RouterLink, ServerActions, Status],
  // Armil's Tile, with a Readout per number; the tile isn't a link itself, as it holds the actions' buttons.
  template: `
    @let c = card();
    <div class="ar-tile server-tile cursor-pointer" [attr.data-server]="c.id" (click)="open($event)">
      <div class="ar-tile__who justify-between">
        <a [routerLink]="['/servers', c.id]" class="truncate hover:underline">{{ c.name }}</a>
        <app-status data-state [health]="state().health" [label]="state().label" class="font-normal" />
      </div>
      <dl class="flex flex-wrap gap-x-8 gap-y-3">
        @if (c.features.tps) {
          <div class="ar-readout"><dt class="ar-label">{{ c.rate.label }}</dt><dd data-tps class="ar-readout__value">{{ c.paused ? 'Paused' : c.tps === null ? '–' : (c.tps | number: '1.1-1') }}</dd></div>
        }
        <div class="ar-readout"><dt class="ar-label">Players</dt><dd data-players class="ar-readout__value" [attr.title]="c.players.join(', ')">{{ c.players.length }}</dd></div>
        <div class="ar-readout"><dt class="ar-label">Uptime 24 h</dt><dd data-uptime class="ar-readout__value">{{ c.uptimeDay === null ? 'unknown' : (c.uptimeDay | percent: '1.0-1') }}</dd></div>
      </dl>
      <app-server-actions [card]="c" (changed)="changed.emit()" />
    </div>
  `,
  styles: `
    .server-tile:hover {
      background: var(--raised);
    }
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

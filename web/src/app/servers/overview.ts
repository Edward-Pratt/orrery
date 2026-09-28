import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ServerHistory } from '@hub/api';
import { catchError, of } from 'rxjs';
import { TimeSeries } from '../chart';
import { ServerActions } from './actions';
import { PlayerName } from './player';
import ServerPage from './server';

/** A server's Overview: who's online, the last 24 h of TPS and players (linking to History), and a pending restart. */
@Component({
  selector: 'app-server-overview',
  imports: [RouterLink, TimeSeries, ServerActions, PlayerName],
  template: `
    @let c = server.card()!;
    <section class="mb-6" data-players>
      <h2 class="mb-2 text-sm font-semibold">Online now ({{ c.players.length }})</h2>
      @if (c.players.length) {
        <ul class="flex flex-wrap gap-2 text-sm">
          @for (p of c.players; track p) {
            <li class="rounded-full border" data-player-name><button [appPlayer]="p" class="px-3 py-1">{{ p }}</button></li>
          }
        </ul>
      } @else {
        <p class="text-sm text-muted-foreground">Nobody is online.</p>
      }
    </section>
    @if (c.restart) {
      <section class="mb-6 rounded-lg border border-amber-500/50 p-3" data-restart-pending-section>
        <app-server-actions [card]="c" (changed)="server.refresh()" />
      </section>
    }
    <a routerLink="../history" class="block max-w-3xl" data-sparklines>
      <div class="grid gap-4 sm:grid-cols-2">
        @for (g of graphs(); track g.title) {
          <section class="rounded-lg border p-3" [attr.data-chart]="g.title">
            <h2 class="text-sm font-semibold">{{ g.title }} <span class="font-normal text-muted-foreground">24 h</span></h2>
            <app-time-series [series]="g.series" [format]="g.format" [max]="g.max" [step]="g.step" />
          </section>
        }
      </div>
    </a>
  `,
})
export default class Overview {
  protected readonly server = inject(ServerPage);
  readonly #history = signal<ServerHistory | null>(null);
  protected readonly graphs = computed(() => {
    const h = this.#history();
    if (!h) return [];
    return [
      ...(h.tps ? [{ title: 'TPS', format: (v: number) => v.toFixed(1), max: 20, step: false, series: [{ name: 'TPS', points: h.tps.map((p): [number, number] => [p.ts, p.tps]) }] }] : []),
      { title: 'Players', format: String, max: undefined, step: true, series: [{ name: 'Players', points: h.players.map((p): [number, number] => [p.ts, p.count]) }] },
    ];
  });

  constructor() {
    inject(HttpClient)
      .get<ServerHistory>(`/api/servers/${encodeURIComponent(this.server.id)}/history?hours=24`)
      .pipe(catchError(() => of(null)))
      .subscribe((h) => this.#history.set(h));
  }
}

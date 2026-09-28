import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Lifecycle, LiveEvent, ServerCard } from '@hub/api';
import { catchError, debounceTime, EMPTY, startWith, Subject, switchMap } from 'rxjs';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { LiveEvents, ofTarget } from '../events';
import { ServerRow } from './row';

/** Events that change a card beyond its TPS: it is fetched again (and a server page's detail). */
const CARD_EVENTS: LiveEvent['type'][] = ['connected', 'started', 'stopped', 'crashed', 'hung', 'recovered', 'offline', 'join', 'leave'] satisfies (Lifecycle | 'join' | 'leave')[];
export const changesCard = (e: LiveEvent) =>
  'serverId' in e && (CARD_EVENTS.includes(e.type) || (e.type === 'notice' && /^(restart|lag)/.test(e.kind)));

@Component({
  selector: 'app-cards',
  imports: [HlmSkeleton, ServerRow],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Servers</h1>
    <div class="flex flex-col gap-2">
      @if (cards(); as list) {
        @for (c of list; track c.id) {
          <app-server-row [card]="c" (changed)="refetch.next()" />
        } @empty {
          <p class="text-muted-foreground">No servers yet: add one under "servers" in the hub's config.json.</p>
        }
      } @else {
        <div class="flex flex-col gap-2" data-skeleton>
          @for (i of [1, 2, 3]; track i) {
            <hlm-skeleton class="h-14 w-full" />
          }
        </div>
      }
    </div>
  `,
})
export default class Cards {
  /** Null until the first fetch, which shows the skeleton. */
  readonly cards = signal<ServerCard[] | null>(null);
  /** Fetches the cards again. */
  protected readonly refetch = new Subject<void>();

  constructor() {
    const http = inject(HttpClient);
    const refetch = this.refetch;
    // Debounced: the stream's replay can hold many joins and leaves at once.
    refetch
      .pipe(
        debounceTime(50),
        startWith(undefined),
        switchMap(() => http.get<ServerCard[]>('/api/servers').pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(),
      )
      .subscribe((cards) => this.cards.set(cards));
    inject(LiveEvents)
      .all$.pipe(takeUntilDestroyed())
      .subscribe((live) => {
        const { event } = live;
        if (event.type === 'tps') {
          this.cards.update((cards) =>
            cards?.map((c) => (c.id === event.serverId && c.features.tps ? { ...c, tps: event.tps } : c)) ?? null,
          );
        } else if (changesCard(event) || (ofTarget('service')(live) && event.type === 'state')) refetch.next();
      });
  }
}

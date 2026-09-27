import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { Lifecycle, LiveEvent, ServerCard } from '@hub/api';
import { catchError, debounceTime, EMPTY, startWith, Subject, switchMap } from 'rxjs';
import { LiveEvents } from '../events';

/** Events that change a card beyond its TPS: it is fetched again. */
const CARD_EVENTS: LiveEvent['type'][] = ['connected', 'started', 'stopped', 'crashed', 'hung', 'recovered', 'offline', 'join', 'leave'] satisfies (Lifecycle | 'join' | 'leave')[];
const changesCard = (e: LiveEvent) =>
  'serverId' in e && (CARD_EVENTS.includes(e.type) || (e.type === 'notice' && e.kind.startsWith('restart')));

@Component({
  selector: 'app-cards',
  imports: [RouterLink, DatePipe, DecimalPipe, PercentPipe],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Servers</h1>
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      @for (c of cards(); track c.id) {
        <a [routerLink]="c.id" class="block rounded-lg border p-4 hover:bg-muted/50" [attr.data-server]="c.id">
          <div class="flex items-center justify-between">
            <span class="font-medium">{{ c.name }}</span>
            <span class="text-sm" [class.text-destructive]="!c.online || c.hung">
              {{ c.hung ? 'Not responding' : c.online ? 'Online' : 'Offline' }}
            </span>
          </div>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            @if (c.features.tps) {
              <dt class="text-muted-foreground">TPS</dt>
              <dd data-tps>{{ c.tps === null ? '–' : (c.tps | number: '1.1-1') }}</dd>
            }
            <dt class="text-muted-foreground">Players</dt>
            <dd data-players>{{ c.players.length ? c.players.join(', ') : 'none' }}</dd>
            <dt class="text-muted-foreground">Uptime 24 h</dt>
            <dd>{{ c.uptimeDay === null ? 'unknown' : (c.uptimeDay | percent: '1.0-1') }}</dd>
            @if (c.restart; as r) {
              <dt class="text-muted-foreground">{{ r.stop ? 'Stop' : 'Restart' }}</dt>
              <dd>at {{ r.at | date: 'HH:mm' }} by {{ r.by }}</dd>
            }
          </dl>
        </a>
      } @empty {
        <p class="text-muted-foreground">No servers.</p>
      }
    </div>
  `,
})
export default class Cards {
  readonly cards = signal<ServerCard[]>([]);

  constructor() {
    const http = inject(HttpClient);
    const refetch = new Subject<void>();
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
      .subscribe(({ event }) => {
        if (event.type === 'tps') {
          this.cards.update((cards) =>
            cards.map((c) => (c.id === event.serverId && c.features.tps ? { ...c, tps: event.tps } : c)),
          );
        } else if (changesCard(event)) refetch.next();
      });
  }
}

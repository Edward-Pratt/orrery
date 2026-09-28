import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import type { HubEvent, LiveEvent, ServerHistory, UptimeState } from '@hub/api';
import { catchError, filter, of, switchMap } from 'rxjs';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { PeriodPicker, type Series, TimeSeries } from '../chart';
import { LiveEvents, ofServer } from '../events';
import ServerPage from './server';

type Point = [number, number];
/** The state each lifecycle event leaves a server in. */
const STATES: Partial<Record<LiveEvent['type'], UptimeState>> = {
  connected: 'up',
  started: 'up',
  recovered: 'up',
  hung: 'hung',
  stopped: 'down',
  crashed: 'down',
  offline: 'down',
};
/** Uptime is drawn as a level: unknown is a gap. */
const LEVEL: Record<UptimeState, number> = { up: 1, hung: 0.5, down: 0, unknown: NaN };
const stateOf = (level: number) => (level === 1 ? 'up' : level === 0.5 ? 'hung' : level === 0 ? 'down' : '');
const tpsOf = (tps: number) => tps.toFixed(1);

/** A server's History section: TPS, player and uptime graphs over a chosen period, extended by live events. */
@Component({
  selector: 'app-server-history',
  imports: [HlmSkeleton, PeriodPicker, TimeSeries],
  template: `
    <app-period class="mb-4 block" [(hours)]="hours" />
    @if (history()) {
      <div class="grid gap-4 lg:grid-cols-2">
        @for (c of charts(); track c.title) {
          <section class="rounded-xl border p-3" [attr.data-chart]="c.title">
            <h2 class="text-sm font-semibold">{{ c.title }}</h2>
            <app-time-series [series]="c.series" [format]="c.format" [max]="c.max" [step]="c.step" />
          </section>
        }
      </div>
    } @else if (failed()) {
      <p class="text-sm text-muted-foreground">The history couldn't be loaded. Reload to try again.</p>
    } @else {
      <div class="grid gap-4 lg:grid-cols-2" data-skeleton>
        @for (i of [1, 2, 3]; track i) {
          <hlm-skeleton class="h-48 rounded-xl" />
        }
      </div>
    }
  `,
})
export default class History {
  readonly #server = inject(ServerPage);
  /** The graphed period, in hours. */
  readonly hours = signal(24);
  readonly history = signal<ServerHistory | null>(null);
  /** The last load failed, so the skeleton gives way to a message. */
  protected readonly failed = signal(false);
  /** Stream events that change the graphs, with when they arrived; those up to the history's `asOf` are already in it. */
  readonly #live = signal<{ id: number; at: number; event: HubEvent }[]>([]);
  protected readonly charts = computed(() => {
    const h = this.history();
    if (!h) return [];
    const tps = (h.tps ?? []).map((p): Point => [p.ts, p.tps]);
    const players = h.players.map((p): Point => [p.ts, p.count]);
    const uptime = h.uptime.map((p): Point => [p.ts, LEVEL[p.state]]);
    const last = (points: Point[]) => points.at(-1)?.[1] ?? 0;
    for (const { id, at, event } of this.#live()) {
      if (id <= h.asOf) continue;
      if (event.type === 'tps') tps.push([at, event.tps]);
      else if (event.type === 'join' || event.type === 'leave') {
        players.push([at, Math.max(0, last(players) + (event.type === 'join' ? 1 : -1))]);
      } else if (STATES[event.type]) {
        uptime.push([at, LEVEL[STATES[event.type]!]]);
        if (STATES[event.type] === 'down') players.push([at, 0]);
      }
    }
    if (uptime.length) uptime.push([Date.now(), last(uptime)]); // the last state lasts until now
    const line = (name: string, points: Point[]): Series[] => [{ name, points }];
    return [
      ...(h.tps ? [{ title: 'TPS', format: tpsOf, max: 20, step: false, series: line('TPS', tps) }] : []),
      { title: 'Players', format: String, max: undefined, step: true, series: line('Players', players) },
      { title: 'Uptime', format: stateOf, max: 1, step: true, series: line('Uptime', uptime) },
    ];
  });

  constructor() {
    const id = this.#server.id;
    const http = inject(HttpClient);
    // A newer choice drops a period still loading.
    toObservable(this.hours)
      .pipe(
        switchMap((hours) =>
          http.get<ServerHistory>(`/api/servers/${encodeURIComponent(id)}/history?hours=${hours}`).pipe(catchError(() => of(null))),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((history) => {
        this.history.set(history);
        this.failed.set(!history);
        if (history) this.#live.update((live) => live.filter((l) => l.id > history.asOf));
      });
    inject(LiveEvents)
      .all$.pipe(filter(ofServer(id)), takeUntilDestroyed())
      .subscribe(({ id, event }) => {
        if (event.type === 'tps' || event.type === 'join' || event.type === 'leave' || STATES[event.type]) {
          this.#live.update((live) => [...live, { id, at: Date.now(), event }]);
        }
      });
  }
}

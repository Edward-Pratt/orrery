import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import type { HostHistory, HostNow, HostSample } from '@hub/api';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { catchError, filter, of, switchMap } from 'rxjs';
import { PeriodPicker, type Series, TimeSeries } from '../chart';
import { LiveEvents, ofTarget } from '../events';
import type { Health } from '../status';

const GB = 1024 ** 3;
const fixed = (n: number) => n.toFixed(2);
const gbOf = (bytes: number) => (bytes / GB).toFixed(1);
const percent = (share: number) => `${Math.round(share * 100)}%`;
/** The share used (or, for a disk, the share free) at which a tile turns amber, then red. */
const CPU_LIMITS = [0.8, 0.95] as const;
const MEMORY_LIMITS = [0.85, 0.95] as const;
const DISK_FREE_LIMITS = [0.2, 0.1] as const;
const over = (share: number, [warn, down]: readonly [number, number]): Health => (share >= down ? 'down' : share >= warn ? 'warn' : 'ok');
const under = (share: number, [warn, down]: readonly [number, number]): Health => (share < down ? 'down' : share < warn ? 'warn' : 'ok');

type Tile = { key: string; label: string; value: string; detail: string; share: number | null; health: Health };

const formatGb = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;

@Component({
  selector: 'app-host',
  imports: [DatePipe, HlmSkeleton, PeriodPicker, TimeSeries],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Host {{ id() }}</h1>
    @if (tiles(); as list) {
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4" data-tiles>
        @for (t of list; track t.key) {
          <section class="rounded-xl border bg-card p-4" [attr.data-tile]="t.key" [attr.data-state]="t.health">
            <h2 class="text-xs font-medium text-muted-foreground">{{ t.label }}</h2>
            <p class="mt-1 text-2xl font-semibold" [attr.data-value]="t.key">{{ t.value }}</p>
            <p class="text-xs text-muted-foreground" [attr.data-detail]="t.key">{{ t.detail }}</p>
            @if (t.share !== null) {
              <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div class="h-full rounded-full" [class]="bars[t.health]" [style.width.%]="t.share * 100"></div>
              </div>
            }
          </section>
        }
      </div>
      <p class="mt-3 text-xs text-muted-foreground">Sampled at {{ sample()!.ts | date: 'HH:mm' }}; updates every minute.</p>
    } @else if (loaded()) {
      <p class="text-muted-foreground">No sample yet: the first comes a minute after the hub starts.</p>
    } @else {
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4" data-skeleton>
        @for (i of [1, 2, 3, 4]; track i) {
          <hlm-skeleton class="h-28 rounded-xl" />
        }
      </div>
    }
    <app-period class="mt-6 mb-4 block" [(hours)]="hours" />
    <div class="grid gap-4 lg:grid-cols-2">
      @for (c of charts(); track c.title) {
        <section class="rounded-lg border p-3" [attr.data-chart]="c.title">
          <h2 class="text-sm font-semibold">{{ c.title }}</h2>
          <app-time-series [series]="c.series" [format]="c.format" [max]="c.max" />
        </section>
      }
    </div>
  `,
})
export default class Host {
  protected readonly bars = { ok: 'bg-status-ok', warn: 'bg-status-warn', down: 'bg-status-down' };
  readonly id = signal('');
  readonly sample = signal<HostSample | null>(null);
  /** The first answer is in (a skeleton shows until then). */
  readonly loaded = signal(false);
  /** A tile each for CPU, load, memory and every disk, from the latest sample. */
  protected readonly tiles = computed((): Tile[] | null => {
    const s = this.sample();
    if (!s) return null;
    const used = s.memory.used / s.memory.total;
    return [
      { key: 'cpu', label: 'CPU', value: percent(s.cpu), detail: '', share: s.cpu, health: over(s.cpu, CPU_LIMITS) },
      // ponytail: no bar or warning for load, the sample carries no core count to scale it by.
      { key: 'load', label: 'Load', value: s.load.map(fixed).join(' · '), detail: '1 · 5 · 15 min', share: null, health: 'ok' },
      { key: 'memory', label: 'Memory', value: percent(used), detail: `${gbOf(s.memory.used)} of ${gbOf(s.memory.total)} GB`, share: used, health: over(used, MEMORY_LIMITS) },
      ...s.disks.map((d): Tile => {
        const free = d.free / d.total;
        return { key: `disk:${d.mount}`, label: `Disk ${d.mount}`, value: `${gbOf(d.free)} GB free`, detail: `of ${(d.total / GB).toFixed(0)} GB`, share: 1 - free, health: under(free, DISK_FREE_LIMITS) };
      }),
    ];
  });
  /** The graphed period, in hours. */
  readonly hours = signal(24);
  /** The period's samples (averaged by the hub over 25 hours), then each live one. */
  readonly history = signal<HostSample[]>([]);
  protected readonly charts = computed(() => {
    const h = this.history();
    const line = (name: string, f: (s: HostSample) => number): Series => ({ name, points: h.map((s) => [s.ts, f(s)]) });
    const mounts = [...new Set(h.flatMap((s) => s.disks.map((d) => d.mount)))];
    return [
      { title: 'CPU', format: percent, max: 1, series: [line('CPU', (s) => s.cpu)] },
      { title: 'Load', format: fixed, max: undefined, series: [line('1 min', (s) => s.load[0])] },
      { title: 'Memory', format: percent, max: 1, series: [line('Used', (s) => s.memory.used / s.memory.total)] },
      {
        title: 'Disk free',
        format: formatGb,
        max: undefined,
        series: mounts.map((mount): Series => ({
          name: mount,
          points: h.flatMap((s) => s.disks.filter((d) => d.mount === mount).map((d): [number, number] => [s.ts, d.free])),
        })),
      },
    ];
  });

  constructor() {
    const http = inject(HttpClient);
    http.get<HostNow>('/api/host').subscribe({ error: () => this.loaded.set(true), next: (now) => {
      this.id.set(now.id);
      if (!this.sample() || (now.sample && now.sample.ts > this.sample()!.ts)) this.sample.set(now.sample);
      this.loaded.set(true);
    } });
    // A newer choice drops a period still loading.
    toObservable(this.hours)
      .pipe(
        switchMap((hours) => http.get<HostHistory>(`/api/host/samples?hours=${hours}`).pipe(catchError(() => of([])))),
        takeUntilDestroyed(),
      )
      .subscribe((history) => this.history.set(history));
    // The replay brings the latest sample, then a new one arrives each minute.
    inject(LiveEvents)
      .all$.pipe(filter(ofTarget('host')), takeUntilDestroyed())
      .subscribe(({ event }) => {
        if (event.type !== 'sample') return;
        this.sample.set(event.sample);
        this.history.update((h) => (h.length && h.at(-1)!.ts >= event.sample.ts ? h : [...h, event.sample]));
      });
  }
}

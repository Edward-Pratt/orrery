import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import type { HostHistory, HostNow, HostSample } from '@hub/api';
import { catchError, filter, of, switchMap } from 'rxjs';
import { PeriodPicker, type Series, TimeSeries } from '../chart';
import { LiveEvents, ofTarget } from '../events';

const GB = 1024 ** 3;
const fixed = (n: number) => n.toFixed(2);
const percent = (share: number) => `${Math.round(share * 100)}%`;
const formatGb = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;

@Component({
  selector: 'app-host',
  imports: [DatePipe, DecimalPipe, PercentPipe, PeriodPicker, TimeSeries],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Host {{ id() }}</h1>
    @if (sample(); as s) {
      <dl class="grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt class="text-muted-foreground">CPU</dt>
        <dd data-cpu>{{ s.cpu | percent: '1.0-0' }}</dd>
        <dt class="text-muted-foreground">Load</dt>
        <dd data-load>{{ s.load.map(fixed).join(' · ') }}</dd>
        <dt class="text-muted-foreground">Memory</dt>
        <dd data-memory>{{ s.memory.used / gb | number: '1.1-1' }} of {{ s.memory.total / gb | number: '1.1-1' }} GB ({{ s.memory.used / s.memory.total | percent: '1.0-0' }})</dd>
        @for (d of s.disks; track d.mount) {
          <dt class="text-muted-foreground">Disk {{ d.mount }}</dt>
          <dd [attr.data-disk]="d.mount">{{ d.free / gb | number: '1.1-1' }} GB free of {{ d.total / gb | number: '1.0-0' }} GB</dd>
        }
      </dl>
      <p class="mt-4 text-xs text-muted-foreground">Sampled at {{ s.ts | date: 'HH:mm' }}; updates every minute.</p>
    } @else {
      <p class="text-muted-foreground">No sample yet: the first comes a minute after the hub starts.</p>
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
  protected readonly gb = GB;
  protected readonly fixed = fixed;
  readonly id = signal('');
  readonly sample = signal<HostSample | null>(null);
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
    http.get<HostNow>('/api/host').subscribe((now) => {
      this.id.set(now.id);
      if (!this.sample() || (now.sample && now.sample.ts > this.sample()!.ts)) this.sample.set(now.sample);
    });
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

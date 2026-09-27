import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { HostNow, HostSample } from '@hub/api';
import { filter } from 'rxjs';
import { LiveEvents, ofTarget } from '../events';

const GB = 1024 ** 3;

@Component({
  selector: 'app-host',
  imports: [DatePipe, DecimalPipe, PercentPipe],
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
  `,
})
export default class Host {
  protected readonly gb = GB;
  protected readonly fixed = (n: number) => n.toFixed(2);
  readonly id = signal('');
  readonly sample = signal<HostSample | null>(null);

  constructor() {
    inject(HttpClient)
      .get<HostNow>('/api/host')
      .subscribe((now) => {
        this.id.set(now.id);
        if (!this.sample() || (now.sample && now.sample.ts > this.sample()!.ts)) this.sample.set(now.sample);
      });
    // The replay brings the latest sample, then a new one arrives each minute.
    inject(LiveEvents)
      .all$.pipe(filter(ofTarget('host')), takeUntilDestroyed())
      .subscribe(({ event }) => {
        if (event.type === 'sample') this.sample.set(event.sample);
      });
  }
}

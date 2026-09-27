import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import type { Period, PlayerAnswer } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { formatDuration } from '../units';
import ServerPage from './server';

const PERIODS: { period: Period; label: string }[] = [
  { period: 'day', label: 'Last 24 hours' },
  { period: 'week', label: 'Last 7 days' },
  { period: 'all', label: 'All time' },
];

/** A server's Stats section, as Discord's `/top` and `/playtime`: the most-played per period, and a player lookup. */
@Component({
  selector: 'app-server-stats',
  imports: [DatePipe, HlmButton],
  template: `
    @let top = server.detail()!.top;
    <div class="grid max-w-4xl gap-4 sm:grid-cols-3">
      @for (p of periods; track p.period) {
        <section class="rounded-lg border p-3">
          <h2 class="mb-2 text-sm font-semibold">{{ p.label }}</h2>
          <ol class="text-sm" [attr.data-top]="p.period">
            @for (row of top[p.period]; track row.player) {
              <li>{{ $index + 1 }}. <button class="font-medium hover:underline" (click)="look(row.player)">{{ row.player }}</button> {{ duration(row.ms) }}</li>
            } @empty {
              <li class="text-muted-foreground">No playtime recorded.</li>
            }
          </ol>
        </section>
      }
    </div>
    <form class="mt-6 flex max-w-md gap-2" (submit)="$event.preventDefault(); look(name.value)" data-lookup>
      <input #name class="flex-1 rounded-md border px-3 py-1.5 text-sm" placeholder="Minecraft name" aria-label="Player" [value]="asked() ?? ''" />
      <button hlmBtn type="submit">Look up</button>
    </form>
    @if (player(); as p) {
      @if (p.found) {
        <section class="mt-4 max-w-md rounded-lg border p-3" data-player>
          <h3 class="mb-2 font-medium">{{ p.player }}</h3>
          <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt class="text-muted-foreground">Total</dt>
            <dd>{{ duration(p.totalMs) }}</dd>
            <dt class="text-muted-foreground">Last 7 days</dt>
            <dd>{{ duration(p.weekMs) }}</dd>
            <dt class="text-muted-foreground">Last seen</dt>
            <dd>{{ p.lastSeen === null ? 'never' : typeof p.lastSeen === 'number' ? (p.lastSeen | date: 'yyyy-MM-dd HH:mm') : 'online now' }}</dd>
          </dl>
        </section>
      }
    } @else if (error(); as e) {
      <p class="mt-4 text-sm text-muted-foreground" data-never>{{ e }}</p>
    }
  `,
})
export default class Stats {
  protected readonly server = inject(ServerPage);
  protected readonly periods = PERIODS;
  protected readonly duration = formatDuration;
  readonly #http = inject(HttpClient);
  /** The name last looked up. */
  readonly asked = signal<string | null>(null);
  readonly player = signal<PlayerAnswer | null>(null);
  readonly error = signal<string | null>(null);

  look(name: string): void {
    name = name.trim();
    if (!name) return;
    this.asked.set(name);
    this.player.set(null);
    this.error.set(null);
    const url = `/api/servers/${encodeURIComponent(this.server.id)}/players/${encodeURIComponent(name)}`;
    this.#http.get<PlayerAnswer>(url).subscribe({
      next: (answer) => this.player.set(answer),
      error: (err: HttpErrorResponse) =>
        this.error.set(err.status === 404 ? `${name}: never seen here.` : `The lookup failed (HTTP ${err.status}). Try again.`),
    });
  }
}

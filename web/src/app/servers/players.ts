import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import type { Period, PlayerAnswer } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { formatDuration } from '../units';
import { lookupError, PlayerCard } from './player';
import ServerPage from './server';

const PERIODS: { period: Period; label: string; short: string }[] = [
  { period: 'day', label: 'Last 24 hours', short: 'Day' },
  { period: 'week', label: 'Last 7 days', short: 'Week' },
  { period: 'all', label: 'All time', short: 'All' },
];

/**
 * A server's Players section, as Discord's `/top` and `/playtime`: a player lookup with its result as a card, and the
 * most-played per period: side by side, or one at a time behind a Day / Week / All control on a phone.
 */
@Component({
  selector: 'app-server-players',
  imports: [HlmButton, HlmSkeleton, HlmToggleGroupImports, PlayerCard],
  template: `
    <form class="flex max-w-md gap-2" (submit)="$event.preventDefault(); look(name.value)" data-lookup>
      <input #name class="flex-1 rounded-md border px-3 py-1.5 text-sm" placeholder="Minecraft name" aria-label="Player" [value]="asked() ?? ''" />
      <button hlmBtn type="submit">Look up</button>
    </form>
    @if (looking()) {
      <hlm-skeleton class="mt-4 block h-24 max-w-md rounded-xl" data-skeleton />
    } @else if (player(); as p) {
      @if (p.found) {
        <app-player-card class="mt-4 block max-w-md" [player]="p" />
      }
    } @else if (error(); as e) {
      <p class="mt-4 text-sm text-muted-foreground" data-never>{{ e }}</p>
    }
    <hlm-toggle-group class="mt-6 sm:hidden" type="single" variant="outline" [value]="period()" (valueChange)="choose($event)" data-periods>
      @for (p of periods; track p.period) {
        <button hlmToggleGroupItem [value]="p.period" [attr.data-show]="p.period">{{ p.short }}</button>
      }
    </hlm-toggle-group>
    @if (empty()) {
      <p class="mt-6 text-sm text-muted-foreground" data-empty>Nobody has played yet. The most-played players show here once they have.</p>
    } @else {
      <div class="mt-4 grid gap-4 sm:mt-6 sm:grid-cols-3">
        @for (p of periods; track p.period) {
          <section class="rounded-xl border p-3" [class]="p.period === period() ? '' : 'max-sm:hidden'" [attr.data-list]="p.period">
            <h2 class="mb-2 text-sm font-semibold">{{ p.label }}</h2>
            <table class="w-full text-sm" [attr.data-top]="p.period">
              <tbody>
                @for (row of top()[p.period]; track row.player) {
                  <tr>
                    <td class="w-6 py-0.5 text-muted-foreground">{{ $index + 1 }}</td>
                    <td><button class="font-medium hover:underline" (click)="look(row.player)">{{ row.player }}</button></td>
                    <td class="text-right tabular-nums text-muted-foreground">{{ duration(row.ms) }}</td>
                  </tr>
                } @empty {
                  <tr><td class="text-muted-foreground">No playtime recorded.</td></tr>
                }
              </tbody>
            </table>
          </section>
        }
      </div>
    }
  `,
})
export default class Players {
  protected readonly server = inject(ServerPage);
  protected readonly periods = PERIODS;
  protected readonly duration = formatDuration;
  readonly #http = inject(HttpClient);
  protected readonly top = computed(() => this.server.detail()!.top);
  protected readonly empty = computed(() => PERIODS.every((p) => !this.top()[p.period].length));
  /** The list shown on a phone. */
  readonly period = signal<Period>('day');
  /** The name last looked up. */
  readonly asked = signal<string | null>(null);
  readonly looking = signal(false);
  readonly player = signal<PlayerAnswer | null>(null);
  readonly error = signal<string | null>(null);

  protected choose(value: Period | Period[] | null | undefined): void {
    this.period.set([value].flat()[0] ?? 'day');
  }

  look(name: string): void {
    name = name.trim();
    if (!name) return;
    this.asked.set(name);
    this.player.set(null);
    this.error.set(null);
    this.looking.set(true);
    const url = `/api/servers/${encodeURIComponent(this.server.id)}/players/${encodeURIComponent(name)}`;
    this.#http.get<PlayerAnswer>(url).subscribe({
      next: (answer) => (this.looking.set(false), this.player.set(answer)),
      error: (err: HttpErrorResponse) => (this.looking.set(false), this.error.set(lookupError(name, err))),
    });
  }
}

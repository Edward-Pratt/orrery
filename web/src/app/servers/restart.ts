import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, DestroyRef, inject, input, output, signal } from '@angular/core';
import type { PendingRestart, RestartRequest } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { formatDuration } from '../units';

/**
 * Schedules a countdown restart of a server (players are warned in game) and cancels it, and counts a pending one
 * down. `pending` is the card's, which its page fetches again on restart notices (so one scheduled from Discord or by
 * a service stop shows too) and on `changed`, after each action.
 */
@Component({
  selector: 'app-restart',
  imports: [DatePipe, HlmButton],
  template: `
    @if (pending(); as r) {
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span data-restart-pending>{{ r.stop ? 'Stop' : 'Restart' }} at {{ r.at | date: 'HH:mm:ss' }} by {{ r.by }}</span>
        <span class="font-medium tabular-nums" data-restart-left>{{ left() }}</span>
        <button hlmBtn variant="outline" size="sm" (click)="cancel()" data-restart-cancel>Cancel</button>
      </div>
    } @else {
      <form class="flex flex-wrap items-center gap-2 text-sm" (submit)="$event.preventDefault(); schedule(+minutes.value)" data-restart-form>
        <label class="flex items-center gap-2">
          Restart in
          <input #minutes type="number" min="0" max="60" step="1" value="5" class="w-16 rounded-md border px-2 py-1" />
          minutes
        </label>
        <button hlmBtn variant="outline" size="sm" type="submit">Schedule</button>
      </form>
    }
    @if (error(); as e) {
      <p class="mt-2 text-sm text-destructive" role="alert">{{ e }}</p>
    }
  `,
})
export class Restart {
  readonly #http = inject(HttpClient);
  readonly serverId = input.required<string>();
  readonly pending = input<PendingRestart | null>(null);
  /** After each action (or its failure: it may have fired or been cancelled elsewhere), to fetch `pending` again. */
  readonly changed = output<void>();
  readonly error = signal<string | null>(null);
  readonly #now = signal(Date.now());
  protected readonly left = computed(() => {
    const ms = (this.pending()?.at ?? 0) - this.#now();
    return ms > 500 ? `in ${formatDuration(ms)}` : 'any moment now';
  });

  constructor() {
    // ponytail: ticks every second even with nothing pending; cheap next to a page of charts.
    const tick = setInterval(() => this.#now.set(Date.now()), 1_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  schedule(minutes: number): void {
    this.#post('restart', { minutes } satisfies RestartRequest);
  }

  cancel(): void {
    this.#post('restart/cancel', {});
  }

  #post(path: string, body: object): void {
    this.#http.post(`/api/servers/${encodeURIComponent(this.serverId())}/${path}`, body).subscribe({
      next: () => {
        this.error.set(null);
        this.changed.emit();
      },
      error: (err: HttpErrorResponse) => {
        this.error.set(typeof err.error === 'string' && err.error ? err.error : `It failed (HTTP ${err.status}).`);
        this.changed.emit();
      },
    });
  }
}

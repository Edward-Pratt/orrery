import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import type { RestartRequest } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import ServerPage from './server';

/**
 * Schedules a countdown restart (players are warned in game) and cancels it. The pending one comes from the server's
 * detail, fetched again on restart notices, so one scheduled from Discord or by a service stop shows too.
 */
@Component({
  selector: 'app-restart',
  imports: [DatePipe, HlmButton],
  template: `
    @if (server.card()?.restart; as r) {
      <div class="flex flex-wrap items-center gap-3">
        <p class="text-sm" data-restart-pending>{{ r.stop ? 'Stop' : 'Restart' }} at {{ r.at | date: 'HH:mm:ss' }} by {{ r.by }}</p>
        <button hlmBtn variant="outline" size="sm" (click)="cancel()" data-restart-cancel>Cancel</button>
      </div>
    } @else {
      <form class="flex flex-wrap items-center gap-2 text-sm" (submit)="$event.preventDefault(); schedule(+minutes.value)" data-restart-form>
        <label for="restart-minutes">Restart in</label>
        <input #minutes id="restart-minutes" type="number" min="0" max="60" step="1" value="5" class="w-20 rounded-md border px-2 py-1" />
        <span>minutes</span>
        <button hlmBtn variant="outline" size="sm" type="submit">Schedule</button>
      </form>
    }
    @if (error(); as e) {
      <p class="mt-2 text-sm text-destructive" role="alert">{{ e }}</p>
    }
  `,
})
export class Restart {
  protected readonly server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly error = signal<string | null>(null);

  schedule(minutes: number): void {
    this.#post('restart', { minutes } satisfies RestartRequest);
  }

  cancel(): void {
    this.#post('restart/cancel', {});
  }

  #post(path: string, body: object): void {
    this.#http.post(`/api/servers/${encodeURIComponent(this.server.id)}/${path}`, body).subscribe({
      next: () => {
        this.error.set(null);
        this.server.refresh();
      },
      error: (err: HttpErrorResponse) => {
        this.error.set(typeof err.error === 'string' && err.error ? err.error : `It failed (HTTP ${err.status}).`);
        this.server.refresh(); // it may have fired or been cancelled elsewhere
      },
    });
  }
}

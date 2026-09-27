import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { ServiceLogs, ServiceStatus } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { catchError, debounceTime, EMPTY, filter, startWith, switchMap } from 'rxjs';
import { LiveEvents, ofTarget } from '../events';
import { ServiceActions } from './actions';

@Component({
  selector: 'app-services',
  imports: [RouterLink, HlmButton, ServiceActions],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Services</h1>
    <div class="flex max-w-3xl flex-col gap-3">
      @for (s of services(); track s.id) {
        <section class="rounded-lg border p-4" [id]="s.id" [attr.data-service]="s.id">
          <div class="flex items-center justify-between gap-4">
            <div>
              <span class="font-medium">{{ s.id }}</span>
              <span class="ml-2 text-sm text-muted-foreground">{{ s.unit }}</span>
            </div>
            <span data-state class="text-sm" [class.text-destructive]="s.state === 'failed'">
              {{ s.state === null ? 'unknown' : s.state + ' (' + s.sub + ')' }}
            </span>
          </div>
          @if (s.checks.length) {
            <p class="mt-1 text-sm text-muted-foreground" data-checks>
              Checks:
              @for (c of s.checks; track c) {
                <a routerLink="/checks" class="hover:underline">{{ c }}</a>{{ $last ? '' : ', ' }}
              }
            </p>
          }
          <div class="mt-3 flex flex-wrap items-start gap-2">
            <app-service-actions [service]="s" />
            <button hlmBtn variant="outline" size="sm" (click)="toggleLogs(s.id)" data-logs-button>
              {{ logs()[s.id] ? 'Hide logs' : 'Logs' }}
            </button>
          </div>
          @if (logs()[s.id]; as lines) {
            <pre class="mt-3 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs" data-logs>{{ lines.join('\n') || 'No log lines.' }}</pre>
          }
        </section>
      } @empty {
        <p class="text-muted-foreground">No services.</p>
      }
      @if (error(); as e) {
        <p class="text-sm text-destructive" role="alert">{{ e }}</p>
      }
    </div>
  `,
})
export default class Services {
  readonly #http = inject(HttpClient);
  readonly services = signal<ServiceStatus[]>([]);
  /** Log lines of the services whose logs are open. */
  readonly logs = signal<Record<string, string[]>>({});
  readonly error = signal<string | null>(null);

  constructor() {
    // Fetched again on a state change or failure (debounced: the replay can hold several).
    inject(LiveEvents)
      .all$.pipe(
        filter(ofTarget('service')),
        debounceTime(50),
        startWith(undefined),
        switchMap(() => this.#http.get<ServiceStatus[]>('/api/services').pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(),
      )
      .subscribe((services) => this.services.set(services));
  }

  toggleLogs(id: string): void {
    if (this.logs()[id]) {
      this.logs.update(({ [id]: _, ...rest }) => rest);
      return;
    }
    this.#http.get<ServiceLogs>(`/api/services/${encodeURIComponent(id)}/logs`).subscribe({
      next: ({ lines }) => {
        this.error.set(null);
        this.logs.update((logs) => ({ ...logs, [id]: lines }));
      },
      error: (err: HttpErrorResponse) => this.error.set(`No logs for ${id} (HTTP ${err.status}): ${err.error ?? ''}`),
    });
  }
}

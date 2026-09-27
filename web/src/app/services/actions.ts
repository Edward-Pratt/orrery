import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, input, signal } from '@angular/core';
import type { ServiceActionAnswer, ServiceStatus, ServiceVerb } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';

const LABELS: Record<ServiceVerb, string> = { start: 'Start', stop: 'Stop', restart: 'Restart' };

/** Start, stop and restart buttons for a service, each asking for confirmation first. */
@Component({
  selector: 'app-service-actions',
  imports: [HlmButton, DatePipe],
  template: `
    <div class="flex flex-wrap items-center gap-2">
      @for (verb of verbs; track verb) {
        <button hlmBtn variant="outline" size="sm" [attr.data-action]="verb" (click)="act(verb)">{{ labels[verb] }}</button>
      }
    </div>
    @if (countdownAt(); as at) {
      <p class="mt-2 text-sm text-muted-foreground" data-result>Players are online: they're warned in game, and it happens at {{ at | date: 'HH:mm:ss' }}.</p>
    } @else if (result(); as r) {
      <p class="mt-2 text-sm" [class.text-destructive]="failed()" [attr.role]="failed() ? 'alert' : null" data-result>{{ r }}</p>
    }
  `,
})
export class ServiceActions {
  readonly #http = inject(HttpClient);
  readonly service = input.required<ServiceStatus>();
  protected readonly verbs: ServiceVerb[] = ['start', 'stop', 'restart'];
  protected readonly labels = LABELS;
  readonly result = signal<string | null>(null);
  readonly failed = signal(false);
  readonly countdownAt = signal<number | null>(null);

  act(verb: ServiceVerb): void {
    const { id, unit } = this.service();
    if (!confirm(`${LABELS[verb]} ${unit}?`)) return;
    this.countdownAt.set(null);
    this.#http.post<ServiceActionAnswer>(`/api/services/${encodeURIComponent(id)}/${verb}`, {}).subscribe({
      next: ({ at }) => {
        this.failed.set(false);
        this.countdownAt.set(at);
        this.result.set(`${LABELS[verb]} sent to ${unit}.`);
      },
      error: (err: HttpErrorResponse) => {
        this.failed.set(true);
        this.result.set(`${LABELS[verb]} failed (HTTP ${err.status}): ${typeof err.error === 'string' ? err.error : ''}`);
      },
    });
  }
}

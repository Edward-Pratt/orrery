import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, input, signal } from '@angular/core';
import type { ServiceActionAnswer, ServiceStatus, ServiceVerb } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { Feedback } from '../feedback';

const LABELS: Record<ServiceVerb, string> = { start: 'Start', stop: 'Stop', restart: 'Restart' };

/** Start, stop and restart buttons for a service; Stop and Restart ask first, and the outcome is a toast. */
@Component({
  selector: 'app-service-actions',
  imports: [HlmButton, HlmSpinner],
  template: `
    <div class="flex flex-wrap items-center gap-2">
      @for (verb of verbs; track verb) {
        <button hlmBtn variant="outline" size="sm" [attr.data-action]="verb" [disabled]="!!busy()" (click)="act(verb)">
          @if (busy() === verb) {
            <hlm-spinner />
          }
          {{ labels[verb] }}
        </button>
      }
    </div>
  `,
})
export class ServiceActions {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly service = input.required<ServiceStatus>();
  protected readonly verbs: ServiceVerb[] = ['start', 'stop', 'restart'];
  protected readonly labels = LABELS;
  /** The verb in flight, so it can't be sent twice. */
  readonly busy = signal<ServiceVerb | null>(null);

  async act(verb: ServiceVerb): Promise<void> {
    const { id, unit } = this.service();
    // Starting harms nothing; the rest can disconnect players.
    if (verb !== 'start') {
      const ok = await this.#feedback.confirm({
        title: `${LABELS[verb]} ${unit}?`,
        description: verb === 'stop' ? `${unit} stays down until it's started again.` : `${unit} is briefly down while it restarts.`,
        verb: `${LABELS[verb]} ${unit}`,
        destructive: true,
      });
      if (!ok) return;
    }
    this.busy.set(verb);
    this.#http.post<ServiceActionAnswer>(`/api/services/${encodeURIComponent(id)}/${verb}`, {}).subscribe({
      next: ({ at }) => {
        this.busy.set(null);
        this.#feedback.ok(
          at ? `${LABELS[verb]} of ${unit} at ${new Date(at).toLocaleTimeString('en-GB')}: players are warned in game.` : `${LABELS[verb]} sent to ${unit}.`,
        );
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(null);
        this.#feedback.failed(`${LABELS[verb]} of ${unit}`, err);
      },
    });
  }
}

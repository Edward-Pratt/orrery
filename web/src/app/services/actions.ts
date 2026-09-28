import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, Injectable, input, signal } from '@angular/core';
import type { ServiceActionAnswer, ServiceStatus, ServiceVerb } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { Feedback } from '../feedback';

export const LABELS: Record<ServiceVerb, string> = { start: 'Start', stop: 'Stop', restart: 'Restart' };

/**
 * Sends a service's start, stop or restart: Stop and Restart ask first, and the outcome is a toast. `name` is what the
 * dialog and toast call the target (the unit, or the server that runs as it). One request in flight at a time.
 */
@Injectable({ providedIn: 'root' })
export class ServiceControl {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly busy = signal<{ id: string; verb: ServiceVerb } | null>(null);

  async act(verb: ServiceVerb, id: string, name: string): Promise<void> {
    if (this.busy()) return;
    // Starting harms nothing; the rest can disconnect players.
    if (verb !== 'start') {
      const ok = await this.#feedback.confirm({
        title: `${LABELS[verb]} ${name}?`,
        description: verb === 'stop' ? `${name} stays down until it's started again.` : `${name} is briefly down while it restarts.`,
        verb: `${LABELS[verb]} ${name}`,
        destructive: true,
      });
      if (!ok) return;
    }
    this.busy.set({ id, verb });
    this.#http.post<ServiceActionAnswer>(`/api/services/${encodeURIComponent(id)}/${verb}`, {}).subscribe({
      next: ({ at }) => {
        this.busy.set(null);
        this.#feedback.ok(
          at ? `${LABELS[verb]} of ${name} at ${new Date(at).toLocaleTimeString('en-GB')}: players are warned in game.` : `${LABELS[verb]} sent to ${name}.`,
        );
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(null);
        this.#feedback.failed(`${LABELS[verb]} of ${name}`, err);
      },
    });
  }
}

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
  readonly #control = inject(ServiceControl);
  readonly service = input.required<ServiceStatus>();
  protected readonly verbs: ServiceVerb[] = ['start', 'stop', 'restart'];
  protected readonly labels = LABELS;
  /** The verb in flight on this service, so it can't be sent twice. */
  readonly busy = computed(() => {
    const b = this.#control.busy();
    return b?.id === this.service().id ? b.verb : null;
  });

  act(verb: ServiceVerb): Promise<void> {
    const { id, unit } = this.service();
    return this.#control.act(verb, id, unit);
  }
}

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import type { ServiceActionAnswer, ServiceVerb } from '@hub/api';
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

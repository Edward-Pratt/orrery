import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { ServerCard, ServerDetail, ServiceStatus } from '@hub/api';
import { filter } from 'rxjs';
import { LiveEvents, ofTarget } from '../events';
import { ServiceActions } from '../services/actions';

/** The server page's sections (child routes), each shown only when the server has what it needs. */
const SECTIONS: { path: string; label: string; has: (c: ServerCard) => boolean }[] = [
  { path: '', label: 'Overview', has: () => true },
  { path: 'chat', label: 'Chat', has: (c) => c.features.chat },
];

/** A server's page: its name, state and linked service, then its sections, which read the detail from here. */
@Component({
  selector: 'app-server',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, ServiceActions],
  template: `
    <a routerLink=".." class="text-sm text-muted-foreground hover:underline">← Servers</a>
    @if (missing(); as why) {
      <p class="pt-8">{{ why }}</p>
    } @else if (card(); as c) {
      <h1 class="mt-2 mb-4 text-lg font-semibold">{{ c.name }} <span class="text-sm font-normal text-muted-foreground">{{ c.online ? 'Online' : 'Offline' }}</span></h1>
      @if (service(); as s) {
        <section class="mb-4 max-w-3xl rounded-lg border p-4" data-service-actions>
          <h2 class="mb-1 text-sm font-semibold">Service {{ s.unit }} <span class="font-normal text-muted-foreground">{{ s.state }} ({{ s.sub }})</span></h2>
          <p class="mb-3 text-sm text-muted-foreground">The systemd unit this server runs as. Stopping it keeps the server down; with players online they get a countdown first.</p>
          <app-service-actions [service]="s" />
        </section>
      }
      <nav class="mb-4 flex gap-4 border-b text-sm" data-sections>
        @for (s of sections; track s.path) {
          @if (s.has(c)) {
            <a [routerLink]="s.path" routerLinkActive="border-b-2 border-foreground font-semibold" [routerLinkActiveOptions]="{ exact: true }" class="-mb-px pb-2 hover:underline">{{ s.label }}</a>
          }
        }
      </nav>
      <router-outlet />
    }
  `,
})
export default class ServerPage {
  protected readonly sections = SECTIONS;
  readonly #http = inject(HttpClient);
  readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id')!;
  /** Set before any section is shown. */
  readonly card = signal<ServerCard | undefined>(undefined);
  /** The service this server runs as, if linked. */
  readonly service = signal<ServiceStatus | null>(null);
  /** Why the server can't be shown: unknown, or the hub didn't answer. */
  readonly missing = signal<string | null>(null);

  constructor() {
    this.#http.get<ServerDetail>(`/api/servers/${encodeURIComponent(this.id)}`).subscribe({
      next: (detail) => {
        this.card.set(detail.card);
        this.service.set(detail.service);
      },
      error: (err: HttpErrorResponse) =>
        this.missing.set(err.status === 404 ? 'No such server.' : `The hub didn't answer (HTTP ${err.status}). Reload to try again.`),
    });
    inject(LiveEvents)
      .all$.pipe(filter(ofTarget('service')), takeUntilDestroyed())
      .subscribe(({ event }) => {
        if (event.type === 'state' && event.id === this.service()?.id) {
          const { state, sub } = event;
          this.service.update((s) => s && { ...s, state, sub });
        }
      });
  }
}

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { ServerCard, ServerDetail, ServiceStatus } from '@hub/api';
import { catchError, debounceTime, EMPTY, startWith, Subject, switchMap } from 'rxjs';
import { LiveEvents, ofServer, ofTarget } from '../events';
import { changesCard } from './cards';
import { ServiceActions } from '../services/actions';

/** The server page's sections (child routes), each shown only when the server has what it needs. */
const SECTIONS: { path: string; label: string; has: (c: ServerCard) => boolean }[] = [
  { path: '', label: 'Overview', has: () => true },
  { path: 'chat', label: 'Chat', has: (c) => c.features.chat },
  { path: 'console', label: 'Console', has: (c) => c.features.chat },
  { path: 'history', label: 'History', has: () => true },
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
      <div class="mt-2 mb-4 flex items-baseline justify-between gap-4">
        <h1 class="text-lg font-semibold">{{ c.name }} <span class="text-sm font-normal text-muted-foreground">{{ c.online ? 'Online' : 'Offline' }}</span></h1>
        <a routerLink="/audit" [queryParams]="{ server: id }" class="text-sm text-muted-foreground hover:underline" data-audit>Audit log</a>
      </div>
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
  /** Set before any section is shown, and fetched again when an event changes it. */
  readonly detail = signal<ServerDetail | undefined>(undefined);
  readonly card = computed(() => this.detail()?.card);
  /** The service this server runs as, if linked. */
  readonly service = signal<ServiceStatus | null>(null);
  /** Why the server can't be shown: unknown, or the hub didn't answer. */
  readonly missing = signal<string | null>(null);

  readonly #refetch = new Subject<void>();

  constructor() {
    // Debounced: the stream's replay can hold many changes at once.
    this.#refetch
      .pipe(
        debounceTime(50),
        startWith(undefined),
        switchMap(() =>
          this.#http.get<ServerDetail>(`/api/servers/${encodeURIComponent(this.id)}`).pipe(
            catchError((err: HttpErrorResponse) => {
              if (!this.detail()) {
                this.missing.set(err.status === 404 ? 'No such server.' : `The hub didn't answer (HTTP ${err.status}). Reload to try again.`);
              }
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((detail) => {
        this.detail.set(detail);
        this.service.set(detail.service);
      });
    // One stream: each subscription opens its own.
    inject(LiveEvents)
      .all$.pipe(takeUntilDestroyed())
      .subscribe((live) => {
        if (ofServer(this.id)(live)) {
          const e = live.event;
          if (changesCard(e) || (e.type === 'notice' && e.kind.startsWith('backup'))) this.refresh();
        } else if (ofTarget('service')(live)) {
          const e = live.event;
          if (e.type === 'state' && e.id === this.service()?.id) this.service.update((s) => s && { ...s, state: e.state, sub: e.sub });
        }
      });
  }

  /** Fetches the detail again, e.g. after an action changed it. */
  refresh(): void {
    this.#refetch.next();
  }
}

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { ServerDetail, ServiceStatus } from '@hub/api';
import { catchError, debounceTime, EMPTY, startWith, Subject, switchMap } from 'rxjs';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { LiveEvents, ofServer, ofTarget } from '../events';
import { changesCard } from './cards';
import { serverState, Status } from '../status';
import { ServerActions } from './actions';

/** The server page's tabs (child routes), each shown only when the server has what it needs. */
const SECTIONS: { path: string; label: string; has: (d: ServerDetail) => boolean }[] = [
  { path: '', label: 'Overview', has: () => true },
  { path: 'console', label: 'Console', has: (d) => d.card.features.chat },
  { path: 'chat', label: 'Chat', has: (d) => d.card.features.chat },
  { path: 'players', label: 'Players', has: () => true },
  { path: 'history', label: 'History', has: () => true },
  { path: 'backups', label: 'Backups', has: (d) => d.backups.configured },
];

/** A server's page: header (name, state, linked service, actions), tabs, and the sections, which read the detail from here. */
@Component({
  selector: 'app-server',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, ServerActions, Status, HlmSkeleton],
  template: `
    <a routerLink=".." class="text-sm text-muted-foreground hover:underline">← Servers</a>
    @if (missing(); as why) {
      <p class="pt-8">{{ why }}</p>
    } @else if (card(); as c) {
      <header class="mt-2 mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="flex items-center gap-3 text-lg font-semibold">
            {{ c.name }}
            <app-status data-state [health]="state().health" [label]="state().label" class="text-sm font-normal" />
          </h1>
          @if (service(); as s) {
            <p class="text-sm text-muted-foreground" data-service-line>runs as {{ s.unit }}, {{ s.state }}</p>
          }
        </div>
        <app-server-actions [card]="c" [full]="true" (changed)="refresh()" />
      </header>
      <nav class="mb-4 flex gap-4 border-b text-sm" data-sections>
        @for (s of sections; track s.path) {
          @if (s.has(detail()!)) {
            <a [routerLink]="s.path" routerLinkActive="border-b-2 border-foreground font-semibold" [routerLinkActiveOptions]="{ exact: true }" class="-mb-px pb-2 hover:underline">{{ s.label }}</a>
          }
        }
      </nav>
      <router-outlet />
    } @else {
      <div class="mt-2 mb-4 flex flex-col gap-3" data-skeleton>
        <hlm-skeleton class="h-7 w-64" />
        <hlm-skeleton class="h-9 w-full max-w-md" />
      </div>
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
  protected readonly state = computed(() => serverState(this.card()!));
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

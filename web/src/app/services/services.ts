import { NgTemplateOutlet } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, DestroyRef, inject, signal, WritableSignal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { CheckStatus, Integrations as IntegrationsOn, ServerCard, ServiceLogs, ServiceStatus, ServiceVerb } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEllipsis } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { catchError, debounceTime, EMPTY, Observable, of, startWith, Subject, Subscription, switchMap } from 'rxjs';
import { LiveEvents, ofTarget } from '../events';
import { Integrations } from '../integrations';
import { ServerActions } from '../servers/actions';
import { changesCard } from '../servers/cards';
import { Health, Status } from '../status';
import { ServiceControl } from './actions';

/** A unit in one of these states is stopped: Start is its primary action, Restart otherwise. */
const STOPPED = [null, 'inactive', 'failed'];
const HEALTH: Record<string, Health> = { active: 'ok', reloading: 'ok', activating: 'warn', deactivating: 'warn' };

/**
 * Services and their checks in one list (or, with systemd off, just the checks, titled "Checks"). A service that runs
 * a server links to it and offers that server's actions (`ServerActions`, as its page header does). Each source is
 * fetched only with its integration on, and kept current by the live stream.
 */
@Component({
  selector: 'app-services',
  imports: [NgTemplateOutlet, RouterLink, NgIcon, HlmButton, HlmDropdownMenuImports, HlmSheetImports, HlmSkeleton, HlmSpinner, Status, ServerActions],
  viewProviders: [provideIcons({ lucideEllipsis })],
  template: `
    <h1 class="mb-4 text-lg font-semibold">{{ title() }}</h1>
    @if (ready()) {
      <div class="flex flex-col gap-2">
        @for (s of services(); track s.id) {
          <div class="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:gap-4" [id]="s.id" [attr.data-service]="s.id">
            <div class="min-w-0 sm:w-64">
              <span class="font-medium">{{ s.id }}</span>
              <span class="ml-2 text-sm text-muted-foreground">{{ s.unit }}</span>
              <div><app-status data-state [health]="health(s)" [label]="s.state ?? 'unknown'" class="text-sm" /></div>
            </div>
            <div class="flex flex-1 flex-wrap gap-1.5" data-checks>
              @for (c of checksOf(s); track c.id) {
                <ng-container [ngTemplateOutlet]="chip" [ngTemplateOutletContext]="{ $implicit: c }" />
              }
            </div>
            @if (serverOf(s); as server) {
              <a class="text-sm text-muted-foreground hover:underline" data-runs [routerLink]="['/servers', server.id]">runs {{ server.name }} →</a>
              <app-server-actions [card]="server" [full]="true" (changed)="refetchCards.next()" />
            } @else {
              <div class="flex items-center gap-2" data-actions>
                @if (stopped(s)) {
                  <button hlmBtn size="sm" data-action="start" [disabled]="!!control.busy()" (click)="act('start', s)">
                    @if (busy(s) === 'start') {
                      <hlm-spinner />
                    }
                    Start
                  </button>
                } @else {
                  <button hlmBtn variant="outline" size="sm" data-action="restart" [disabled]="!!control.busy()" (click)="act('restart', s)">
                    @if (busy(s) === 'restart') {
                      <hlm-spinner />
                    }
                    Restart
                  </button>
                }
                <button hlmBtn variant="outline" size="sm" aria-label="More actions" data-action="more" [hlmDropdownMenuTrigger]="more">
                  <ng-icon name="lucideEllipsis" />
                </button>
              </div>
              <ng-template #more>
                <div hlmDropdownMenu class="w-40">
                  <button hlmDropdownMenuItem type="button" data-action="stop" (click)="act('stop', s)">Stop</button>
                  <button hlmDropdownMenuItem type="button" data-action="logs" (click)="openLogs(s)">View logs</button>
                </div>
              </ng-template>
            }
          </div>
        }
        @if (standalone().length) {
          @if (services().length) {
            <h2 class="mt-4 text-sm font-medium text-muted-foreground">Standalone checks</h2>
          }
          @for (c of standalone(); track c.id) {
            <div class="flex items-center gap-3 rounded-lg border p-3" [attr.data-standalone]="c.id">
              <span class="font-medium">{{ c.id }}</span>
              <span class="min-w-0 flex-1 truncate text-sm text-muted-foreground">{{ c.url }}</span>
              <ng-container [ngTemplateOutlet]="chip" [ngTemplateOutletContext]="{ $implicit: c }" />
            </div>
          }
        } @else if (!services().length) {
          <p class="text-muted-foreground">Nothing to show: list units under "systemd" and URLs under "checks" in the hub's config.json.</p>
        }
      </div>
    } @else {
      <div class="flex flex-col gap-2" data-skeleton>
        @for (i of [1, 2, 3]; track i) {
          <hlm-skeleton class="h-16 w-full" />
        }
      </div>
    }

    <ng-template #chip let-c>
      <span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs" [attr.data-check]="c.id" [attr.title]="c.url">
        {{ c.id }}
        @if (c.up === null) {
          <span class="text-muted-foreground">not checked yet</span>
        } @else if (c.up) {
          <span class="text-status-ok">✓</span> {{ c.ms }} ms
        } @else {
          <span class="text-status-down">✗ {{ c.error }}</span>
        }
      </span>
    </ng-template>

    @if (logsFor(); as s) {
      <hlm-sheet side="right" state="open" (closed)="logsFor.set(null)">
        <hlm-sheet-content *hlmSheetPortal="let ctx" class="data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
          <hlm-sheet-header>
            <h2 hlmSheetTitle>{{ s.unit }} logs</h2>
          </hlm-sheet-header>
          <div class="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
            <div>
              <button hlmBtn variant="outline" size="sm" data-refresh [disabled]="loadingLogs()" (click)="fetchLogs(s)">
                @if (loadingLogs()) {
                  <hlm-spinner />
                }
                Refresh
              </button>
            </div>
            @if (logsError(); as e) {
              <p class="text-sm text-destructive" role="alert" data-logs-error>{{ e }}</p>
            }
            @if (logs(); as lines) {
              <pre class="min-h-0 flex-1 overflow-auto rounded-md bg-muted p-3 font-mono text-xs" data-logs>{{ lines.join('\\n') || 'No log lines.' }}</pre>
            }
          </div>
        </hlm-sheet-content>
      </hlm-sheet>
    }
  `,
})
export default class Services {
  readonly #http = inject(HttpClient);
  readonly #destroyRef = inject(DestroyRef);
  readonly #events = inject(LiveEvents);
  protected readonly control = inject(ServiceControl);
  readonly #on$ = inject(Integrations).on$.pipe(catchError(() => EMPTY));
  readonly #on = toSignal(this.#on$);
  /** Each is null until its first fetch (which shows the skeleton), and empty when its integration is off. */
  readonly #services = signal<ServiceStatus[] | null>(null);
  readonly #checks = signal<CheckStatus[] | null>(null);
  readonly #cards = signal<ServerCard[] | null>(null);
  readonly #refetchServices = new Subject<void>();
  /** Also asked for by a listed server's actions. */
  protected readonly refetchCards = new Subject<void>();

  protected readonly services = computed(() => this.#services() ?? []);
  protected readonly title = computed(() => (this.#on() ? (this.#on()!.systemd ? 'Services' : 'Checks') : ''));
  protected readonly ready = computed(() => !!this.#services() && !!this.#checks() && !!this.#cards());
  /** Checks no listed service shows: all of them without systemd. */
  protected readonly standalone = computed(() => {
    const linked = new Set(this.services().flatMap((s) => s.checks));
    return (this.#checks() ?? []).filter((c) => !linked.has(c.id));
  });

  /** The service whose logs are open, its lines (null until fetched), and why they couldn't be fetched. */
  protected readonly logsFor = signal<ServiceStatus | null>(null);
  protected readonly logs = signal<string[] | null>(null);
  protected readonly logsError = signal<string | null>(null);
  protected readonly loadingLogs = signal(false);
  #logsRequest?: Subscription;

  constructor() {
    this.#on$.pipe(takeUntilDestroyed()).subscribe((on) => this.#start(on));
  }

  #start(on: IntegrationsOn): void {
    // Debounced: the stream's replay can hold several changes at once. A failed first fetch ends its skeleton.
    const fetching = <T>(refetch: Observable<void>, url: string, into: WritableSignal<T[] | null>) =>
      refetch
        .pipe(
          debounceTime(50),
          startWith(undefined),
          switchMap(() =>
            this.#http.get<T[]>(url).pipe(
              catchError(() => {
                into.update((v) => v ?? []);
                return EMPTY;
              }),
            ),
          ),
          takeUntilDestroyed(this.#destroyRef),
        )
        .subscribe((v) => into.set(v));
    if (on.systemd) fetching(this.#refetchServices, '/api/services', this.#services);
    else this.#services.set([]);
    if (on.minecraft) fetching(this.refetchCards, '/api/servers', this.#cards);
    else this.#cards.set([]);
    if (on.checks) {
      this.#http
        .get<CheckStatus[]>('/api/checks')
        .pipe(catchError(() => of<CheckStatus[]>([])))
        .subscribe((v) => this.#checks.set(v));
    } else this.#checks.set([]);
    this.#events.all$.pipe(takeUntilDestroyed(this.#destroyRef))
      .subscribe((live) => {
        const { event } = live;
        if (ofTarget('service')(live)) {
          this.#refetchServices.next();
          if (event.type === 'state') this.refetchCards.next(); // a card carries its service's state
        } else if (ofTarget('check')(live)) {
          if (event.type === 'checked') this.#checks.update((checks) => checks?.map((c) => (c.id === event.id ? event.status : c)) ?? null);
        } else if (changesCard(event)) this.refetchCards.next();
      });
  }

  protected health = (s: ServiceStatus): Health => HEALTH[s.state ?? ''] ?? (s.state === null ? 'warn' : 'down');
  protected stopped = (s: ServiceStatus) => STOPPED.includes(s.state);
  protected checksOf = (s: ServiceStatus) => (this.#checks() ?? []).filter((c) => s.checks.includes(c.id));
  /** The server this service runs, if any. */
  protected serverOf = (s: ServiceStatus) => this.#cards()?.find((c) => c.service?.id === s.id);
  protected busy = (s: ServiceStatus) => {
    const b = this.control.busy();
    return b?.id === s.id ? b.verb : null;
  };

  protected act(verb: ServiceVerb, s: ServiceStatus): void {
    void this.control.act(verb, s.id, s.unit);
  }

  protected openLogs(s: ServiceStatus): void {
    this.logsFor.set(s);
    this.logs.set(null);
    this.logsError.set(null);
    this.fetchLogs(s);
  }

  protected fetchLogs(s: ServiceStatus): void {
    this.loadingLogs.set(true);
    this.#logsRequest?.unsubscribe(); // a slower answer for another service must not land on this sheet
    this.#logsRequest = this.#http.get<ServiceLogs>(`/api/services/${encodeURIComponent(s.id)}/logs`).subscribe({
      next: ({ lines }) => {
        this.loadingLogs.set(false);
        this.logsError.set(null);
        this.logs.set(lines);
      },
      error: (err: HttpErrorResponse) => {
        this.loadingLogs.set(false);
        this.logsError.set(`No logs for ${s.id} (HTTP ${err.status}): ${typeof err.error === 'string' ? err.error : ''}`);
      },
    });
  }
}

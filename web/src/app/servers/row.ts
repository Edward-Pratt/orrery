import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, DestroyRef, inject, input, output, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { RestartRequest, ServerCard } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEllipsis, lucideTerminal } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { Feedback } from '../feedback';
import { ServiceControl } from '../services/actions';
import { Status, type Health } from '../status';
import { formatDuration } from '../units';

/** The countdown a row's Restart starts, in minutes. */
const RESTART_MINUTES = 5;

/** A linked service in one of these states can't be started now, and why. */
const START_BLOCKED: Record<string, string> = { active: 'Service running', activating: 'Starting', reloading: 'Service running', deactivating: 'Stopping' };

/**
 * One server on the overview: its state, numbers and the actions that state allows (Restart and Console online, Start
 * offline, the countdown and Cancel while a restart is pending). A linked server's Start and Stop are its service's.
 * Tapping the row outside its buttons opens the server page. `changed` asks the page to fetch the cards again.
 */
@Component({
  selector: 'app-server-row',
  imports: [DatePipe, DecimalPipe, PercentPipe, RouterLink, NgIcon, HlmButton, HlmDropdownMenuImports, HlmSpinner, Status],
  viewProviders: [provideIcons({ lucideEllipsis, lucideTerminal })],
  template: `
    @let c = card();
    <div
      class="flex cursor-pointer flex-col gap-2 rounded-lg border p-3 hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-4"
      [attr.data-server]="c.id"
      (click)="open($event)"
    >
      <div class="flex min-w-0 items-center justify-between gap-3 sm:w-64 sm:justify-start">
        <a [routerLink]="c.id" class="truncate font-medium hover:underline">{{ c.name }}</a>
        <app-status data-state [health]="health()" [label]="label()" class="text-sm" />
      </div>
      <dl class="flex flex-wrap gap-x-4 text-sm text-muted-foreground sm:flex-1">
        @if (c.features.tps) {
          <div class="flex gap-1"><dt>TPS</dt><dd data-tps class="text-foreground">{{ c.tps === null ? '–' : (c.tps | number: '1.1-1') }}</dd></div>
        }
        <div class="flex gap-1"><dt>Players</dt><dd data-players class="text-foreground" [attr.title]="c.players.join(', ')">{{ c.players.length }}</dd></div>
        <div class="flex gap-1"><dt>Uptime 24 h</dt><dd data-uptime class="text-foreground">{{ c.uptimeDay === null ? 'unknown' : (c.uptimeDay | percent: '1.0-1') }}</dd></div>
      </dl>
      <div class="flex items-center gap-2" data-actions>
        @if (c.restart; as r) {
          <span class="text-sm" data-restart-pending>{{ r.stop ? 'Stop' : 'Restart' }} at {{ r.at | date: 'HH:mm:ss' }}, <span class="tabular-nums" data-restart-left>{{ left() }}</span></span>
          <button hlmBtn size="sm" class="flex-1 sm:flex-none" data-action="cancel" [disabled]="!!busy()" (click)="cancel()">
            @if (busy() === 'cancel') {
              <hlm-spinner />
            }
            Cancel
          </button>
        } @else if (c.online) {
          @if (c.features.chat) {
            <button hlmBtn size="sm" class="flex-1 sm:flex-none" data-action="restart" [disabled]="!!busy()" (click)="restart(RESTART_MINUTES)">
              @if (busy() === 'restart') {
                <hlm-spinner />
              }
              Restart
            </button>
            <a hlmBtn variant="outline" size="sm" [routerLink]="[c.id, 'console']" data-action="console" aria-label="Console">
              <ng-icon name="lucideTerminal" class="sm:hidden" /><span class="max-sm:hidden">Console</span>
            </a>
          }
          @if (c.features.chat || c.service) {
            <button hlmBtn variant="outline" size="sm" aria-label="More actions" data-action="more" [hlmDropdownMenuTrigger]="more">
              <ng-icon name="lucideEllipsis" />
            </button>
          }
        } @else if (c.service) {
          @let blocked = startBlocked();
          <button hlmBtn size="sm" class="flex-1 sm:flex-none" data-action="start" [disabled]="!!busy() || !!blocked" (click)="start()">
            @if (busy() === 'start') {
              <hlm-spinner />
            }
            Start
          </button>
          @if (blocked) {
            <span class="text-sm text-muted-foreground" data-blocked>{{ blocked }}</span>
          }
        }
      </div>
    </div>
    <ng-template #more>
      <div hlmDropdownMenu class="w-44">
        @if (card().service) {
          <button hlmDropdownMenuItem type="button" data-action="stop" (click)="stop()">Stop</button>
        }
        @if (card().features.chat) {
          <button hlmDropdownMenuItem type="button" data-action="restart-now" (click)="restartNow()">Restart now</button>
        }
      </div>
    </ng-template>
  `,
})
export class ServerRow {
  readonly #http = inject(HttpClient);
  readonly #router = inject(Router);
  readonly #feedback = inject(Feedback);
  readonly #service = inject(ServiceControl);
  readonly card = input.required<ServerCard>();
  /** After an action (or its failure), to fetch the cards again. */
  readonly changed = output<void>();
  protected readonly RESTART_MINUTES = RESTART_MINUTES;
  readonly #own = signal<'restart' | 'cancel' | null>(null);
  /** The request in flight from this row, so it can't be sent twice. */
  protected readonly busy = computed(() => {
    const s = this.#service.busy();
    return this.#own() ?? (s && s.id === this.card().service?.id ? s.verb : null);
  });
  readonly #now = signal(Date.now());
  protected readonly left = computed(() => {
    const ms = (this.card().restart?.at ?? 0) - this.#now();
    return ms > 500 ? `in ${formatDuration(ms)}` : 'any moment now';
  });
  protected readonly health = computed<Health>(() => {
    const c = this.card();
    return !c.online || c.hung ? 'down' : c.lagging ? 'warn' : 'ok';
  });
  protected readonly label = computed(() => {
    const c = this.card();
    return c.hung ? 'Not responding' : !c.online ? 'Offline' : c.lagging ? 'Lagging' : 'Online';
  });
  protected readonly startBlocked = computed(() => START_BLOCKED[this.card().service?.state ?? ''] ?? null);

  constructor() {
    // ponytail: ticks every second even with nothing pending; cheap next to the rest of the page.
    const tick = setInterval(() => this.#now.set(Date.now()), 1_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  open(e: Event): void {
    if (!(e.target as Element).closest('a, button')) void this.#router.navigate([this.card().id]);
  }

  restart(minutes: number): void {
    const { name } = this.card();
    this.#post('restart', { minutes } satisfies RestartRequest, `Restart of ${name}`, minutes ? `${name} restarts in ${minutes} minutes.` : `${name} is restarting.`);
  }

  async restartNow(): Promise<void> {
    const { name } = this.card();
    const ok = await this.#feedback.confirm({
      title: `Restart ${name} now?`,
      description: `${name} is briefly down while it restarts.`,
      verb: `Restart ${name}`,
      destructive: true,
    });
    if (ok) this.restart(0);
  }

  cancel(): void {
    const { name } = this.card();
    this.#post('restart/cancel', {}, `Cancelling ${name}'s restart`, `${name}'s restart is cancelled.`);
  }

  // The service's state events (and a countdown's restart notices) refetch the cards, so these don't emit `changed`.
  start(): void {
    const { name, service } = this.card();
    void this.#service.act('start', service!.id, name);
  }

  stop(): void {
    const { name, service } = this.card();
    void this.#service.act('stop', service!.id, name);
  }

  #post(path: string, body: object, what: string, done: string): void {
    this.#own.set(path === 'restart' ? 'restart' : 'cancel');
    this.#http.post(`/api/servers/${encodeURIComponent(this.card().id)}/${path}`, body).subscribe({
      next: () => {
        this.#own.set(null);
        this.#feedback.ok(done);
        this.changed.emit();
      },
      error: (err: HttpErrorResponse) => {
        this.#own.set(null);
        this.#feedback.failed(what, err);
        this.changed.emit(); // it may have fired or been cancelled elsewhere
      },
    });
  }
}

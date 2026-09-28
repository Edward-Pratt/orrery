import { DatePipe } from '@angular/common';
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
import { restartLeft } from '../units';

/** The countdown a Restart button starts, in minutes. */
const RESTART_MINUTES = 5;

/** A linked service in one of these states can't be started now, and why. */
const START_BLOCKED: Record<string, string> = { active: 'Service running', activating: 'Starting', reloading: 'Service running', deactivating: 'Stopping' };

/**
 * A server's actions for its state (Restart and Console online, Start offline, the countdown and Cancel while a
 * restart is pending) and a ⋯ menu. A linked server's Start and Stop are its service's. `full` (the server page's
 * header) adds "Restart in…" and "Audit log for this server" to the menu, which is then always there.
 * `changed` asks the page to fetch its card again.
 */
@Component({
  selector: 'app-server-actions',
  imports: [DatePipe, RouterLink, NgIcon, HlmButton, HlmDropdownMenuImports, HlmSpinner],
  viewProviders: [provideIcons({ lucideEllipsis, lucideTerminal })],
  template: `
    @let c = card();
    <div class="relative flex items-center gap-2" data-actions>
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
          <a hlmBtn variant="outline" size="sm" [routerLink]="['/servers', c.id, 'console']" data-action="console" aria-label="Console">
            <ng-icon name="lucideTerminal" class="sm:hidden" /><span class="max-sm:hidden">Console</span>
          </a>
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
      @if (full() || (c.online && !c.restart && (c.features.chat || c.service))) {
        <button hlmBtn variant="outline" size="sm" aria-label="More actions" data-action="more" [hlmDropdownMenuTrigger]="more">
          <ng-icon name="lucideEllipsis" />
        </button>
      }
      @if (asking()) {
        <form class="absolute top-full right-0 z-10 mt-2 flex items-center gap-2 rounded-md border bg-popover p-3 text-sm shadow-md" (submit)="$event.preventDefault(); restartIn(+minutes.value)" data-restart-form>
          <label class="flex items-center gap-2">
            Restart in
            <input #minutes type="number" min="0" max="60" step="1" value="5" class="w-16 rounded-md border px-2 py-1" />
            minutes
          </label>
          <button hlmBtn size="sm" type="submit">Schedule</button>
        </form>
      }
    </div>
    <ng-template #more>
      <div hlmDropdownMenu class="w-48">
        @if (card().service) {
          <button hlmDropdownMenuItem type="button" data-action="stop" (click)="stop()">Stop</button>
        }
        @if (card().features.chat && (full() ? card().online && !card().restart : true)) {
          <button hlmDropdownMenuItem type="button" data-action="restart-now" (click)="restartNow()">Restart now</button>
        }
        @if (full() && card().features.chat && card().online && !card().restart) {
          <button hlmDropdownMenuItem type="button" data-action="restart-in" (click)="asking.set(true)">Restart in…</button>
        }
        @if (full()) {
          <a hlmDropdownMenuItem routerLink="/audit" [queryParams]="{ server: card().id }" data-audit>Audit log for this server</a>
        }
      </div>
    </ng-template>
  `,
})
export class ServerActions {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly #service = inject(ServiceControl);
  readonly card = input.required<ServerCard>();
  readonly full = input(false);
  /** After an action (or its failure), to fetch the card again. */
  readonly changed = output<void>();
  protected readonly RESTART_MINUTES = RESTART_MINUTES;
  /** Whether the "Restart in…" form is open. */
  protected readonly asking = signal(false);
  readonly #own = signal<'restart' | 'cancel' | null>(null);
  /** The request in flight from here, so it can't be sent twice. */
  protected readonly busy = computed(() => {
    const s = this.#service.busy();
    return this.#own() ?? (s && s.id === this.card().service?.id ? s.verb : null);
  });
  readonly #now = signal(Date.now());
  protected readonly left = computed(() => restartLeft(this.card().restart?.at ?? 0, this.#now()));
  protected readonly startBlocked = computed(() => START_BLOCKED[this.card().service?.state ?? ''] ?? null);

  constructor() {
    // ponytail: ticks every second even with nothing pending; cheap next to the rest of the page.
    const tick = setInterval(() => this.#now.set(Date.now()), 1_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  restart(minutes: number): void {
    const { name } = this.card();
    this.#post('restart', { minutes } satisfies RestartRequest, `Restart of ${name}`, minutes ? `${name} restarts in ${minutes} minutes.` : `${name} is restarting.`);
  }

  restartIn(minutes: number): void {
    this.asking.set(false);
    this.restart(minutes);
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

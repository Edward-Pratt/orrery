import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import type { CheckStatus, DeploysAnswer, ServerCard, ServiceStatus } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { catchError, debounceTime, EMPTY, filter, of, startWith, Subject, switchMap, take } from 'rxjs';
import { Feedback } from './feedback';
import { overdue, releaseRows } from './host/release-rows';
import { LiveEvents, ofTarget } from './events';
import { Integrations } from './integrations';
import { Session } from './session';
import { BackupProgress } from './servers/backup-progress';
import { changesCard } from './servers/cards';
import { ServiceControl } from './services/actions';
import { restartLeft } from './units';

/** One thing that needs a human now: what it is about (`page` is the sidebar entry it counts on), and the fix, if any. */
export type AttentionItem = {
  key: string;
  page: 'servers' | 'services' | 'host';
  target: string;
  message: string;
  /** For a pending restart: when it fires, shown as a countdown. */
  at?: number;
  action?: { label: string; run: () => void };
};

/**
 * What needs attention, built from the server cards, services and checks, kept current by the live stream (each
 * source only when its integration is on). Nothing is dismissed: an item goes when its condition clears.
 */
@Injectable({ providedIn: 'root' })
export class Attention {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly #control = inject(ServiceControl);
  readonly #progress = inject(BackupProgress);
  readonly #destroyRef = inject(DestroyRef);
  readonly #events = inject(LiveEvents);
  readonly #cards = signal<ServerCard[]>([]);
  readonly #services = signal<ServiceStatus[]>([]);
  readonly #checks = signal<CheckStatus[]>([]);
  readonly #deploys = signal<DeploysAnswer | null>(null);
  readonly #router = inject(Router);
  readonly #refetchCards = new Subject<void>();
  readonly #refetchServices = new Subject<void>();
  readonly #refetchDeploys = new Subject<void>();

  readonly items = computed<AttentionItem[]>(() => {
    const cards = this.#cards();
    const items: AttentionItem[] = [];
    for (const c of cards) {
      const state = c.service?.state;
      // Offline on purpose (its service inactive, or on its way) is not a problem; failed, or up without the mod, is.
      if (!c.online && (!c.service || state === 'failed' || state === 'active')) {
        const restart = state === 'active';
        items.push({
          key: `offline:${c.id}`,
          page: 'servers',
          target: c.name,
          message: !c.service ? 'is offline' : restart ? 'is offline: its service runs, the mod is not connected' : 'is offline: its service failed',
          action: c.service ? { label: restart ? 'Restart' : 'Start', run: () => void this.#control.act(restart ? 'restart' : 'start', c.service!.id, c.name) } : undefined,
        });
      }
      const doing = this.#progress.running()[c.id];
      if (doing) items.push({ key: `${doing}:${c.id}`, page: 'servers', target: c.name, message: doing === 'backup' ? 'is backing up' : 'is being restored' });
      if (c.online && c.lagging) items.push({ key: `lagging:${c.id}`, page: 'servers', target: c.name, message: 'is lagging' });
      if (c.restart) {
        items.push({
          key: `restart:${c.id}`,
          page: 'servers',
          target: c.name,
          message: c.restart.stop ? 'stops' : 'restarts',
          at: c.restart.at,
          action: { label: 'Cancel', run: () => this.#cancelRestart(c) },
        });
      }
    }
    for (const s of this.#services()) {
      // A server's own failed service is its server's item, while that is offline; an online one has none.
      if (s.state === 'failed' && !cards.some((c) => c.service?.id === s.id && !c.online)) {
        items.push({
          key: `service:${s.id}`,
          page: 'services',
          target: s.unit,
          message: 'failed',
          action: { label: 'Start', run: () => void this.#control.act('start', s.id, s.unit) },
        });
      }
    }
    for (const c of this.#checks()) {
      if (c.up === false) items.push({ key: `check:${c.id}`, page: 'services', target: c.id, message: `is down: ${c.error}` });
    }
    const deploys = this.#deploys();
    for (const r of deploys ? releaseRows(deploys) : []) {
      if (!overdue(r, deploys!)) continue;
      items.push({
        key: `release:${r.key}`,
        page: 'host',
        target: r.label,
        message: `can update to ${r.latest}`,
        action: { label: 'Releases', run: () => void this.#router.navigate(['/host'], { fragment: 'releases' }) },
      });
    }
    return items;
  });
  /** How many items each sidebar entry shows. */
  readonly count = (page: AttentionItem['page']) => this.items().filter((i) => i.page === page).length;

  constructor() {
    const on$ = inject(Integrations).on$;
    // Only once logged in, and only for the integrations that are on.
    toObservable(inject(Session).user)
      .pipe(
        filter(Boolean),
        take(1),
        switchMap(() => on$.pipe(catchError(() => of(undefined)))),
        take(1),
        takeUntilDestroyed(),
      )
      .subscribe((on) => on && this.#start(on));
  }

  #start(on: { minecraft: boolean; systemd: boolean; checks: boolean; github: boolean }): void {
    // Debounced: the stream's replay can hold many changes at once.
    const fetching = <T>(refetch: Subject<void>, url: string, into: (v: T) => void) =>
      refetch
        .pipe(debounceTime(50), startWith(undefined), switchMap(() => this.#http.get<T>(url).pipe(catchError(() => EMPTY))), takeUntilDestroyed(this.#destroyRef))
        .subscribe(into);
    if (on.minecraft) fetching<ServerCard[]>(this.#refetchCards, '/api/servers', (v) => this.#cards.set(v));
    if (on.systemd) fetching<ServiceStatus[]>(this.#refetchServices, '/api/services', (v) => this.#services.set(v));
    if (on.github) fetching<DeploysAnswer>(this.#refetchDeploys, '/api/deploys', (v) => this.#deploys.set(v));
    if (on.checks) this.#http.get<CheckStatus[]>('/api/checks').pipe(catchError(() => EMPTY)).subscribe((v) => this.#checks.set(v));
    this.#events.all$.pipe(takeUntilDestroyed(this.#destroyRef))
      .subscribe((live) => {
        const { event } = live;
        this.#progress.seen(event);
        if (ofTarget('service')(live) && event.type === 'state') {
          this.#refetchServices.next();
          this.#refetchCards.next(); // a card carries its service's state
        } else if (ofTarget('check')(live) && event.type === 'checked') {
          this.#checks.update((checks) => checks.map((c) => (c.id === event.id ? event.status : c)));
        } else if (ofTarget('deploy')(live)) this.#refetchDeploys.next();
        else if (changesCard(event)) this.#refetchCards.next();
      });
  }

  #cancelRestart({ id, name }: ServerCard): void {
    this.#http.post(`/api/servers/${encodeURIComponent(id)}/restart/cancel`, {}).subscribe({
      next: () => this.#feedback.ok(`${name}'s restart is cancelled.`),
      error: (err: HttpErrorResponse) => {
        this.#feedback.failed(`Cancelling ${name}'s restart`, err);
        this.#refetchCards.next(); // it may have fired or been cancelled elsewhere
      },
    });
  }
}

/** The amber strip above every page: one line per item with its fix beside it; hidden when there are none. */
@Component({
  selector: 'app-attention-strip',
  imports: [DatePipe, HlmButton],
  template: `
    @if (attention.items().length) {
      <ul class="border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm md:px-10" data-attention>
        @for (i of attention.items(); track i.key) {
          <li class="flex items-center gap-3 py-0.5" [attr.data-item]="i.key">
            <span class="min-w-0 flex-1 truncate">
              <b>{{ i.target }}</b> {{ i.message }}
              @if (i.at) {
                at {{ i.at | date: 'HH:mm:ss' }}, {{ left(i.at) }}
              }
            </span>
            @if (i.action; as a) {
              <button hlmBtn variant="outline" size="sm" data-fix (click)="a.run()">{{ a.label }}</button>
            }
          </li>
        }
      </ul>
    }
  `,
})
export class AttentionStrip {
  protected readonly attention = inject(Attention);
  readonly #now = signal(Date.now());

  constructor() {
    // ponytail: ticks every second even with nothing pending; cheap.
    const tick = setInterval(() => this.#now.set(Date.now()), 1_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  protected left(at: number): string {
    return restartLeft(at, this.#now());
  }
}

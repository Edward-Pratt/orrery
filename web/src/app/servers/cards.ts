import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { PendingServers, ServerCard } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arCircleAlert, arPlus } from '@armil/icons';
import { catchError, debounceTime, EMPTY, filter, of, startWith, Subject, switchMap } from 'rxjs';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { LiveEvents, ofTarget } from '../events';
import { Integrations } from '../integrations';
import { Session } from '../session';
import { changesCard } from './changes';
import { NewServer } from './new-server';
import { ServerRow } from './row';

@Component({
  selector: 'app-cards',
  imports: [RouterLink, NgIcon, HlmBadge, HlmButton, HlmSkeleton, HlmSpinner, NewServer, ServerRow],
  viewProviders: [provideIcons({ arCircleAlert, arPlus })],
  template: `
    <div class="mb-4 flex items-center gap-3">
      <h1 class="ar-t-heading-md">Servers</h1>
      @if (newServer()) {
        <button hlmBtn size="sm" class="ml-auto" [disabled]="!!pending()?.installing" (click)="sheet.set(true)" data-new-server>
          <ng-icon name="arPlus" /> New server
        </button>
      }
    </div>
    @if (pending()?.installing; as i) {
      <div class="ar-panel mb-2 flex items-center gap-3 p-4 text-sm" data-installing>
        <hlm-spinner />
        <span class="min-w-0 flex-1">
          Installing <b>{{ i.name }}</b><span class="text-muted-foreground"> (by {{ i.by }})</span>
          <span class="block text-xs text-muted-foreground" data-detail>{{ i.detail }}</span>
        </span>
      </div>
    }
    @if (failed(); as f) {
      <div class="ar-callout ar-callout--danger mb-2 flex items-center gap-3 text-sm" data-install-failed>
        <ng-icon name="arCircleAlert" class="text-status-down" />
        <span>Installing {{ f.name }} failed: {{ f.why }}</span>
      </div>
    }
    <div class="ar-tiles server-tiles">
      @if (cards(); as list) {
        @for (c of list; track c.id) {
          <app-server-row [card]="c" (changed)="refetch.next()" />
        } @empty {
          @if (!pending()?.pending?.length) {
            <p class="col-span-full text-muted-foreground">No servers yet: add one under "servers" in the hub's config.json.</p>
          }
        }
        @for (p of pending()?.pending ?? []; track p.id) {
          <a
            [routerLink]="['/servers', 'waiting', p.id]"
            class="ar-tile"
            [attr.data-pending]="p.id"
          >
            <span class="ar-t-ui-strong">{{ p.name }}</span>
            <span hlmBadge variant="outline" class="ar-tag--warn">Waiting for setup</span>
            <span class="ar-tile__line">port {{ p.gamePort }}: run the setup command →</span>
          </a>
        }
      } @else {
        <div class="contents" data-skeleton>
          @for (i of [1, 2, 3]; track i) {
            <hlm-skeleton class="h-36 w-full" />
          }
        </div>
      }
    </div>
    @if (sheet()) {
      @defer {
        <app-new-server (closed)="sheet.set(false)" (started)="started()" />
      } @error {
        <!-- a deploy replaced the build under this open page, so the sheet's chunk is gone -->
        <p class="text-sm text-muted-foreground" data-stale>A new dashboard was deployed: <a href="" class="underline">reload</a> to add a server.</p>
      }
    }
  `,
  // Server tiles hold up to three readouts and the actions, so they start wider than Armil's 200px tiles.
  styles: `
    .server-tiles {
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
    }
  `,
})
export default class Cards {
  /** Whether New server is offered (Minecraft, GitHub and the library on, and the user holds `library`), with the Pending servers. */
  protected readonly newServer = signal(false);
  /** The Pending servers and the running install; null without New server. */
  readonly pending = signal<PendingServers | null>(null);
  /** The last install watched here that failed, and why. */
  protected readonly failed = signal<{ name: string; why: string } | null>(null);
  protected readonly sheet = signal(false);
  readonly #refetchPending = new Subject<void>();
  /** Null until the first fetch, which shows the skeleton. */
  readonly cards = signal<ServerCard[] | null>(null);
  /** Fetches the cards again. */
  protected readonly refetch = new Subject<void>();

  constructor() {
    const http = inject(HttpClient);
    const refetch = this.refetch;
    // Debounced: the stream's replay can hold many joins and leaves at once.
    refetch
      .pipe(
        debounceTime(50),
        startWith(undefined),
        switchMap(() => http.get<ServerCard[]>('/api/servers').pipe(catchError(() => {
          this.cards.update((c) => c ?? []); // a first fetch that fails ends the skeleton
          return EMPTY;
        }))),
        takeUntilDestroyed(),
      )
      .subscribe((cards) => this.cards.set(cards));
    inject(LiveEvents)
      .all$.pipe(takeUntilDestroyed())
      .subscribe((live) => {
        const { event } = live;
        if (event.type === 'tps') {
          this.cards.update((cards) =>
            cards?.map((c) => (c.id === event.serverId && c.features.tps ? { ...c, tps: event.tps } : c)) ?? null,
          );
        } else if (changesCard(event) || (ofTarget('service')(live) && event.type === 'state')) refetch.next();
        else if (event.type === 'install') {
          if (event.step === 'failed') this.failed.set({ name: event.name, why: event.detail });
          else if (event.step === 'unpack') this.failed.set(null);
          this.#refetchPending.next();
        }
      });
    const session = inject(Session);
    inject(Integrations)
      .on$.pipe(
        catchError(() => EMPTY),
        filter((on) => on.newServer && session.can('library')),
        switchMap(() => {
          this.newServer.set(true);
          return this.#refetchPending.pipe(
            debounceTime(50),
            startWith(undefined),
            switchMap(() => http.get<PendingServers>('/api/servers/pending').pipe(catchError(() => of(null)))),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((p) => p && this.pending.set(p));
  }

  protected started(): void {
    this.sheet.set(false);
    this.failed.set(null);
    this.#refetchPending.next();
  }
}

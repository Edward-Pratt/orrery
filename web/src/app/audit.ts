import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { AuditLog, ServerCard } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { catchError, of, switchMap, tap } from 'rxjs';

type Entry = AuditLog['entries'][number];

/**
 * The audit log: what was done from Discord, the dashboard or by the hub itself, newest first. `?server=` and
 * `?actor=` filter it (the server page links with the first); "Load older" pages back from the last entry shown.
 */
@Component({
  selector: 'app-audit',
  imports: [DatePipe, HlmButton, HlmInput, HlmSkeleton, HlmSpinner],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Audit log</h1>
    <div class="mb-4 flex flex-wrap items-end gap-4 text-sm">
      <label class="flex flex-col gap-1">
        Server
        <select class="h-9 rounded-md border bg-background px-2" (change)="filter({ server: $any($event.target).value })" data-server-filter>
          <option value="">All</option>
          @for (s of servers(); track s.id) {
            <option [value]="s.id" [selected]="s.id === server()">{{ s.name }}</option>
          }
        </select>
      </label>
      <label class="flex flex-col gap-1">
        Who
        <input
          hlmInput
          class="w-64"
          list="audit-actors"
          placeholder="discord:alice (123)"
          autocomplete="off"
          [value]="actor()"
          (change)="filter({ actor: $any($event.target).value.trim() })"
          data-actor-filter
        />
        <datalist id="audit-actors">
          @for (a of actors(); track a) {
            <option [value]="a"></option>
          }
        </datalist>
      </label>
    </div>
    @if (loading()) {
      <div class="flex flex-col gap-2" data-skeleton>
        @for (i of [1, 2, 3, 4, 5]; track i) {
          <hlm-skeleton class="h-9 w-full" />
        }
      </div>
    } @else if (!entries().length) {
      <p class="rounded-lg border border-dashed p-6 text-center text-muted-foreground" data-empty>No entries{{ server() || actor() ? ' for this filter' : ' yet' }}.</p>
    } @else {
      <table class="hidden w-full text-left text-sm md:table">
        <thead class="text-muted-foreground">
          <tr><th class="py-1 pr-4 font-normal">When</th><th class="pr-4 font-normal">Who</th><th class="pr-4 font-normal">What</th><th class="pr-4 font-normal">Which</th><th class="font-normal">Details</th></tr>
        </thead>
        <tbody>
          @for (e of entries(); track e.id) {
            <tr class="border-t" data-entry>
              <td class="py-1 pr-4 whitespace-nowrap">{{ e.ts | date: 'yyyy-MM-dd HH:mm:ss' }}</td>
              <td class="pr-4">{{ e.actor }}</td>
              <td class="pr-4">{{ e.action }}</td>
              <td class="pr-4">{{ e.target }}</td>
              <td class="break-all">{{ e.details }}</td>
            </tr>
          }
        </tbody>
      </table>
      <ul class="flex flex-col gap-2 md:hidden">
        @for (e of entries(); track e.id) {
          <li class="rounded-lg border p-3 text-sm" data-card>
            <div class="flex justify-between gap-2"><b>{{ e.action }} · {{ e.target }}</b><span class="text-muted-foreground">{{ e.ts | date: 'MM-dd HH:mm' }}</span></div>
            <div class="break-all text-muted-foreground">{{ e.actor }}{{ e.details ? ' — ' + e.details : '' }}</div>
          </li>
        }
      </ul>
      @if (older()) {
        <button hlmBtn variant="outline" class="mt-4" [disabled]="paging()" (click)="loadOlder()" data-load-older>
          @if (paging()) {
            <hlm-spinner />
          }
          Load older
        </button>
      }
    }
  `,
})
export default class Audit {
  readonly #router = inject(Router);
  readonly #route = inject(ActivatedRoute);
  readonly #http = inject(HttpClient);
  readonly #params = toSignal(this.#route.queryParamMap);
  readonly server = () => this.#params()?.get('server') ?? '';
  readonly actor = () => this.#params()?.get('actor') ?? '';
  readonly entries = signal<Entry[]>([]);
  readonly older = signal(false);
  readonly loading = signal(true);
  readonly paging = signal(false);
  protected readonly servers = toSignal(this.#http.get<ServerCard[]>('/api/servers').pipe(catchError(() => of([]))), { initialValue: [] });
  /** The people seen in what's loaded, to pick from. */
  protected actors = () => [...new Set(this.entries().map((e) => e.actor))];

  constructor() {
    this.#route.queryParamMap
      .pipe(
        tap(() => (this.loading.set(true), this.entries.set([]))),
        switchMap((p) => this.#fetch(p.get('server'), p.get('actor'))),
        takeUntilDestroyed(),
      )
      .subscribe((log) => {
        this.entries.set(log.entries);
        this.older.set(log.older);
        this.loading.set(false);
      });
  }

  #fetch(server: string | null, actor: string | null, before?: number) {
    const params: Record<string, string> = {};
    if (server) params['server'] = server;
    if (actor) params['actor'] = actor;
    if (before !== undefined) params['before'] = String(before);
    return this.#http.get<AuditLog>('/api/audit', { params }).pipe(catchError(() => of<AuditLog>({ entries: [], older: false })));
  }

  loadOlder(): void {
    const last = this.entries().at(-1);
    if (!last || this.paging()) return;
    this.paging.set(true);
    this.#fetch(this.server(), this.actor(), last.id)
      .subscribe((log) => {
        this.entries.update((e) => [...e, ...log.entries]);
        this.older.set(log.older);
        this.paging.set(false);
      });
  }

  filter(change: { server?: string; actor?: string }): void {
    const { server, actor } = { server: this.server(), actor: this.actor(), ...change };
    void this.#router.navigate([], { relativeTo: this.#route, queryParams: { server: server || null, actor: actor || null } });
  }
}

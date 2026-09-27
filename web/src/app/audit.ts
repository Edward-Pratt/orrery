import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { AuditLog, ServerCard } from '@hub/api';
import { catchError, map, of, switchMap } from 'rxjs';

/** The audit log: what was done from Discord, the dashboard or by the hub itself, newest first; `?server=` filters it. */
@Component({
  selector: 'app-audit',
  imports: [DatePipe],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Audit log</h1>
    <label class="mb-4 flex items-center gap-2 text-sm">
      Server
      <select class="rounded-md border bg-background px-2 py-1" (change)="filter($any($event.target).value)" data-server-filter>
        <option value="">All</option>
        @for (s of servers(); track s.id) {
          <option [value]="s.id" [selected]="s.id === server()">{{ s.name }}</option>
        }
      </select>
    </label>
    <table class="w-full text-left text-sm">
      <thead class="text-muted-foreground">
        <tr><th class="py-1 pr-4 font-normal">When</th><th class="pr-4 font-normal">Who</th><th class="pr-4 font-normal">What</th><th class="pr-4 font-normal">Which</th><th class="font-normal">Details</th></tr>
      </thead>
      <tbody>
        @for (e of entries(); track $index) {
          <tr class="border-t" data-entry>
            <td class="py-1 pr-4 whitespace-nowrap">{{ e.ts | date: 'yyyy-MM-dd HH:mm:ss' }}</td>
            <td class="pr-4">{{ e.actor }}</td>
            <td class="pr-4">{{ e.action }}</td>
            <td class="pr-4">{{ e.target }}</td>
            <td class="break-all">{{ e.details }}</td>
          </tr>
        } @empty {
          <tr><td colspan="5" class="py-2 text-muted-foreground">Nothing yet.</td></tr>
        }
      </tbody>
    </table>
  `,
})
export default class Audit {
  readonly #router = inject(Router);
  readonly #route = inject(ActivatedRoute);
  readonly #http = inject(HttpClient);
  /** The server filtered to, if any. */
  readonly server = toSignal(this.#route.queryParamMap.pipe(map((p) => p.get('server'))));
  readonly entries = toSignal(
    this.#route.queryParamMap.pipe(
      map((p) => p.get('server')),
      switchMap((server) =>
        this.#http.get<AuditLog>('/api/audit', { params: server ? { server } : {} }).pipe(catchError(() => of([]))),
      ),
    ),
    { initialValue: [] },
  );
  protected readonly servers = toSignal(this.#http.get<ServerCard[]>('/api/servers').pipe(catchError(() => of([]))), { initialValue: [] });

  filter(server: string): void {
    void this.#router.navigate([], { relativeTo: this.#route, queryParams: { server: server || null } });
  }
}

// `StatusPage`: the Status page (status.orrery.run, and `/status` on the dashboard's own address), booted on its own by
// `main.ts` with `PUBLIC_CONFIG` when `isStatusPath` holds: no router, no shell, no session, no interceptor, so its one
// request is `GET /api/public/status`, every `POLL_MS`. Each listed server's name, game, state (`Status`), the players
// online and uptime; "Updated … ago". When the hub doesn't answer (any error, a 401 from a hub without the Status page
// too), the last answer stays greyed out under "Can't reach orrery right now"; the next poll tries again. Light or dark
// from `Theme` (the system's, unless this browser picked one on the dashboard).

import { formatPercent } from '@angular/common';
import { HttpClient, provideHttpClient, withFetch } from '@angular/common/http';
import { type ApplicationConfig, Component, computed, inject, LOCALE_ID, provideBrowserGlobalErrorListeners, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import type { PublicServer, PublicStatus } from '@hub/api';
import { catchError, of, switchMap, timer } from 'rxjs';
import { Logo } from '../logo';
import { publicServerState, Status } from '../status';
import { Theme } from '../theme';
import { formatDuration } from '../units';

/** How often the page asks the hub again; the hub keeps its answer 15 s. */
export const POLL_MS = 30_000;
/** How often "Updated … ago" moves on. */
const TICK_MS = 5_000;
const GAMES = { minecraft: 'Minecraft', factorio: 'Factorio' };

/** The Status page's providers: an HTTP client and nothing of the dashboard's. */
export const PUBLIC_CONFIG: ApplicationConfig = { providers: [provideBrowserGlobalErrorListeners(), provideHttpClient(withFetch())] };

/** Whether `path` is the Status page's: `/status`, with or without a trailing slash. */
export const isStatusPath = (path: string): boolean => path.replace(/\/$/, '') === '/status';

@Component({
  selector: 'app-status-page',
  imports: [Logo, Status],
  template: `
    <main class="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-4 py-8 md:py-12">
      <header class="flex items-center gap-3">
        <app-logo class="size-10" />
        <div>
          <h1 class="text-2xl font-bold tracking-tight">orrery</h1>
          <p class="text-sm text-muted-foreground">Server status</p>
        </div>
      </header>
      @if (unreachable()) {
        <p role="status" class="rounded-lg border border-status-down/40 bg-status-down/10 px-4 py-3 text-sm" data-unreachable>
          Can't reach orrery right now.
        </p>
      }
      @if (cards(); as list) {
        <ul class="flex flex-col gap-3" [class.opacity-50]="unreachable()">
          @for (c of list; track c.name) {
            <li class="rounded-xl border bg-card p-4 text-card-foreground" data-server>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <h2 class="font-semibold">{{ c.name }}</h2>
                  <p class="text-sm text-muted-foreground">{{ c.game }}</p>
                </div>
                <app-status [health]="c.look.health" [label]="c.look.label" />
              </div>
              <p class="mt-3 text-sm" data-players>
                @if (c.players.length) {
                  <span class="font-medium">{{ c.players.length }} online:</span> {{ c.players.join(', ') }}
                } @else {
                  <span class="text-muted-foreground">Nobody on</span>
                }
              </p>
              @if (c.uptime) {
                <p class="mt-1 text-xs text-muted-foreground" data-uptime>{{ c.uptime }}</p>
              }
            </li>
          } @empty {
            <li class="text-muted-foreground">No servers are listed.</li>
          }
        </ul>
        <p class="text-xs text-muted-foreground" data-updated>Updated {{ updated() }}</p>
      } @else if (!unreachable()) {
        <p class="text-muted-foreground">Loading…</p>
      }
    </main>
  `,
})
export class StatusPage {
  readonly #locale = inject(LOCALE_ID);
  readonly #answer = signal<PublicStatus | null>(null);
  readonly #at = signal(0);
  readonly #now = signal(Date.now());
  protected readonly unreachable = signal(false);
  protected readonly cards = computed(() => this.#answer()?.servers.map((s) => ({ ...s, game: GAMES[s.game], look: publicServerState(s.state), uptime: this.#uptime(s) })));
  protected readonly updated = computed(() => {
    const ms = this.#now() - this.#at();
    return ms < TICK_MS ? 'just now' : `${formatDuration(ms)} ago`;
  });

  constructor() {
    inject(Theme); // light or dark before the first paint
    inject(Title).setTitle('orrery status');
    const http = inject(HttpClient);
    timer(0, POLL_MS)
      .pipe(
        switchMap(() => http.get<PublicStatus>('/api/public/status').pipe(catchError(() => of(null)))),
        takeUntilDestroyed(),
      )
      .subscribe((answer) => {
        this.unreachable.set(!answer);
        if (!answer) return;
        this.#answer.set(answer);
        this.#at.set(Date.now());
        this.#now.set(Date.now());
      });
    timer(TICK_MS, TICK_MS)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.#now.set(Date.now()));
  }

  /** "99.2% this week · 98.7% this month", leaving out what the hub doesn't know yet. */
  #uptime(s: PublicServer): string {
    const known: [number | null, string][] = [[s.uptimeWeek, 'this week'], [s.uptimeMonth, 'this month']];
    return known
      .filter((k): k is [number, string] => k[0] !== null)
      .map(([share, when]) => `${formatPercent(share, this.#locale, '1.0-1')} ${when}`)
      .join(' · ');
  }
}

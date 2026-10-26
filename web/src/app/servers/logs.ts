import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import type { ServerLog, ServerLogFiles, ServiceLogs } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import type { Subscription } from 'rxjs';
import { formatBytes } from '../units';
import { StickBottom } from './log';
import ServerPage from './server';

/** The file shown first, when the folder has it; else the newest. */
const DEFAULT = 'latest.log';

const why = (err: HttpErrorResponse) => `HTTP ${err.status}${typeof err.error === 'string' && err.error ? `: ${err.error}` : ''}`;

/**
 * A server's Logs section (only with a server folder): its `logs/` files and crash reports, newest first, the chosen
 * one's last 1000 lines (`latest.log` to start), and with a linked service its journal. Nothing follows live:
 * Refresh fetches again.
 */
@Component({
  selector: 'app-server-logs',
  imports: [DatePipe, HlmButton, HlmSkeleton, HlmSpinner, StickBottom],
  template: `
    @if (!server.detail()!.logs) {
      <p class="text-muted-foreground">This server has no server folder, so no logs to show.</p>
    } @else if (files(); as list) {
      <section class="flex max-w-5xl flex-col gap-4">
        @if (list.length) {
          <div class="grid gap-4 lg:grid-cols-[16rem_1fr]">
            <ul class="flex max-h-48 flex-col overflow-y-auto rounded-xl border p-1 text-sm lg:max-h-[calc(100dvh-18rem)]" data-files>
              @for (f of list; track f.name) {
                <li>
                  <button
                    type="button"
                    class="w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
                    [class.bg-muted]="f.name === chosen()"
                    [class.font-semibold]="f.name === chosen()"
                    [attr.aria-current]="f.name === chosen() ? 'true' : null"
                    [attr.data-file]="f.name"
                    (click)="choose(f.name)"
                  >
                    <span class="block truncate font-mono">{{ f.name }}</span>
                    <span class="block text-xs text-muted-foreground">{{ bytes(f.size) }} · {{ f.modified | date: 'd MMM, HH:mm' }}</span>
                  </button>
                </li>
              }
            </ul>
            <div class="flex min-w-0 flex-col gap-2">
              <div class="flex items-center gap-3">
                <h2 class="min-w-0 flex-1 truncate font-mono text-sm font-medium" data-chosen>{{ chosen() }}</h2>
                <button hlmBtn variant="outline" size="sm" data-refresh [disabled]="loading()" (click)="refresh()">
                  @if (loading()) {
                    <hlm-spinner />
                  }
                  Refresh
                </button>
              </div>
              @if (error(); as e) {
                <p class="text-sm text-destructive" role="alert" data-log-error>{{ e }}</p>
              }
              @if (lines(); as ls) {
                <div appStickBottom class="h-[calc(100dvh-20rem)] min-h-72 rounded-md bg-muted p-3 font-mono text-xs" data-log>
                  @for (line of ls; track $index) {
                    <div class="break-all whitespace-pre-wrap" data-line>{{ line }}</div>
                  } @empty {
                    <p class="text-muted-foreground">The file is empty.</p>
                  }
                </div>
              } @else if (!error()) {
                <hlm-skeleton class="h-72 w-full" />
              }
            </div>
          </div>
        } @else {
          <div class="rounded-xl border border-dashed p-8 text-center" data-empty>
            <p class="font-medium">No logs yet</p>
            <p class="text-sm text-muted-foreground">The server's logs/ files and crash reports are listed here once it has written some.</p>
          </div>
        }
        @if (server.service(); as s) {
          <section class="flex flex-col gap-2" data-journal>
            <div class="flex items-center gap-3">
              <h2 class="flex-1 text-sm font-medium">{{ s.unit }} journal</h2>
              <button hlmBtn variant="outline" size="sm" data-journal-refresh [disabled]="loadingJournal()" (click)="fetchJournal()">
                @if (loadingJournal()) {
                  <hlm-spinner />
                }
                Refresh
              </button>
            </div>
            @if (journalError(); as e) {
              <p class="text-sm text-destructive" role="alert" data-journal-error>{{ e }}</p>
            }
            @if (journal(); as ls) {
              <pre class="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs" data-journal-lines>{{ ls.join('\\n') || 'No log lines.' }}</pre>
            }
          </section>
        }
      </section>
    } @else if (listError(); as e) {
      <p class="text-sm text-destructive" role="alert" data-files-error>{{ e }}</p>
    } @else {
      <div class="flex max-w-5xl flex-col gap-3" data-skeleton>
        <hlm-skeleton class="h-9 w-64" />
        <hlm-skeleton class="h-72 w-full" />
      </div>
    }
  `,
})
export default class Logs {
  protected readonly server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly #base = `/api/servers/${encodeURIComponent(this.server.id)}/logs`;
  protected readonly bytes = formatBytes;

  /** The listing (null until fetched), the file shown, its lines (null while fetching) and why either failed. */
  protected readonly files = signal<ServerLogFiles | null>(null);
  protected readonly listError = signal<string | null>(null);
  protected readonly chosen = signal<string | null>(null);
  protected readonly lines = signal<string[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(false);
  #request?: Subscription;

  /** The linked service's journal, as the Services page shows it. */
  protected readonly journal = signal<string[] | null>(null);
  protected readonly journalError = signal<string | null>(null);
  protected readonly loadingJournal = signal(false);

  constructor() {
    if (!this.server.detail()!.logs) return;
    this.refresh();
    if (this.server.service()) this.fetchJournal();
  }

  /** Fetches the listing again, then the chosen file (or the default, if it is gone). */
  refresh(): void {
    this.loading.set(true);
    this.#http.get<ServerLogFiles>(this.#base).subscribe({
      next: (list) => {
        this.files.set(list);
        this.listError.set(null);
        const keep = list.find((f) => f.name === this.chosen());
        const pick = keep ?? list.find((f) => f.name === DEFAULT) ?? list[0];
        if (pick) this.#fetch(pick.name, !keep);
        else this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        const message = `The logs couldn't be listed (${why(err)}).`;
        // Once listed, the list stays and the failure shows where the file's would.
        if (this.files()) this.error.set(message);
        else this.listError.set(message);
      },
    });
  }

  choose(name: string): void {
    if (name !== this.chosen()) this.#fetch(name, true);
  }

  /** `fresh`: another file, so the old one's lines go at once. */
  #fetch(name: string, fresh: boolean): void {
    this.chosen.set(name);
    if (fresh) this.lines.set(null);
    this.error.set(null);
    this.loading.set(true);
    this.#request?.unsubscribe(); // a slower answer for another file must not land on this one
    this.#request = this.#http.get<ServerLog>(`${this.#base}/${encodeURIComponent(name)}`).subscribe({
      next: ({ lines }) => {
        this.loading.set(false);
        this.lines.set(lines);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.lines.set(null);
        this.error.set(`${name} couldn't be read (${why(err)}).`);
      },
    });
  }

  fetchJournal(): void {
    const service = this.server.service();
    if (!service) return;
    this.loadingJournal.set(true);
    this.#http.get<ServiceLogs>(`/api/services/${encodeURIComponent(service.id)}/logs`).subscribe({
      next: ({ lines }) => {
        this.loadingJournal.set(false);
        this.journalError.set(null);
        this.journal.set(lines);
      },
      error: (err: HttpErrorResponse) => {
        this.loadingJournal.set(false);
        this.journalError.set(`No journal for ${service.unit} (${why(err)}).`);
      },
    });
  }
}

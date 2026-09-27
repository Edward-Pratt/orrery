import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { CommandRequest, LiveEvent } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { filter } from 'rxjs';
import { LiveEvents, ofServer } from '../events';
import ServerPage from './server';

type ConsoleEntry = Extract<LiveEvent, { type: 'console' }>;
const MAX_ENTRIES = 200;

/**
 * A server's Console section (only with the mod): commands and their output. Everything shown comes from the stream,
 * which has each command's output (the hub puts it there just before answering), later output (spark's link), and
 * commands run from Discord; the POST's answer only reports errors.
 */
@Component({
  selector: 'app-server-console',
  imports: [HlmButton],
  template: `
    @if (server.card()!.features.chat) {
      <section class="flex max-w-3xl flex-col gap-2">
        <ol class="h-96 overflow-y-auto rounded-lg border p-3 font-mono text-sm" data-console>
          @for (e of entries(); track $index) {
            <li class="mb-2">
              <div><b>&gt; {{ e.command }}{{ e.late ? ' (later)' : '' }}</b><span class="ml-2 text-xs text-muted-foreground" data-by>{{ e.by }}</span></div>
              @for (line of e.output; track $index) {
                <div class="break-all whitespace-pre-wrap" data-line>{{ line }}</div>
              }
            </li>
          } @empty {
            <p class="text-muted-foreground">No recent commands.</p>
          }
        </ol>
        <form class="flex gap-2" (submit)="$event.preventDefault(); run(command)" data-console-form>
          <input #command class="flex-1 rounded-md border px-3 py-1.5 font-mono text-sm" placeholder="A console command, e.g. list" aria-label="Command" />
          <button hlmBtn type="submit" [disabled]="running()">Run</button>
        </form>
        @if (error(); as e) {
          <p class="text-sm text-destructive" role="alert">{{ e }}</p>
        }
      </section>
    } @else {
      <p class="text-muted-foreground">This server has no console: it runs without the mod.</p>
    }
  `,
})
export default class Console {
  protected readonly server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly entries = signal<ConsoleEntry[]>([]);
  readonly error = signal<string | null>(null);
  readonly running = signal(false);

  constructor() {
    inject(LiveEvents)
      .all$.pipe(filter(ofServer(this.server.id)), takeUntilDestroyed())
      .subscribe(({ event }) => {
        if (event.type === 'console') this.entries.update((e) => [...e, event].slice(-MAX_ENTRIES));
      });
  }

  run(input: HTMLInputElement): void {
    const command = input.value.trim();
    const name = this.server.card()?.name ?? 'The server';
    this.running.set(true);
    this.#http.post(`/api/servers/${encodeURIComponent(this.server.id)}/command`, { command } satisfies CommandRequest).subscribe({
      next: () => {
        input.value = '';
        this.error.set(null);
        this.running.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.running.set(false);
        const why = typeof err.error === 'string' ? err.error : `HTTP ${err.status}`;
        this.error.set(
          err.status === 409
            ? `${name} is offline: the command wasn't run.`
            : err.status === 502
              ? `No answer from ${name}: ${why}`
              : err.status === 400
                ? 'Give a command.'
                : `The command wasn't run (${why}).`,
        );
      },
    });
  }
}

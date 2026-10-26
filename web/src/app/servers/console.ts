import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { CommandRequest, LiveEvent } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { filter } from 'rxjs';
import { LiveEvents, ofServer } from '../events';
import { StickBottom } from './log';
import ServerPage from './server';

type ConsoleEntry = Extract<LiveEvent, { type: 'console' }>;
const MAX_ENTRIES = 200;
const MAX_HISTORY = 50;

/** What this browser remembers of one server's console: commands run (newest last) and saved commands. */
type Remembered = { history: string[]; saved: string[] };

/** The remembered commands under `key`, or null when storage is blocked. A missing or unreadable value is empty. */
function load(key: string): Remembered | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  let v: Partial<Record<keyof Remembered, unknown>> = {};
  try {
    v = JSON.parse(raw ?? '{}') ?? {};
  } catch {
    // not ours: start empty
  }
  const list = (l: unknown) => (Array.isArray(l) ? l.filter((c): c is string => typeof c === 'string') : []);
  return { history: list(v.history).slice(-MAX_HISTORY), saved: list(v.saved) };
}

/**
 * A server's Console section (only with the mod): commands and their output. Everything shown comes from the stream,
 * which has each command's output (the hub puts it there just before answering), later output (spark's link), and
 * commands run from Discord; the POST's answer only reports errors. ↑/↓ in the box step through the commands this browser
 * ran here, and saved commands are chips above it; both live in `localStorage` (`orrery.console.<id>`), or, when storage
 * is blocked, the history in memory only and no ☆.
 */
@Component({
  selector: 'app-server-console',
  imports: [HlmButton, StickBottom],
  template: `
    @if (server.card()!.features.chat) {
      <section class="flex h-[calc(100dvh-16rem)] min-h-72 max-w-4xl flex-col gap-2">
        <ol appStickBottom class="flex-1 rounded-xl border p-3 font-mono text-sm" data-console>
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
        @if (saved().length) {
          <ul class="flex flex-wrap gap-1.5" aria-label="Saved commands" data-saved>
            @for (c of saved(); track c) {
              <li class="inline-flex items-center rounded-md border font-mono text-xs">
                <button type="button" class="px-2 py-1 hover:bg-muted disabled:opacity-50" [disabled]="running()" (click)="run(c)" [attr.title]="'Run ' + c" data-chip>
                  {{ c }}
                </button>
                <button type="button" class="px-1.5 py-1 text-muted-foreground hover:text-foreground" (click)="unsave(c)" [attr.aria-label]="'Remove ' + c" data-unsave>
                  ×
                </button>
              </li>
            }
          </ul>
        }
        <form class="flex gap-2" (submit)="$event.preventDefault(); run(command.value, command)" data-console-form>
          <input
            #command
            class="flex-1 rounded-md border px-3 py-1.5 font-mono text-sm"
            placeholder="A console command, e.g. list"
            aria-label="Command"
            (keydown.arrowup)="$event.preventDefault(); step(command, -1)"
            (keydown.arrowdown)="$event.preventDefault(); step(command, 1)"
            (input)="unstep()"
          />
          @if (stored()) {
            <button hlmBtn variant="outline" type="button" (click)="save(command)" title="Save this command" aria-label="Save command" data-save>☆</button>
          }
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
  /** This browser's commands run here, newest last. */
  readonly history = signal<string[]>([]);
  readonly saved = signal<string[]>([]);
  /** Whether storage works; without it the history lasts until a reload and nothing can be saved. */
  readonly stored = signal(false);
  readonly #key = `orrery.console.${this.server.id}`;
  /** Where ↑/↓ are in the history (null: at what was being typed, kept in #draft). */
  #pos: number | null = null;
  #draft = '';

  constructor() {
    const remembered = load(this.#key);
    if (remembered) {
      this.stored.set(true);
      this.history.set(remembered.history);
      this.saved.set(remembered.saved);
    }
    inject(LiveEvents)
      .all$.pipe(filter(ofServer(this.server.id)), takeUntilDestroyed())
      .subscribe(({ event }) => {
        if (event.type === 'console') this.entries.update((e) => [...e, event].slice(-MAX_ENTRIES));
      });
  }

  /** ↑ (-1) or ↓ (1) in the history; ↓ past the newest puts back what was being typed. */
  step(input: HTMLInputElement, by: -1 | 1): void {
    const history = this.history();
    if (by < 0) {
      if (!history.length) return;
      if (this.#pos === null) {
        this.#draft = input.value;
        this.#pos = history.length - 1;
      } else this.#pos = Math.max(0, this.#pos - 1);
    } else {
      if (this.#pos === null) return;
      this.#pos = this.#pos + 1 < history.length ? this.#pos + 1 : null;
    }
    input.value = this.#pos === null ? this.#draft : history[this.#pos];
  }

  /** Typing makes the box the draft again. */
  unstep(): void {
    this.#pos = null;
  }

  save(input: HTMLInputElement): void {
    const command = input.value.trim();
    if (command) this.#change((r) => (r.saved.includes(command) ? r : { ...r, saved: [...r.saved, command] }));
  }

  unsave(command: string): void {
    this.#change((r) => ({ ...r, saved: r.saved.filter((c) => c !== command) }));
  }

  /** Runs a command, from the box (cleared once it ran) or a chip. */
  run(text: string, input?: HTMLInputElement): void {
    const command = text.trim();
    const name = this.server.card()?.name ?? 'The server';
    this.running.set(true);
    this.#http.post(`/api/servers/${encodeURIComponent(this.server.id)}/command`, { command } satisfies CommandRequest).subscribe({
      next: () => {
        if (input) input.value = '';
        this.#pos = null;
        this.#change((r) => (r.history.at(-1) === command ? r : { ...r, history: [...r.history, command].slice(-MAX_HISTORY) }));
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

  /** Applies a change to what is remembered, over storage's latest copy (another tab may have changed it), and stores it. */
  #change(f: (r: Remembered) => Remembered): void {
    const next = f((this.stored() && load(this.#key)) || { history: this.history(), saved: this.saved() });
    this.history.set(next.history);
    this.saved.set(next.saved);
    if (!this.stored()) return;
    try {
      localStorage.setItem(this.#key, JSON.stringify(next));
    } catch {
      this.stored.set(false);
    }
  }
}

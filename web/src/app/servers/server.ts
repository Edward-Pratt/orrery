import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { ChatRequest, LiveEvent, ServerCard, ServerDetail } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { filter } from 'rxjs';
import { LiveEvents } from '../events';

type ChatLine = Extract<LiveEvent, { type: 'chat' | 'join' | 'leave' | 'death' | 'say' }>;
const CHAT_TYPES: string[] = ['chat', 'join', 'leave', 'death', 'say'] satisfies ChatLine['type'][];
const MAX_LINES = 500;

@Component({
  selector: 'app-server',
  imports: [RouterLink, HlmButton],
  template: `
    <a routerLink=".." class="text-sm text-muted-foreground hover:underline">← Servers</a>
    @if (missing()) {
      <p class="pt-8">No such server.</p>
    } @else if (card(); as c) {
      <h1 class="mt-2 mb-4 text-lg font-semibold">{{ c.name }} <span class="text-sm font-normal text-muted-foreground">{{ c.online ? 'Online' : 'Offline' }}</span></h1>
      @if (c.features.chat) {
        <section class="flex max-w-3xl flex-col gap-2">
          <ol class="h-96 overflow-y-auto rounded-lg border p-3 font-mono text-sm" data-chat>
            @for (line of lines(); track $index) {
              <li>
                @switch (line.type) {
                  @case ('chat') { <b>{{ line.player }}</b>: {{ line.message }} }
                  @case ('say') { <b>{{ line.author }}</b><span class="text-muted-foreground"> (Discord or dashboard)</span>: {{ line.message }} }
                  @case ('join') { <span class="text-muted-foreground">{{ line.player }} joined</span> }
                  @case ('leave') { <span class="text-muted-foreground">{{ line.player }} left</span> }
                  @case ('death') { <span class="text-muted-foreground">{{ line.message }}</span> }
                }
              </li>
            } @empty {
              <li class="text-muted-foreground">No recent chat.</li>
            }
          </ol>
          <form class="flex gap-2" (submit)="$event.preventDefault(); send(message)">
            <input #message class="flex-1 rounded-md border px-3 py-1.5 text-sm" maxlength="256" placeholder="Say something in game" aria-label="Message" />
            <button hlmBtn type="submit">Send</button>
          </form>
          @if (error(); as e) {
            <p class="text-sm text-destructive" role="alert">{{ e }}</p>
          }
        </section>
      } @else {
        <p class="text-muted-foreground" data-no-chat>This server has no chat.</p>
      }
    }
  `,
})
export default class ServerPage {
  readonly #http = inject(HttpClient);
  readonly #id = inject(ActivatedRoute).snapshot.paramMap.get('id')!;
  readonly card = signal<ServerCard | undefined>(undefined);
  readonly missing = signal(false);
  readonly lines = signal<ChatLine[]>([]);
  readonly error = signal<string | null>(null);

  constructor() {
    this.#http.get<ServerDetail>(`/api/servers/${encodeURIComponent(this.#id)}`).subscribe({
      next: (detail) => this.card.set(detail.card),
      error: () => this.missing.set(true),
    });
    // The stream's replay brings recent chat first, then new lines arrive live.
    inject(LiveEvents)
      .all$.pipe(
        filter(({ event }) => event.serverId === this.#id && CHAT_TYPES.includes(event.type)),
        takeUntilDestroyed(),
      )
      .subscribe(({ event }) => this.lines.update((lines) => [...lines, event as ChatLine].slice(-MAX_LINES)));
  }

  send(input: HTMLInputElement): void {
    const message = input.value.trim();
    if (!message) return;
    this.#http
      .post(`/api/servers/${encodeURIComponent(this.#id)}/chat`, { message } satisfies ChatRequest)
      .subscribe({
        next: () => {
          input.value = '';
          this.error.set(null);
        },
        error: (err: HttpErrorResponse) =>
          this.error.set(
            err.status === 409
              ? `${this.card()?.name ?? 'The server'} is offline: the message wasn't sent.`
              : `The message wasn't sent (HTTP ${err.status}). Try again.`,
          ),
      });
  }
}

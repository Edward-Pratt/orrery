import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ChatRequest, LiveEvent } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { filter } from 'rxjs';
import { LiveEvents, ofServer } from '../events';
import { StickBottom } from './log';
import { PlayerName } from './player';
import ServerPage from './server';

type ChatLine = Extract<LiveEvent, { type: 'chat' | 'join' | 'leave' | 'death' | 'say' }>;
const CHAT_TYPES: LiveEvent['type'][] = ['chat', 'join', 'leave', 'death', 'say'] satisfies ChatLine['type'][];
const MAX_LINES = 500;

/** A server's Chat section: recent and live chat, and sending into the game. */
@Component({
  selector: 'app-server-chat',
  imports: [HlmButton, PlayerName, StickBottom],
  template: `
    @if (server.card()!.features.chat) {
      <section class="flex h-[calc(100dvh-16rem)] min-h-72 max-w-4xl flex-col gap-2">
        <ol appStickBottom class="flex-1 rounded-xl border p-3 font-mono text-sm" data-chat>
          @for (line of lines(); track $index) {
            <li>
              @switch (line.type) {
                @case ('chat') { <b><button [appPlayer]="line.player">{{ line.player }}</button></b>: {{ line.message }} }
                @case ('say') { <b>{{ line.author }}</b><span class="text-muted-foreground"> (Discord or dashboard)</span>: {{ line.message }} }
                @case ('join') { <span class="text-muted-foreground"><button [appPlayer]="line.player">{{ line.player }}</button> joined</span> }
                @case ('leave') { <span class="text-muted-foreground"><button [appPlayer]="line.player">{{ line.player }}</button> left</span> }
                @case ('death') { <span class="text-muted-foreground">{{ line.message }}</span> }
              }
            </li>
          } @empty {
            <li class="text-muted-foreground">No recent chat.</li>
          }
        </ol>
        <form class="flex gap-2" (submit)="$event.preventDefault(); send(message)" data-chat-form>
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
  `,
})
export default class Chat {
  protected readonly server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly lines = signal<ChatLine[]>([]);
  readonly error = signal<string | null>(null);

  constructor() {
    // The replay brings recent chat first, then new lines arrive live.
    inject(LiveEvents)
      .all$.pipe(filter(ofServer(this.server.id)), takeUntilDestroyed())
      .subscribe(({ event }) => {
        if (CHAT_TYPES.includes(event.type)) this.lines.update((lines) => [...lines, event as ChatLine].slice(-MAX_LINES));
      });
  }

  send(input: HTMLInputElement): void {
    const message = input.value.trim();
    if (!message) return;
    this.#http
      .post(`/api/servers/${encodeURIComponent(this.server.id)}/chat`, { message } satisfies ChatRequest)
      .subscribe({
        next: () => {
          input.value = '';
          this.error.set(null);
        },
        error: (err: HttpErrorResponse) =>
          this.error.set(
            err.status === 409
              ? `${this.server.card()?.name ?? 'The server'} is offline: the message wasn't sent.`
              : `The message wasn't sent (HTTP ${err.status}). Try again.`,
          ),
      });
  }
}

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { ChatRequest, LiveEvent, ServerCard, ServerDetail, ServiceStatus } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { LiveEvents, ofServer, ofTarget } from '../events';
import { ServiceActions } from '../services/actions';

type ChatLine = Extract<LiveEvent, { type: 'chat' | 'join' | 'leave' | 'death' | 'say' }>;
const CHAT_TYPES: LiveEvent['type'][] = ['chat', 'join', 'leave', 'death', 'say'] satisfies ChatLine['type'][];
const MAX_LINES = 500;

@Component({
  selector: 'app-server',
  imports: [RouterLink, HlmButton, ServiceActions],
  template: `
    <a routerLink=".." class="text-sm text-muted-foreground hover:underline">← Servers</a>
    @if (missing(); as why) {
      <p class="pt-8">{{ why }}</p>
    } @else if (card(); as c) {
      <h1 class="mt-2 mb-4 text-lg font-semibold">{{ c.name }} <span class="text-sm font-normal text-muted-foreground">{{ c.online ? 'Online' : 'Offline' }}</span></h1>
      @if (service(); as s) {
        <section class="mb-4 max-w-3xl rounded-lg border p-4" data-service-actions>
          <h2 class="mb-1 text-sm font-semibold">Service {{ s.unit }} <span class="font-normal text-muted-foreground">{{ s.state }} ({{ s.sub }})</span></h2>
          <p class="mb-3 text-sm text-muted-foreground">The systemd unit this server runs as. Stopping it keeps the server down; with players online they get a countdown first.</p>
          <app-service-actions [service]="s" />
        </section>
      }
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
  /** The service this server runs as, if linked. */
  readonly service = signal<ServiceStatus | null>(null);
  /** Why the server can't be shown: unknown, or the hub didn't answer. */
  readonly missing = signal<string | null>(null);
  readonly lines = signal<ChatLine[]>([]);
  readonly error = signal<string | null>(null);

  constructor() {
    this.#http.get<ServerDetail>(`/api/servers/${encodeURIComponent(this.#id)}`).subscribe({
      next: (detail) => {
        this.card.set(detail.card);
        this.service.set(detail.service);
      },
      error: (err: HttpErrorResponse) =>
        this.missing.set(err.status === 404 ? 'No such server.' : `The hub didn't answer (HTTP ${err.status}). Reload to try again.`),
    });
    // One stream: the replay brings recent chat first, then new lines arrive live; also the linked service's state.
    inject(LiveEvents)
      .all$.pipe(takeUntilDestroyed())
      .subscribe((live) => {
        if (ofServer(this.#id)(live)) {
          if (CHAT_TYPES.includes(live.event.type)) this.lines.update((lines) => [...lines, live.event as ChatLine].slice(-MAX_LINES));
        } else if (ofTarget('service')(live) && live.event.type === 'state' && live.event.id === this.service()?.id) {
          const { state, sub } = live.event;
          this.service.update((s) => s && { ...s, state, sub });
        }
      });
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

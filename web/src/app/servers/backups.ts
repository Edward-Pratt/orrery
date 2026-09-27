import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import type { Backup, CommandOutput } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { formatBytes } from '../units';
import ServerPage from './server';

/**
 * A server's Backups section (only with a backup folder), as Discord's `/backup status` and `/backup start`. The list
 * is the server's detail, fetched again by the page on each backup notice, so a finished backup shows up.
 */
@Component({
  selector: 'app-server-backups',
  imports: [DatePipe, HlmButton],
  template: `
    @if (backups(); as b) {
      <section class="max-w-3xl">
        <dl class="mb-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm" data-backup-summary>
          <dt class="text-muted-foreground">Backups</dt>
          <dd>{{ b.backups.length }}</dd>
          <dt class="text-muted-foreground">Total</dt>
          <dd>{{ bytes(total()) }}</dd>
          <dt class="text-muted-foreground">Free</dt>
          <dd>{{ b.free === null ? 'unknown' : bytes(b.free) }}</dd>
          <dt class="text-muted-foreground">Growth</dt>
          <dd>{{ b.growth === null ? 'unknown' : (b.growth < 0 ? '−' : '+') + bytes(abs(b.growth)) + '/day' }}</dd>
        </dl>
        @if (b.free !== null && b.free < b.minFree) {
          <p class="mb-4 text-sm text-destructive" data-low-space>Low on space: {{ bytes(b.free) }} free, under the {{ bytes(b.minFree) }} minimum.</p>
        }
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <button hlmBtn size="sm" [disabled]="!online() || starting()" (click)="start()" data-backup-start>Start backup</button>
          @if (!online()) {
            <span class="text-sm text-muted-foreground">{{ offline() }}</span>
          }
        </div>
        @if (error(); as e) {
          <p class="mb-4 text-sm text-destructive" role="alert">{{ e }}</p>
        } @else if (reply(); as r) {
          <pre class="mb-4 rounded-lg border p-3 text-sm whitespace-pre-wrap" data-backup-reply>{{ r.join('\n') }}</pre>
        }
        <table class="w-full text-left text-sm">
          <thead class="text-muted-foreground">
            <tr><th class="py-1 pr-4 font-normal">Name</th><th class="pr-4 font-normal">Finished</th><th class="font-normal">Size</th></tr>
          </thead>
          <tbody>
            @for (backup of b.backups; track backup.name) {
              <tr class="border-t" data-backup>
                <td class="py-1 pr-4 font-mono">{{ backup.name }}</td>
                <td class="pr-4">{{ backup.mtimeMs | date: 'yyyy-MM-dd HH:mm' }}</td>
                <td>{{ bytes(backup.size) }}</td>
              </tr>
            } @empty {
              <tr><td colspan="3" class="py-2 text-muted-foreground">No backups yet.</td></tr>
            }
          </tbody>
        </table>
      </section>
    } @else {
      <p class="text-muted-foreground">This server has no backup folder.</p>
    }
  `,
})
export default class Backups {
  readonly #server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  protected readonly bytes = formatBytes;
  protected readonly abs = Math.abs;
  protected readonly backups = computed(() => {
    const b = this.#server.detail()!.backups;
    return b.configured ? b : null;
  });
  protected readonly total = computed(() => (this.backups()?.backups ?? []).reduce((sum: number, b: Backup) => sum + b.size, 0));
  protected readonly online = computed(() => this.#server.card()!.online);
  protected readonly offline = computed(() => `${this.#server.card()!.name} is offline: a backup needs it running.`);
  readonly reply = signal<string[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly starting = signal(false);

  /** The finished (or failed) notice follows on the stream; the page then fetches the list again. */
  start(): void {
    this.starting.set(true);
    this.error.set(null);
    this.#http.post<CommandOutput>(`/api/servers/${encodeURIComponent(this.#server.id)}/backup`, {}).subscribe({
      next: ({ output }) => {
        this.starting.set(false);
        this.reply.set(output.length ? output : ['Started.']);
      },
      error: (err: HttpErrorResponse) => {
        this.starting.set(false);
        const why = typeof err.error === 'string' && err.error ? err.error : `HTTP ${err.status}`;
        this.error.set(err.status === 409 ? this.offline() : `The backup wasn't started: ${why}`);
      },
    });
  }
}

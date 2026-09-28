import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ApplicationRef, Component, createComponent, Directive, EnvironmentInjector, inject, Injectable, input, signal } from '@angular/core';
import type { PlayerAnswer } from '@hub/api';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { formatDuration } from '../units';
import ServerPage from './server';

/** A found player's numbers, as a card (inline on Players, and inside the dialog every other name opens). */
@Component({
  selector: 'app-player-card',
  imports: [DatePipe],
  template: `
    @let p = player();
    <section class="rounded-xl border bg-card p-4" data-player>
      <h3 class="mb-2 font-medium">{{ p.player }}</h3>
      <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt class="text-muted-foreground">Total</dt>
        <dd>{{ duration(p.totalMs) }}</dd>
        <dt class="text-muted-foreground">Last 7 days</dt>
        <dd>{{ duration(p.weekMs) }}</dd>
        <dt class="text-muted-foreground">Last seen</dt>
        <dd>{{ p.lastSeen === null ? 'never' : typeof p.lastSeen === 'number' ? (p.lastSeen | date: 'yyyy-MM-dd HH:mm') : 'online now' }}</dd>
      </dl>
    </section>
  `,
})
export class PlayerCard {
  readonly player = input.required<Extract<PlayerAnswer, { found: true }>>();
  protected readonly duration = formatDuration;
}

/** What a lookup says when it finds nobody, or fails. */
export const lookupError = (name: string, err: HttpErrorResponse) =>
  err.status === 404 ? `${name}: never seen here.` : `The lookup failed (HTTP ${err.status}). Try again.`;

@Component({
  selector: 'app-player-dialog',
  imports: [HlmAlertDialogImports, HlmSkeleton, PlayerCard],
  template: `
    <hlm-alert-dialog state="open" (closed)="done()">
      <hlm-alert-dialog-content *hlmAlertDialogPortal="let ctx">
        <hlm-alert-dialog-header>
          <h2 hlmAlertDialogTitle>{{ name }}</h2>
        </hlm-alert-dialog-header>
        @if (answer(); as a) {
          @if (a.found) {
            <app-player-card [player]="a" />
          }
        } @else if (error(); as e) {
          <p class="text-sm text-muted-foreground" data-never>{{ e }}</p>
        } @else {
          <hlm-skeleton class="h-24 rounded-xl" data-skeleton />
        }
        <hlm-alert-dialog-footer>
          <button hlmAlertDialogCancel data-confirm-cancel>Close</button>
        </hlm-alert-dialog-footer>
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
  `,
})
class PlayerDialog {
  name!: string;
  done!: () => void;
  readonly answer = signal<PlayerAnswer | null>(null);
  readonly error = signal<string | null>(null);
}

/** Opens a player's card in a dialog: any player name, anywhere on a server's page. */
@Injectable({ providedIn: 'root' })
export class PlayerCards {
  readonly #http = inject(HttpClient);
  readonly #app = inject(ApplicationRef);
  readonly #env = inject(EnvironmentInjector);

  open(serverId: string, name: string): void {
    const ref = createComponent(PlayerDialog, { environmentInjector: this.#env });
    let over = false;
    ref.instance.name = name;
    ref.instance.done = () => {
      if (over) return;
      over = true;
      // After the dialog's close animation has had its turn.
      setTimeout(() => ref.destroy(), 300);
    };
    this.#app.attachView(ref.hostView);
    ref.changeDetectorRef.detectChanges();
    this.#http.get<PlayerAnswer>(`/api/servers/${encodeURIComponent(serverId)}/players/${encodeURIComponent(name)}`).subscribe({
      next: (a) => ref.instance.answer.set(a),
      error: (err: HttpErrorResponse) => ref.instance.error.set(lookupError(name, err)),
    });
  }
}

/** Makes its button open the named player's card. */
@Directive({ selector: 'button[appPlayer]', host: { type: 'button', class: 'hover:underline', '(click)': 'open()' } })
export class PlayerName {
  readonly appPlayer = input.required<string>();
  readonly #server = inject(ServerPage);
  readonly #cards = inject(PlayerCards);

  protected open(): void {
    this.#cards.open(this.#server.id, this.appPlayer());
  }
}

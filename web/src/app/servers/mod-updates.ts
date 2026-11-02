import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ModUpdatesState } from '@hub/api';
import { catchError, filter, of, Subject, switchMap } from 'rxjs';
import { LiveEvents, ofServer } from '../events';
import ServerPage from './server';

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * A factorio server's portal mod updates (`GET …/game/updates`), for its Game tab: asked by `reload()` (the tab asks
 * on its first state and whenever what the server runs changes), and again on a `modUpdates` notice and a finished
 * update. Null until answered, and for good after a 404 (an older hub than the dashboard): then nothing shows.
 */
@Injectable()
export class PortalUpdates {
  readonly #http = inject(HttpClient);
  readonly #id = inject(ServerPage).id;
  readonly #asks = new Subject<void>();
  readonly state = signal<ModUpdatesState | null>(null);
  /** Whether the hub has answered once, or asked once and has no such route. */
  readonly asked = signal(false);
  /** Each updatable mod's newest version that fits, by name. */
  readonly to = computed(() => new Map((this.state()?.updates ?? []).map((u) => [u.name, u.to])));

  constructor() {
    let gone = false;
    this.#asks
      .pipe(
        filter(() => !gone),
        switchMap(() =>
          this.#http.get<ModUpdatesState>(`/api/servers/${encodeURIComponent(this.#id)}/game/updates`).pipe(
            catchError((err: { status?: number }) => {
              if (err.status === 404) gone = true;
              return of(null);
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((s) => {
        this.asked.set(true);
        if (s) this.state.set(s);
      });
    inject(LiveEvents)
      .all$.pipe(filter(ofServer(this.#id)), takeUntilDestroyed())
      .subscribe(({ event: e }) => {
        if (e.type === 'notice' && (e.kind === 'modUpdates' || e.kind === 'packUpdateFinished')) this.reload();
      });
  }

  reload(): void {
    this.#asks.next();
  }
}

/** The Game tab's badge beside "Installed": how many portal mod updates, or that the mods are up to date. */
@Component({
  selector: 'app-mod-updates-badge',
  template: `
    @if (updates.state(); as u) {
      @if (u.updates.length) {
        <span class="rounded-full bg-brand/15 px-2 py-0.5 text-xs font-medium text-brand" data-updates>{{ u.updates.length }} {{ u.updates.length === 1 ? 'update' : 'updates' }}</span>
      } @else if (u.checked !== null) {
        <span class="text-xs text-muted-foreground" [attr.title]="'as of ' + time(u.checked)" data-up-to-date>Mods up to date</span>
      }
    }
  `,
})
export class ModUpdatesBadge {
  protected readonly updates = inject(PortalUpdates);
  protected readonly time = time;
}

/** The lines under the Game tab's mods: newer releases needing a newer Factorio, mods gone from the portal, the unchecked, a failed check. */
@Component({
  selector: 'app-mod-updates-notes',
  template: `
    @if (updates.state(); as u) {
      <div class="mt-2 flex flex-col gap-1 text-xs">
        @if (u.later.length) {
          <p class="text-muted-foreground" data-later>
            Newer releases need a newer Factorio:
            @for (l of u.later; track l.name; let last = $last) {
              <span class="font-mono">{{ l.name }} {{ l.latest }}</span>{{ last ? '.' : ', ' }}
            }
          </p>
        }
        @if (u.unchecked.length) {
          <p class="text-muted-foreground" data-unchecked>Not checked (more than 20 at once): {{ u.unchecked.join(', ') }}.</p>
        }
        @if (u.gone.length) {
          <p class="text-status-warn" data-gone>
            Not on the mod portal for Factorio {{ line(u.factorio) }} any more: {{ u.gone.join(', ') }}. A game update can't keep {{ u.gone.length === 1 ? 'it' : 'them' }}: remove
            {{ u.gone.length === 1 ? 'it' : 'them' }} in Update game.
          </p>
        }
        @if (u.error; as e) {
          <p class="text-muted-foreground" data-check-error>Couldn't check the mod portal: {{ e }}{{ u.checked !== null ? ' (last checked at ' + time(u.checked) + ')' : '' }}</p>
        }
      </div>
    } @else if (!updates.asked()) {
      <p class="mt-2 text-xs text-muted-foreground" data-checking-updates>Checking the mod portal for updates…</p>
    }
  `,
})
export class ModUpdatesNotes {
  protected readonly updates = inject(PortalUpdates);
  protected readonly time = time;
  protected readonly line = (factorio: string | null) => factorio?.split('.').slice(0, 2).join('.') ?? '';
}

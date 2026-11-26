import { Component, inject, input, output } from '@angular/core';
import type { GameState } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arCheck } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';
import { ModUpdatesBadge, ModUpdatesNotes, PortalUpdates } from './mod-updates';
import { GAME_MODS } from './mod-list';
import ServerPage from './server';

/**
 * The Game tab's summary card: what the server runs (Factorio and every mod, the game's own muted, each updatable
 * chip's "→ <version>" from the tab's `PortalUpdates`), Update game and Update N mods… (both disabled with the hub's
 * `blocked`, not while stopped: the update starts it), Download mods (`GET …/game/mods.zip`, with a portal mod
 * installed: the hub rebuilds them from the portal, so a player can drop the folder into their own `mods/`), the red box for a failure while preparing, and the "Done" line
 * after an update watched here. The page holds the state and opens the sheet.
 */
@Component({
  selector: 'app-game-summary',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButton, ModUpdatesBadge, ModUpdatesNotes],
  viewProviders: [provideIcons({ arCheck })],
  template: `
    @let g = state();
    <section class="ar-panel p-5" data-summary>
      @if (done(); as d) {
        <p class="mb-3 flex items-center gap-1 text-sm font-medium text-status-ok" data-done><ng-icon name="arCheck" /> Done: {{ d }} is running.</p>
      }
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <p class="flex items-center gap-2 text-xs font-medium text-muted-foreground">Installed <app-mod-updates-badge /></p>
          @if (g.installed; as i) {
            <h2 class="ar-t-heading-md" data-installed>Factorio {{ i.factorio }}</h2>
            <ul class="mt-2 flex flex-wrap gap-1.5" aria-label="Mods">
              @for (m of i.mods; track m.name) {
                <li
                  class="rounded-md px-2 py-0.5 font-mono text-xs"
                  [class]="isGame(m.name) ? 'bg-muted text-muted-foreground' : 'border'"
                  [attr.title]="isGame(m.name) ? 'Comes with Factorio' : null"
                  [attr.data-mod]="m.name"
                >
                  {{ m.name }} {{ m.version }}
                  @if (updates.to().get(m.name); as to) {
                    <span class="text-brand-foreground" [attr.title]="to + ' is on the mod portal for Factorio ' + line(i.factorio)" data-update-to
                      >→ {{ to }}<span class="sr-only">, update available: {{ to }}</span></span
                    >
                  }
                </li>
              }
            </ul>
            <app-mod-updates-notes />
          } @else {
            <p class="text-sm text-muted-foreground" data-not-reported>Its Agent hasn't said yet what the server runs: it does once it is connected.</p>
          }
        </div>
        <div class="flex flex-col items-start gap-2">
          <button hlmBtn [disabled]="!g.installed || !!g.blocked || busy()" (click)="open.emit(false)" data-update>Update game</button>
          @if (updates.state()?.updates?.length; as n) {
            <button hlmBtn variant="outline" [disabled]="!g.installed || !!g.blocked || busy()" (click)="open.emit(true)" data-update-all>Update {{ n }} {{ n === 1 ? 'mod' : 'mods' }}…</button>
          }
          @if (g.installed && hasPortalMods(g.installed.mods)) {
            <a hlmBtn variant="ghost" [href]="zip" download data-mods-zip>Download mods</a>
          }
          @if (g.blocked; as why) {
            <p class="text-xs text-muted-foreground" data-update-why>{{ why }}</p>
          }
        </div>
      </div>
      @if (failedPrep(); as f) {
        <div class="ar-callout ar-callout--danger mt-4 block text-sm" data-failed-prep>
          <b class="text-destructive">Update to {{ f.to }} failed while preparing.</b> The server wasn't touched. {{ f.why }}
        </div>
      }
    </section>
  `,
})
export class GameSummary {
  /** The tab's `PortalUpdates`, which the tab provides (one per tab: never provided again here). */
  protected readonly updates = inject(PortalUpdates);
  readonly state = input.required<GameState>();
  readonly done = input.required<string | null>();
  readonly busy = input.required<boolean>();
  readonly failedPrep = input.required<{ to: string; why: string } | null>();
  /** Update game (false) or Update N mods… (true): the page opens the sheet. */
  readonly open = output<boolean>();

  protected readonly zip = `/api/servers/${encodeURIComponent(inject(ServerPage).id)}/game/mods.zip`;

  protected isGame = (name: string) => GAME_MODS.has(name);
  protected hasPortalMods = (mods: { name: string }[]) => mods.some((m) => !GAME_MODS.has(m.name));
  protected line = (factorio: string) => factorio.split('.').slice(0, 2).join('.');
}

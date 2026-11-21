import { Component, computed, input, output } from '@angular/core';
import type { PortalListing } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arCheck, arExternal, arPackage, arPlus } from '@armil/icons';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { HlmButton } from '@spartan-ng/helm/button';
import { addable, compact, GAME_MODS, label, standing, type Standing, whole } from './mod-browser-rules';

/**
 * The Browse view's list of the portal's mods: each row's thumbnail from the hub's own route (a placeholder when it
 * fails), title, owner, compact download count, version, badges and the portal link the hub built, and its standing in
 * words on one button. Add hands a name up to the sheet, which puts it in the picks and asks the catalog again, so a
 * mod's dependencies (a portal mod pack's mods too) follow. Every portal string is shown as text. The view
 * (`mod-browser.ts`) holds the rows and the failed thumbnails.
 */
@Component({
  selector: 'app-mod-browser-list',
  host: { class: 'contents' },
  imports: [NgIcon, HlmBadge, HlmButton],
  viewProviders: [provideIcons({ arCheck, arExternal, arPackage, arPlus })],
  template: `
    <ul class="divide-y" aria-label="Mods on the portal" [attr.aria-busy]="loading() === 'first'" [class.opacity-60]="loading() === 'first'" data-browse-list>
      @for (m of mods(); track m.name) {
        @if (!isGame(m.name)) {
          <li class="flex gap-3 py-3 first:pt-0" [attr.data-listing]="m.name">
            @if (noThumb().has(m.name)) {
              <span class="flex size-14 shrink-0 items-center justify-center rounded-md bg-muted text-xl text-muted-foreground" data-no-thumb>
                <ng-icon name="arPackage" aria-hidden="true" />
              </span>
            } @else {
              <img
                class="size-14 shrink-0 rounded-md bg-muted object-cover"
                [src]="thumbnail(m.name)"
                alt=""
                width="56"
                height="56"
                loading="lazy"
                decoding="async"
                (error)="missingThumb.emit(m.name)"
                data-thumb
              />
            }
            <div class="min-w-0 flex-1">
              <h3 class="ar-t-ui-strong line-clamp-2" data-title>{{ m.title }}</h3>
              <p class="text-xs text-muted-foreground" data-meta>
                @if (m.owner) {
                  by {{ m.owner }} ·
                }
                <span [attr.title]="whole(m.downloads) + ' downloads'">{{ compact(m.downloads) }} downloads</span> · {{ m.version }}
              </p>
              @if (m.summary) {
                <p class="mt-1 line-clamp-3 text-muted-foreground" data-summary>{{ m.summary }}</p>
              }
              @if (m.category === 'mod-packs' || m.spaceAge) {
                <p class="mt-1.5 flex flex-wrap gap-1">
                  @if (m.category === 'mod-packs') {
                    <span hlmBadge variant="outline" data-badge>Mod pack</span>
                  }
                  @if (m.spaceAge) {
                    <span hlmBadge variant="outline" data-badge>Space Age</span>
                  }
                </p>
              }
              <div class="mt-2 flex items-center gap-1">
                @let s = standing(m.name);
                <!-- one button whatever its standing, aria-disabled, so the focus stays on it when Add flips it to Added -->
                <button
                  hlmBtn
                  variant="outline"
                  size="sm"
                  class="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  [attr.aria-disabled]="addable(s) ? null : true"
                  [attr.aria-label]="s.kind === 'add' ? 'Add ' + m.title : s.kind === 'removed' ? 'Add back ' + m.title : null"
                  (click)="addable(s) && add.emit(m.name)"
                  data-add-mod
                >
                  @if (addable(s)) {
                    <ng-icon name="arPlus" aria-hidden="true" />
                  } @else if (s.kind !== 'required') {
                    <ng-icon name="arCheck" aria-hidden="true" />
                  }
                  {{ label(s) }}
                </button>
                <a
                  hlmBtn
                  variant="ghost"
                  size="icon-sm"
                  [href]="m.page"
                  target="_blank"
                  rel="noopener noreferrer"
                  [attr.aria-label]="m.title + ' on the mod portal'"
                  [attr.title]="m.title + ' on the mod portal'"
                  data-portal
                >
                  <ng-icon name="arExternal" aria-hidden="true" />
                </a>
              </div>
            </div>
          </li>
        }
      }
    </ul>
  `,
})
export class ModBrowserList {
  /** The server's game routes, `/api/servers/<id>/game`. */
  readonly base = input.required<string>();
  /** The rows shown, every page so far. */
  readonly mods = input.required<PortalListing[]>();
  /** What is being read now: page 1 (a new search) or the next page. */
  readonly loading = input.required<'first' | 'more' | null>();
  /** The mods whose thumbnail the hub didn't serve: a placeholder instead. */
  readonly noThumb = input.required<ReadonlySet<string>>();
  /** The names of the mods picked for the update. */
  readonly picks = input.required<readonly string[]>();
  /** The names of the mods the server runs now. */
  readonly installed = input.required<readonly string[]>();
  /** The mods the catalog added for a picked one's dependency, by name: which picked mod needs it. */
  readonly required = input.required<ReadonlyMap<string, string>>();
  /** Add this mod (by its portal name) to the update. */
  readonly add = output<string>();
  /** The hub didn't serve this mod's thumbnail. */
  readonly missingThumb = output<string>();

  protected readonly compact = (n: number) => compact.format(n);
  protected readonly whole = (n: number) => whole.format(n);
  readonly #picked = computed(() => new Set(this.picks()));
  readonly #installed = computed(() => new Set(this.installed()));

  protected isGame = (name: string) => GAME_MODS.has(name);
  protected thumbnail = (name: string) => `${this.base()}/mods/${encodeURIComponent(name)}/thumbnail`;
  protected addable = addable;
  protected label = label;
  /** What the mod is to the update, in the order the rows' buttons say it. */
  protected standing = (name: string): Standing => standing(name, this.#picked(), this.#installed(), this.required());
}

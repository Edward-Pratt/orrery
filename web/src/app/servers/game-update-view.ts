import { Component, computed, input, output } from '@angular/core';
import type { CatalogMod, FactorioRelease, GameCatalog, GameModPick, GameState } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arClose, arFileUp, arLock, arPlus, arSearch } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { GAME_MODS } from './mod-list';

/** The orrery mod: the Agent reads the server's status through it, so the hub refuses an update without it. */
const ORRERY = 'orrery';
const FLOW =
  'Factorio and the mods are downloaded and checked while the server runs. Then a save, a 5-minute countdown if players are online, the swap and a start, and up to 5 minutes for the server to come back with them, or it rolls back to the old ones and the pre-update save.';

/**
 * The Game tab's update view, in the sheet: the Factorio version (the running one and the catalog's per channel), the
 * portal mods, each at its version or "Newest that fits", Remove (none on `orrery`: its Agent needs it), the
 * dependencies the catalog added, Add by portal name, Browse the mod portal and Import mod list, the catalog's refusal,
 * the unmet dependencies, What changes, and Update…. It shows what the sheet (`game-sheet.ts`) holds and hands every
 * change up to it.
 */
@Component({
  selector: 'app-game-update-view',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButton, HlmInput, HlmSpinner],
  viewProviders: [provideIcons({ arFileUp, arLock, arPlus, arSearch, arClose })],
  template: `
    <label
      >Factorio version
      <select class="ar-input mt-1 w-full" (change)="factorioChange.emit($any($event.target).value)" data-factorio>
        @for (v of versions(); track v.version) {
          <option [value]="v.version" [selected]="v.version === factorio()">{{ v.label }}</option>
        }
      </select>
    </label>
    <div>
      <h3 class="ar-t-ui-strong mb-1">Mods</h3>
      <ul class="ar-panel divide-y">
        @for (p of picks(); track p.name) {
          <li class="flex items-center gap-2 px-3 py-2" [attr.data-pick]="p.name">
            <div class="min-w-0 flex-1">
              <p class="truncate">{{ titleOf(p.name) }}</p>
              <p class="truncate font-mono text-xs text-muted-foreground">{{ p.name }}</p>
            </div>
            <select
              class="ar-input max-w-40"
              [attr.aria-label]="'Version of ' + p.name"
              (change)="versionChange.emit({ name: p.name, version: $any($event.target).value || null })"
              data-version
            >
              <option value="" [selected]="p.version === null">Newest that fits{{ newest(p.name) }}</option>
              @for (v of releasesOf(p); track v) {
                <option [value]="v" [selected]="v === p.version">{{ v }}</option>
              }
            </select>
            @if (p.name === orrery) {
              <span class="flex size-8 items-center justify-center text-muted-foreground" title="Its Agent needs it: not removable" data-locked>
                <ng-icon name="arLock" aria-hidden="true" /><span class="sr-only">Not removable: its Agent needs it</span>
              </span>
            } @else {
              <button hlmBtn variant="ghost" size="icon-sm" [attr.aria-label]="'Remove ' + p.name" (click)="remove.emit(p.name)" data-remove><ng-icon name="arClose" /></button>
            }
          </li>
        }
        @for (m of dependencies(); track m.name) {
          <li class="flex items-center gap-2 bg-muted px-3 py-2 text-muted-foreground" [attr.data-dependency]="m.name">
            <div class="min-w-0 flex-1">
              <p class="truncate">{{ m.title }}</p>
              <p class="truncate font-mono text-xs">{{ m.name }} {{ m.version }}</p>
            </div>
            <span class="text-xs">required by {{ m.requiredBy }}</span>
          </li>
        }
        <li class="px-3 py-2 text-xs text-muted-foreground" data-game-mods>Comes with Factorio: {{ gameMods() }}</li>
      </ul>
    </div>
    <form class="flex flex-col gap-1" (submit)="$event.preventDefault(); add.emit()">
      <span class="flex gap-2">
        <input
          hlmInput
          class="min-w-0 flex-1 ar-input--mono"
          placeholder="its name on the mod portal"
          aria-label="Add a mod by its name on the mod portal"
          [value]="adding()"
          (input)="typed.emit($any($event.target).value)"
          data-add-name
        />
        <button hlmBtn variant="outline" type="submit" [disabled]="!adding().trim()" data-add><ng-icon name="arPlus" /> Add</button>
      </span>
      @if (addError(); as e) {
        <span class="text-xs text-muted-foreground" data-add-error>{{ e }}</span>
      }
    </form>
    <span class="-mt-2 flex flex-wrap gap-1">
      <button hlmBtn variant="ghost" (click)="openBrowse.emit($event)" data-browse><ng-icon name="arSearch" aria-hidden="true" /> Browse the mod portal</button>
      <button hlmBtn variant="ghost" (click)="openImport.emit($event)" data-import><ng-icon name="arFileUp" aria-hidden="true" /> Import mod list</button>
    </span>
    @if (catalogError(); as e) {
      <p class="text-destructive" data-catalog-error>{{ e }}</p>
    }
    @if (current(); as c) {
      @if (c.unresolved.length) {
        <div class="ar-callout ar-callout--danger block" data-unresolved>
          <b class="text-destructive">{{ c.unresolved.length === 1 ? 'A dependency' : c.unresolved.length + ' dependencies' }} can't be met.</b> The update can't start until
          they are fixed: pick other versions, add the mod that's needed, or remove the one that needs it.
          <ul class="mt-1 list-inside list-disc">
            @for (u of c.unresolved; track u.mod + u.dependency) {
              <li data-unmet>
                <span class="font-mono text-xs">{{ u.mod }}</span> needs <span class="font-mono text-xs">{{ u.dependency }}</span>: {{ u.reason }}
              </li>
            }
          </ul>
        </div>
      }
      <div data-changes>
        <h3 class="ar-t-ui-strong mb-1">What changes</h3>
        @if (c.changes.length) {
          <ul class="list-inside list-disc text-muted-foreground">
            @for (line of c.changes; track line) {
              <li>{{ line }}</li>
            }
          </ul>
        } @else {
          <p class="text-muted-foreground">{{ factorio() === state()?.installed?.factorio ? 'Nothing: the server runs these already. Add a mod or pick other versions.' : 'Only the Factorio version.' }}</p>
        }
      </div>
    } @else if (checking()) {
      <p class="flex items-center gap-2 text-muted-foreground" data-checking><hlm-spinner /> Checking with the mod portal…</p>
    }
    <p class="text-xs text-muted-foreground">{{ flow }}</p>
    <button hlmBtn [disabled]="!!startWhy() || busy()" (click)="start.emit()" data-update-go>Update…</button>
    @if (startWhy(); as why) {
      <p class="text-xs text-muted-foreground" data-update-go-why>{{ why }}</p>
    }
  `,
})
export class GameUpdateView {
  protected readonly flow = FLOW;
  protected readonly orrery = ORRERY;
  readonly state = input.required<GameState | null>();
  readonly factorio = input.required<string>();
  readonly picks = input.required<GameModPick[]>();
  /** The latest catalog answer, whatever it was for: the titles, releases and "Newest that fits" it said. */
  readonly answer = input.required<GameCatalog | null>();
  /** The catalog's answer only while it is for the update as picked now. */
  readonly current = input.required<GameCatalog | null>();
  readonly dependencies = input.required<CatalogMod[]>();
  readonly adding = input.required<string>();
  readonly addError = input.required<string | null>();
  readonly catalogError = input.required<string | null>();
  readonly checking = input.required<boolean>();
  readonly busy = input.required<boolean>();
  readonly factorioChange = output<string>();
  readonly versionChange = output<GameModPick>();
  readonly remove = output<string>();
  /** Add by name: the typed one. */
  readonly add = output();
  /** What Add by name's box holds now. */
  readonly typed = output<string>();
  readonly openBrowse = output<Event>();
  readonly openImport = output<Event>();
  readonly start = output();

  /** Factorio's own releases on offer, and the one running. */
  protected readonly versions = computed(() => {
    const running = this.state()?.installed?.factorio;
    // Null: the running one, before the catalog says its channel.
    const list: { version: string; channel: FactorioRelease['channel'] | null }[] = running ? [{ version: running, channel: null }] : [];
    for (const v of this.answer()?.versions ?? []) {
      // factorio.com can list one release as both stable and experimental: it is stable, whatever the order.
      const at = list.findIndex((l) => l.version === v.version);
      if (at < 0) list.push({ version: v.version, channel: v.channel });
      else if (list[at]!.channel === null || v.channel === 'stable') list[at] = { version: v.version, channel: v.channel };
    }
    return list.map(({ version, channel }) => ({ version, label: `${version}${channel ? ` · ${channel}` : ''}${version === running ? ' (running)' : ''}` }));
  });
  protected readonly gameMods = computed(() =>
    (this.state()?.installed?.mods ?? [])
      .filter((m) => GAME_MODS.has(m.name))
      .map((m) => m.name)
      .join(', '),
  );
  /** Why Update can't go ahead now; null: it can. */
  protected readonly startWhy = computed(() => {
    const g = this.state();
    if (g?.blocked) return g.blocked;
    const c = this.current();
    if (!c) return this.catalogError() ? 'Fix the problem above first.' : 'Waiting for the mod portal.';
    if (c.unresolved.length) return 'Fix the unmet dependencies first.';
    if (!c.changes.length && this.factorio() === g?.installed?.factorio) return 'Nothing to change: the server runs these already.';
    return null;
  });

  protected titleOf = (name: string) => this.answer()?.mods.find((m) => m.name === name)?.title ?? name;
  /** What "Newest that fits" stands for now: the version the catalog picked, once it has said. */
  protected newest = (name: string) => {
    const m = this.answer()?.mods.find((x) => x.name === name);
    return m ? ` (${m.version})` : '';
  };
  /** A picked mod's releases that fit, and the version picked even when the catalog doesn't list it. */
  protected releasesOf = (p: GameModPick) => {
    const releases = this.answer()?.mods.find((m) => m.name === p.name)?.releases ?? [];
    return p.version && !releases.includes(p.version) ? [...releases, p.version] : releases;
  };
}

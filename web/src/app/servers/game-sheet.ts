import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { afterNextRender, Component, computed, inject, Injector, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { GameCatalog, GameModPick, GameState, GameUpdateRequest } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arArrowLeft } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { catchError, map, of, Subject, switchMap } from 'rxjs';
import { GameUpdateView } from './game-update-view';
import type { BrowseStatus } from './mod-browser';
import { ModBrowser } from './mod-browser';
import { ModImport } from './mod-import';
import { GAME_MODS } from './mod-list';

const why = (err: HttpErrorResponse) => (typeof err.error === 'string' && err.error ? err.error : `HTTP ${err.status}`);

/**
 * The Game tab's Update game sheet: the update asked for (the Factorio version and the portal mods, each at a version
 * or the newest that fits), checked against the mod portal through the hub's catalog on every change, with the
 * dependencies it added and the ones it can't resolve, which stop the update from starting. It shows the update view
 * (`game-update-view.ts`), or in its place the Browse view (`mod-browser.ts`'s `ModBrowser`, a `@defer` chunk) or
 * Import mod list (`mod-import.ts`'s `ModImport`), Back returning to the update view as it was, scroll and focus
 * included. It holds the picks and the catalog's answer: the page's `open` fills them as it opens the sheet, and
 * Update… goes up as `start`, which the page confirms and runs.
 */
@Component({
  selector: 'app-game-sheet',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButton, HlmSheetImports, HlmSpinner, GameUpdateView, ModBrowser, ModImport],
  viewProviders: [provideIcons({ arArrowLeft })],
  template: `
    @if (sheet()) {
      <hlm-sheet side="right" state="open" (closed)="closed.emit()">
        <hlm-sheet-content *hlmSheetPortal="let ctx" class="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md" data-sheet>
          <hlm-sheet-header>
            @if (browsing()) {
              <div class="flex items-center gap-1">
                <button hlmBtn variant="ghost" size="icon-sm" class="-ms-2" aria-label="Back to the update" (click)="closeBrowse()" data-browse-back>
                  <ng-icon name="arArrowLeft" aria-hidden="true" />
                </button>
                <h2 hlmSheetTitle>Browse mods</h2>
              </div>
            } @else if (importing()) {
              <div class="flex items-center gap-1">
                <button hlmBtn variant="ghost" size="icon-sm" class="-ms-2" aria-label="Back to the update" (click)="closeImport()" data-import-back>
                  <ng-icon name="arArrowLeft" aria-hidden="true" />
                </button>
                <h2 hlmSheetTitle>Import mod list</h2>
              </div>
            } @else {
              <h2 hlmSheetTitle>Update game</h2>
            }
          </hlm-sheet-header>
          @defer (when browsing(); prefetch on idle) {
            @if (browsing()) {
              <app-mod-browser
                class="text-sm"
                [base]="base()"
                [factorio]="factorio()"
                [picks]="pickNames()"
                [installed]="installedNames()"
                [required]="required()"
                [status]="browseStatus()"
                (add)="add($event)"
                (back)="closeBrowse()"
              />
            }
          } @loading (after 100ms) {
            @if (browsing()) {
              <p class="flex items-center gap-2 px-4 text-sm text-muted-foreground" data-browse-loading><hlm-spinner /> Opening the mod browser…</p>
            }
          } @error {
            <!-- a deploy replaced the build under this open page, so the browser's chunk is gone -->
            @if (browsing()) {
              <p class="px-4 text-sm text-muted-foreground" data-stale>A new dashboard was deployed: <a href="" class="underline">reload</a> to browse the mod portal.</p>
            }
          }
          @if (importing()) {
            <app-mod-import
              class="text-sm"
              [base]="base()"
              [factorio]="factorio()"
              [picks]="pickNames()"
              [required]="required()"
              [installed]="state()?.installed?.mods ?? []"
              (add)="importMods($event)"
            />
          }
          <div class="flex flex-col gap-4 px-4 pb-4 text-sm" [hidden]="browsing() || importing()" data-update-view>
            <app-game-update-view
              [state]="state()"
              [factorio]="factorio()"
              [picks]="picks()"
              [answer]="catalog()?.answer ?? null"
              [current]="current()"
              [dependencies]="dependencies()"
              [adding]="adding()"
              [addError]="addError()"
              [catalogError]="catalogError()"
              [checking]="checking()"
              [busy]="busy()"
              (factorioChange)="setFactorio($event)"
              (versionChange)="setVersion($event.name, $event.version)"
              (remove)="remove($event)"
              (add)="add()"
              (typed)="adding.set($event); addError.set(null)"
              (openBrowse)="openBrowse($event)"
              (openImport)="openImport($event)"
              (start)="start.emit()"
            />
          </div>
        </hlm-sheet-content>
      </hlm-sheet>
    }
  `,
})
export class GameSheet {
  readonly #http = inject(HttpClient);
  readonly #injector = inject(Injector);
  /** Whether the sheet is open; the page holds it. */
  readonly sheet = input.required<boolean>();
  /** The tab's game routes, `/api/servers/<id>/game`. */
  readonly base = input.required<string>();
  readonly state = input.required<GameState | null>();
  readonly busy = input.required<boolean>();
  readonly closed = output();
  /** Update…: the page confirms it and runs it with `request()`. */
  readonly start = output();

  // The sheet: the update asked for, and the catalog's answer for it.
  protected readonly factorio = signal('');
  protected readonly picks = signal<GameModPick[]>([]);
  protected readonly adding = signal('');
  protected readonly addError = signal<string | null>(null);
  protected readonly checking = signal(false);
  /** The Browse view is shown in place of the update view (which stays in the page, as it was). */
  protected readonly browsing = signal(false);
  /** The Import mod list view, in place of the update view the same way. */
  protected readonly importing = signal(false);
  /** Where Browse or Import was opened from, and how far the update view was scrolled, for Back. */
  #viewFrom: { button: HTMLElement; scroller: HTMLElement | null; top: number } | null = null;
  protected readonly catalogError = signal<string | null>(null);
  /** The latest catalog answer and the request it answered, as JSON. */
  protected readonly catalog = signal<{ asked: string; answer: GameCatalog } | null>(null);
  readonly #asks = new Subject<GameUpdateRequest>();

  readonly request = computed<GameUpdateRequest>(() => ({ factorio: this.factorio(), mods: this.picks() }));
  /** The catalog's answer only while it is for the update as picked now: it decides whether the update can start. */
  readonly current = computed(() => {
    const c = this.catalog();
    return c && c.asked === JSON.stringify(this.request()) ? c.answer : null;
  });
  /** The mods the catalog added for a picked one's required dependency. */
  protected readonly dependencies = computed(() => this.catalog()?.answer.mods.filter((m) => m.requiredBy !== null) ?? []);
  // What the Browse view needs to say each mod's standing and the footer's count.
  protected readonly pickNames = computed(() => this.picks().map((p) => p.name));
  protected readonly installedNames = computed(() => (this.state()?.installed?.mods ?? []).map((m) => m.name));
  protected readonly required = computed(() => new Map(this.dependencies().map((m) => [m.name, m.requiredBy!])));
  protected readonly browseStatus = computed<BrowseStatus>(() => {
    const c = this.current();
    return { checking: this.checking(), changes: c ? c.changes.length : null, unresolved: c?.unresolved.length ?? 0, error: !!this.catalogError() };
  });

  constructor() {
    // Each change in the sheet asks the catalog again; an answer for an earlier pick is dropped.
    this.#asks
      .pipe(
        switchMap((req) => {
          this.checking.set(true);
          this.catalogError.set(null);
          return this.#http.post<GameCatalog>(`${this.base()}/catalog`, req).pipe(
            map((answer) => ({ asked: JSON.stringify(req), answer })),
            catchError((err: HttpErrorResponse) => (this.catalogError.set(`The catalog: ${why(err)}`), of(null))),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((c) => {
        this.checking.set(false);
        if (c) this.catalog.set(c);
      });
  }

  /**
   * Fills the sheet with what the server runs now (`i`): its Factorio version and portal mods at their versions, each
   * one in `newest` at "Newest that fits", on the update view. The page then opens it and calls `ask`.
   */
  open(i: NonNullable<GameState['installed']>, newest: Map<string, string>): void {
    this.factorio.set(i.factorio);
    this.picks.set(i.mods.filter((m) => !GAME_MODS.has(m.name)).map((m) => ({ name: m.name, version: newest.has(m.name) ? null : m.version })));
    this.adding.set('');
    this.addError.set(null);
    this.browsing.set(false);
    this.importing.set(false);
  }

  /** Asks the catalog about the update as picked now. */
  ask(): void {
    this.#asks.next(this.request());
  }

  protected setFactorio(version: string): void {
    this.factorio.set(version);
    this.ask();
  }

  protected setVersion(name: string, version: string | null): void {
    this.picks.update((picks) => picks.map((p) => (p.name === name ? { name, version } : p)));
    this.ask();
  }

  protected remove(name: string): void {
    this.picks.update((picks) => picks.filter((p) => p.name !== name));
    this.ask();
  }

  /**
   * Adds a portal mod by name (typed, or from the Browse view) at the newest version that fits; one the server runs
   * (removed here, then added back) comes back at the version it runs. The catalog says if the portal has no such mod,
   * and adds its required dependencies.
   */
  protected add(name = this.adding().trim()): void {
    if (!name) return;
    if (GAME_MODS.has(name)) return this.addError.set(`${name} comes with Factorio.`);
    if (this.picks().some((p) => p.name === name)) return this.addError.set(`${name} is in the list already.`);
    const version = this.state()?.installed?.mods.find((m) => m.name === name)?.version ?? null;
    this.picks.update((picks) => [...picks, { name, version }]);
    if (name === this.adding().trim()) this.adding.set('');
    this.addError.set(null);
    this.ask();
  }

  /** Shows the Browse view; the update view keeps its picks and scroll position for Back. */
  protected openBrowse(event: Event): void {
    this.#leave(event);
    this.browsing.set(true);
  }

  /** Shows the Import mod list view, the same way. */
  protected openImport(event: Event): void {
    this.#leave(event);
    this.importing.set(true);
  }

  /** Puts the mods Import confirmed in the picks (the ones there kept as they are) and asks the catalog. */
  protected importMods(mods: GameModPick[]): void {
    this.picks.update((picks) => [...picks, ...mods.filter((m) => !GAME_MODS.has(m.name) && !picks.some((p) => p.name === m.name))]);
    this.addError.set(null);
    this.closeImport();
    this.ask();
  }

  #leave(event: Event): void {
    const button = event.currentTarget as HTMLElement;
    const scroller = button.closest<HTMLElement>('[data-sheet]');
    this.#viewFrom = { button, scroller, top: scroller?.scrollTop ?? 0 };
    if (scroller) scroller.scrollTop = 0;
  }

  /** Back to the update view, where Browse was, with the focus on it. */
  protected closeBrowse(): void {
    this.browsing.set(false);
    this.#back();
  }

  protected closeImport(): void {
    this.importing.set(false);
    this.#back();
  }

  #back(): void {
    const from = this.#viewFrom;
    if (!from) return;
    afterNextRender(
      () => {
        if (from.scroller) from.scroller.scrollTop = from.top;
        from.button.focus();
      },
      { injector: this.#injector },
    );
  }
}

import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { afterNextRender, Component, computed, ElementRef, inject, input, type OnInit, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ModBrowse, PortalCategory, PortalListing, PortalSort } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { catchError, map, of, Subject, switchMap, tap, timer } from 'rxjs';
import { type BrowseStatus, ModBrowserFooter } from './mod-browser-footer';
import { ModBrowserList } from './mod-browser-list';
import { SORTS, whole, why } from './mod-browser-rules';

export type { BrowseStatus } from './mod-browser-footer';
/** How long typing waits before it asks the hub. */
export const SEARCH_WAIT_MS = 300;

type Load = { page: number; wait: number };

/**
 * The update sheet's Browse view: the mod portal's mods for the picked Factorio version's line, read through the hub
 * (`GET …/game/mods`, which searches, filters, sorts and pages them; thumbnails from its own route). Add hands a name
 * to the sheet, which puts it in the picks and asks the catalog again, so a mod's dependencies (a portal mod pack's
 * mods too) follow. Every portal string is shown as text. It holds the search, the reads and the rows; the list is
 * `mod-browser-list.ts`, the footer `mod-browser-footer.ts`, the pure rules `mod-browser-rules.ts`.
 */
@Component({
  selector: 'app-mod-browser',
  imports: [HlmButton, HlmInput, HlmSkeleton, HlmSpinner, ModBrowserList, ModBrowserFooter],
  host: { class: 'flex grow flex-col gap-4' },
  template: `
    <div class="flex flex-col gap-2 px-4">
      <input
        #search
        hlmInput
        type="search"
        class="w-full"
        aria-label="Search the mod portal"
        placeholder="Search by name, title or summary"
        maxlength="100"
        [value]="q()"
        (input)="setQuery($any($event.target).value)"
        data-browse-search
      />
      <div class="grid grid-cols-2 gap-2">
        <select class="ar-input min-w-0" aria-label="Category" (change)="setCategory($any($event.target).value)" data-browse-category>
          <option value="" [selected]="category() === ''">All categories</option>
          @for (c of categories(); track c.id) {
            <option [value]="c.id" [selected]="c.id === category()">{{ c.title }}</option>
          }
        </select>
        <select class="ar-input min-w-0" aria-label="Sort by" (change)="setSort($any($event.target).value)" data-browse-sort>
          @for (s of sorts; track s.id) {
            <option [value]="s.id" [selected]="s.id === sort()">{{ s.label }}</option>
          }
        </select>
      </div>
      <p class="text-xs text-muted-foreground" data-browse-line>Mods for Factorio {{ line() }}, deprecated ones hidden.</p>
    </div>

    <div class="flex flex-col gap-3 px-4">
      <div aria-live="polite" class="text-xs text-muted-foreground" data-browse-count>
        @if (rows(); as list) {
          @if (list.length) {
            Showing {{ whole(list.length) }} of {{ whole(total()) }}
          } @else if (!loading()) {
            <p class="text-sm" data-browse-empty>{{ emptyText() }}</p>
          }
        }
      </div>
      @if (error(); as e) {
        @if (e.page === 1) {
          <div class="flex flex-wrap items-center gap-2" role="alert" data-browse-error>
            <p class="text-destructive">{{ e.message }}</p>
            <button hlmBtn variant="outline" size="sm" (click)="retry()" data-browse-retry>Retry</button>
          </div>
        }
      }
      @if (rows() === null && !error()) {
        <div class="flex flex-col gap-4" aria-hidden="true" data-browse-skeleton>
          @for (i of [1, 2, 3, 4, 5, 6]; track i) {
            <div class="flex gap-3">
              <hlm-skeleton class="size-14 shrink-0" />
              <div class="flex flex-1 flex-col gap-2 pt-1">
                <hlm-skeleton class="h-4 w-2/3" />
                <hlm-skeleton class="h-3 w-full" />
              </div>
            </div>
          }
        </div>
      } @else if (rows(); as list) {
        @if (!list.length && !loading() && q()) {
          <button hlmBtn variant="link" class="self-start px-0" (click)="clearSearch()" data-browse-clear>Clear search</button>
        }
        @if (list.length) {
          <app-mod-browser-list
            [base]="base()"
            [mods]="list"
            [loading]="loading()"
            [noThumb]="noThumb()"
            [picks]="picks()"
            [installed]="installed()"
            [required]="required()"
            (add)="add.emit($event)"
            (missingThumb)="missingThumb($event)"
          />
        }
        @if (list.length && list.length < total()) {
          <div class="flex flex-col items-start gap-2 pb-2">
            @if (error(); as e) {
              @if (e.page > 1) {
                <p class="text-destructive" role="alert" data-browse-more-error>{{ e.message }}</p>
              }
            }
            <!-- aria-disabled, not disabled, so the focus stays on it while the page loads -->
            <button
              hlmBtn
              variant="outline"
              class="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              [attr.aria-disabled]="busy() || null"
              (click)="more()"
              data-browse-more
            >
              @if (loading() === 'more') {
                <hlm-spinner />
              }
              {{ moreFailed() ? 'Retry' : 'Load more' }}
            </button>
          </div>
        }
      }
    </div>

    <app-mod-browser-footer [status]="status()" (back)="back.emit()" />
  `,
})
export class ModBrowser implements OnInit {
  readonly #http = inject(HttpClient);
  /** The server's game routes, `/api/servers/<id>/game`. */
  readonly base = input.required<string>();
  /** The Factorio version picked in the update view: the browser shows its line's mods. */
  readonly factorio = input.required<string>();
  /** The names of the mods picked for the update. */
  readonly picks = input.required<readonly string[]>();
  /** The names of the mods the server runs now. */
  readonly installed = input.required<readonly string[]>();
  /** The mods the catalog added for a picked one's dependency, by name: which picked mod needs it. */
  readonly required = input.required<ReadonlyMap<string, string>>();
  readonly status = input.required<BrowseStatus>();
  /** Add this mod (by its portal name) to the update. */
  readonly add = output<string>();
  /** Back to the update view. */
  readonly back = output<void>();

  protected readonly sorts = SORTS;
  protected readonly whole = (n: number) => whole.format(n);
  protected readonly q = signal('');
  protected readonly category = signal('');
  protected readonly sort = signal<PortalSort>('downloads');
  /** The rows shown, every page so far; null until the first answer. */
  protected readonly rows = signal<PortalListing[] | null>(null);
  protected readonly total = signal(0);
  protected readonly categories = signal<PortalCategory[]>([]);
  readonly #page = signal(0);
  /** What is being read now: page 1 (a new search) or the next page. */
  protected readonly loading = signal<'first' | 'more' | null>(null);
  protected readonly error = signal<{ page: number; message: string } | null>(null);
  /** The mods whose thumbnail the hub didn't serve: a placeholder instead. */
  protected readonly noThumb = signal<ReadonlySet<string>>(new Set());
  readonly #loads = new Subject<Load>();
  /** A page-1 read is asked for but not answered yet (typing's wait included): Load more waits for it. */
  readonly #firstAsked = signal(false);
  private readonly search = viewChild.required<ElementRef<HTMLInputElement>>('search');

  /** A failed Load more: its button says Retry, under the reason. */
  /** A read is asked for or running, so Load more would mix two queries or pages: it does nothing meanwhile. */
  protected readonly busy = computed(() => this.loading() !== null || this.#firstAsked());
  protected readonly moreFailed = computed(() => (this.error()?.page ?? 0) > 1);
  protected readonly line = computed(() => this.factorio().split('.').slice(0, 2).join('.'));
  protected readonly emptyText = computed(() => {
    const c = this.categories().find((x) => x.id === this.category());
    const where = c ? ` in ${c.title}` : '';
    return this.q() ? `No mods for Factorio ${this.line()} match "${this.q()}"${where}.` : `No mods for Factorio ${this.line()}${where}.`;
  });

  constructor() {
    // One read at a time: a newer search (or page) drops the older one, so a late answer is never shown.
    this.#loads
      .pipe(
        switchMap(({ page, wait }) =>
          timer(wait).pipe(
            tap(() => {
              this.loading.set(page === 1 ? 'first' : 'more');
              this.error.set(null);
            }),
            switchMap(() => this.#http.get<ModBrowse>(`${this.base()}/mods`, { params: this.#params(page) })),
            map((answer) => ({ page, answer, message: null })),
            catchError((err: HttpErrorResponse) => of({ page, answer: null, message: why(err) })),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe(({ page, answer, message }) => {
        this.loading.set(null);
        if (page === 1) this.#firstAsked.set(false);
        if (!answer) {
          if (page === 1) this.rows.set(null);
          return this.error.set({ page, message: message! });
        }
        // The hub reads the portal's list again now and then, so a later page can repeat a row already shown: dropped.
        this.rows.update((rows) => {
          if (page === 1 || !rows) return answer.mods;
          const shown = new Set(rows.map((m) => m.name));
          return [...rows, ...answer.mods.filter((m) => !shown.has(m.name))];
        });
        // A page past the end (rows dropped as repeats left the count short of the total): every row is shown.
        this.total.set(page > 1 && !answer.mods.length ? (this.rows()?.length ?? 0) : answer.total);
        this.categories.set(answer.categories);
        this.#page.set(page);
      });
    afterNextRender(() => this.search().nativeElement.focus());
  }

  ngOnInit(): void {
    this.#first(0);
  }

  /** Asks page 1 again, for the query as set now. */
  #first(wait: number): void {
    this.#firstAsked.set(true);
    this.#loads.next({ page: 1, wait });
  }

  /** The query for a page: empty search and category left out. */
  #params(page: number): HttpParams {
    let params = new HttpParams().set('factorio', this.factorio());
    const q = this.q().trim();
    if (q) params = params.set('q', q);
    if (this.category()) params = params.set('category', this.category());
    return params.set('sort', this.sort()).set('page', page);
  }

  protected missingThumb(name: string): void {
    this.noThumb.update((s) => new Set([...s, name]));
  }

  protected setQuery(q: string): void {
    this.q.set(q);
    this.#first(SEARCH_WAIT_MS);
  }

  protected setCategory(category: string): void {
    this.category.set(category);
    this.#first(0);
  }

  protected setSort(sort: PortalSort): void {
    this.sort.set(sort);
    this.#first(0);
  }

  protected clearSearch(): void {
    this.q.set('');
    this.#first(0);
    this.search().nativeElement.focus();
  }

  protected retry(): void {
    this.#first(0);
  }

  protected more(): void {
    if (this.busy()) return;
    this.#loads.next({ page: this.#page() + 1, wait: 0 });
  }
}

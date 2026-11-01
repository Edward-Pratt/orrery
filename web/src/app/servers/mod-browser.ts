import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { afterNextRender, Component, computed, ElementRef, inject, input, type OnInit, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ModBrowse, PortalCategory, PortalListing, PortalSort } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideExternalLink, lucidePackage, lucidePlus } from '@ng-icons/lucide';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { catchError, map, of, Subject, switchMap, tap, timer } from 'rxjs';

/** Where the update sheet's catalog answer stands, for the footer: how many changes, or why there's no count. */
export type BrowseStatus = { checking: boolean; changes: number | null; unresolved: number };
/** How long typing waits before it asks the hub. */
export const SEARCH_WAIT_MS = 300;
/** The mods that come with Factorio itself: the portal doesn't list them, and they are never picked. */
const GAME_MODS = new Set(['base', 'elevated-rails', 'quality', 'recycler', 'space-age']);
const SORTS: { id: PortalSort; label: string }[] = [
  { id: 'downloads', label: 'Most downloaded' },
  { id: 'updated', label: 'Recently updated' },
  { id: 'name', label: 'Name' },
];
const compact = new Intl.NumberFormat(undefined, { notation: 'compact' });
const whole = new Intl.NumberFormat();
const HUB_RELEASE = 'This hub has no mod browser yet: deploy hub-v2.16.0 or later.';
const why = (err: HttpErrorResponse) => (err.status === 404 ? HUB_RELEASE : typeof err.error === 'string' && err.error ? err.error : `The hub didn't answer (HTTP ${err.status}).`);

/** What a mod on the portal is to the update being picked, said in words on its button. */
type Standing = { kind: 'installed' | 'added' | 'required' | 'removed' | 'add'; by?: string };
type Load = { page: number; wait: number };

/**
 * The update sheet's Browse view: the mod portal's mods for the picked Factorio version's line, read through the hub
 * (`GET …/game/mods`, which searches, filters, sorts and pages them; thumbnails from its own route). Add hands a name
 * to the sheet, which puts it in the picks and asks the catalog again, so a mod's dependencies (a portal mod pack's
 * mods too) follow. Every portal string is shown as text.
 */
@Component({
  selector: 'app-mod-browser',
  imports: [NgIcon, HlmBadge, HlmButton, HlmInput, HlmSkeleton, HlmSpinner],
  viewProviders: [provideIcons({ lucideCheck, lucideExternalLink, lucidePackage, lucidePlus })],
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
        <select class="h-9 min-w-0 rounded-md border bg-background px-2 text-sm" aria-label="Category" (change)="setCategory($any($event.target).value)" data-browse-category>
          <option value="" [selected]="category() === ''">All categories</option>
          @for (c of categories(); track c.id) {
            <option [value]="c.id" [selected]="c.id === category()">{{ c.title }}</option>
          }
        </select>
        <select class="h-9 min-w-0 rounded-md border bg-background px-2 text-sm" aria-label="Sort by" (change)="setSort($any($event.target).value)" data-browse-sort>
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
          <ul class="divide-y" aria-label="Mods on the portal" [attr.aria-busy]="loading() === 'first'" [class.opacity-60]="loading() === 'first'" data-browse-list>
            @for (m of list; track m.name) {
              @if (!isGame(m.name)) {
                <li class="flex gap-3 py-3 first:pt-0" [attr.data-listing]="m.name">
                  @if (noThumb().has(m.name)) {
                    <span class="flex size-14 shrink-0 items-center justify-center rounded-md bg-muted text-xl text-muted-foreground" data-no-thumb>
                      <ng-icon name="lucidePackage" aria-hidden="true" />
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
                      (error)="missingThumb(m.name)"
                      data-thumb
                    />
                  }
                  <div class="min-w-0 flex-1">
                    <h3 class="line-clamp-2 font-medium leading-snug" data-title>{{ m.title }}</h3>
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
                      @if (s.kind === 'add' || s.kind === 'removed') {
                        <button hlmBtn variant="outline" size="sm" [attr.aria-label]="(s.kind === 'add' ? 'Add ' : 'Add back ') + m.title" (click)="add.emit(m.name)" data-add-mod>
                          <ng-icon name="lucidePlus" aria-hidden="true" /> {{ s.kind === 'add' ? 'Add' : 'Add back' }}
                        </button>
                      } @else {
                        <button hlmBtn variant="outline" size="sm" disabled data-add-mod>
                          @if (s.kind !== 'required') {
                            <ng-icon name="lucideCheck" aria-hidden="true" />
                          }
                          {{ s.kind === 'installed' ? 'Installed' : s.kind === 'added' ? 'Added' : 'Required by ' + s.by }}
                        </button>
                      }
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
                        <ng-icon name="lucideExternalLink" aria-hidden="true" />
                      </a>
                    </div>
                  </div>
                </li>
              }
            }
          </ul>
        }
        @if (list.length && list.length < total()) {
          <div class="flex flex-col items-start gap-2 pb-2">
            @if (error(); as e) {
              @if (e.page > 1) {
                <p class="text-destructive" role="alert" data-browse-more-error>{{ e.message }}</p>
              }
            }
            <!-- aria-disabled, not disabled, so the focus stays on it while the page loads -->
            <button hlmBtn variant="outline" [attr.aria-disabled]="loading() === 'more' || null" (click)="more()" data-browse-more>
              @if (loading() === 'more') {
                <hlm-spinner />
              }
              {{ moreFailed() ? 'Retry' : 'Load more' }}
            </button>
          </div>
        }
      }
    </div>

    <div class="sticky bottom-0 mt-auto flex flex-wrap items-center justify-between gap-2 border-t bg-popover px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-browse-footer>
      <p class="flex min-w-0 items-center gap-2" data-browse-changes>
        @if (status().checking) {
          <hlm-spinner /> <span class="text-muted-foreground">Checking with the mod portal…</span>
        } @else if (status().unresolved) {
          <span class="text-destructive">{{ status().unresolved === 1 ? "A dependency can't be met" : status().unresolved + " dependencies can't be met" }}</span>
        } @else if (status().changes !== null) {
          <span>{{ status().changes === 1 ? '1 change' : status().changes + ' changes' }}</span>
        }
      </p>
      <button hlmBtn (click)="back.emit()" data-browse-review>Review the update</button>
    </div>
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
  protected readonly compact = (n: number) => compact.format(n);
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
  private readonly search = viewChild.required<ElementRef<HTMLInputElement>>('search');

  /** A failed Load more: its button says Retry, under the reason. */
  protected readonly moreFailed = computed(() => (this.error()?.page ?? 0) > 1);
  protected readonly line = computed(() => this.factorio().split('.').slice(0, 2).join('.'));
  protected readonly emptyText = computed(() => {
    const c = this.categories().find((x) => x.id === this.category());
    const where = c ? ` in ${c.title}` : '';
    return this.q() ? `No mods for Factorio ${this.line()} match "${this.q()}"${where}.` : `No mods for Factorio ${this.line()}${where}.`;
  });
  readonly #picked = computed(() => new Set(this.picks()));
  readonly #installed = computed(() => new Set(this.installed()));

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
        if (!answer) {
          if (page === 1) this.rows.set(null);
          return this.error.set({ page, message: message! });
        }
        this.rows.update((rows) => (page === 1 ? answer.mods : [...(rows ?? []), ...answer.mods]));
        this.total.set(answer.total);
        this.categories.set(answer.categories);
        this.#page.set(page);
      });
    afterNextRender(() => this.search().nativeElement.focus());
  }

  ngOnInit(): void {
    this.#loads.next({ page: 1, wait: 0 });
  }

  /** The query for a page: empty search and category left out. */
  #params(page: number): HttpParams {
    let params = new HttpParams().set('factorio', this.factorio());
    const q = this.q().trim();
    if (q) params = params.set('q', q);
    if (this.category()) params = params.set('category', this.category());
    return params.set('sort', this.sort()).set('page', page);
  }

  protected isGame = (name: string) => GAME_MODS.has(name);
  protected thumbnail = (name: string) => `${this.base()}/mods/${encodeURIComponent(name)}/thumbnail`;

  protected missingThumb(name: string): void {
    this.noThumb.update((s) => new Set([...s, name]));
  }

  /** What the mod is to the update, in the order the rows' buttons say it. */
  protected standing = (name: string): Standing => {
    const picked = this.#picked().has(name);
    const installed = this.#installed().has(name);
    if (picked && installed) return { kind: 'installed' };
    if (picked) return { kind: 'added' };
    const by = this.required().get(name);
    if (by !== undefined) return { kind: 'required', by };
    if (installed) return { kind: 'removed' };
    return { kind: 'add' };
  };

  protected setQuery(q: string): void {
    this.q.set(q);
    this.#loads.next({ page: 1, wait: SEARCH_WAIT_MS });
  }

  protected setCategory(category: string): void {
    this.category.set(category);
    this.#loads.next({ page: 1, wait: 0 });
  }

  protected setSort(sort: PortalSort): void {
    this.sort.set(sort);
    this.#loads.next({ page: 1, wait: 0 });
  }

  protected clearSearch(): void {
    this.q.set('');
    this.#loads.next({ page: 1, wait: 0 });
    this.search().nativeElement.focus();
  }

  protected retry(): void {
    this.#loads.next({ page: 1, wait: 0 });
  }

  protected more(): void {
    if (this.loading() === 'more') return;
    this.#loads.next({ page: this.#page() + 1, wait: 0 });
  }
}

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { afterNextRender, Component, computed, inject, Injector, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { FactorioRelease, GameCatalog, GameModPick, GameState, GameUpdateAnswer, GameUpdateRequest, LiveEvent, PackStep, RunningGameUpdate } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideCheck, lucideFileUp, lucideLock, lucidePlus, lucideSearch, lucideX } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { catchError, debounceTime, EMPTY, filter, firstValueFrom, map, of, startWith, Subject, switchMap } from 'rxjs';
import { LiveEvents, ofServer, ofTarget } from '../events';
import { Feedback } from '../feedback';
import { changesCard } from './changes';
import type { BrowseStatus } from './mod-browser';
import { ModBrowser } from './mod-browser';
import { ModImport } from './mod-import';
import { GAME_MODS } from './mod-list';
import ServerPage from './server';
import { failedPrep, PACK_STEPS, UpdateHistory, UpdateSteps } from './update-steps';

/** The orrery mod: the Agent reads the server's status through it, so the hub refuses an update without it. */
const ORRERY = 'orrery';
const STEPS: Record<PackStep, string> = { ...PACK_STEPS, backup: 'Save' };
const FLOW =
  'Factorio and the mods are downloaded and checked while the server runs. Then a save, a 5-minute countdown if players are online, the swap and a start, and up to 5 minutes for the server to come back with them, or it rolls back to the old ones and the pre-update save.';
const why = (err: HttpErrorResponse) => (typeof err.error === 'string' && err.error ? err.error : `HTTP ${err.status}`);
/** A Host's Agent went silent or came back: whether a game update can start changes. */
const agentNotice = (e: LiveEvent) => 'target' in e && e.target === 'host' && e.type === 'notice' && (e.kind === 'agentLost' || e.kind === 'agentBack');

/**
 * A factorio server's Game section (only with `features.update`): what it runs, Update game (a sheet: the Factorio
 * version and the portal mods, each at a version or the newest that fits, checked against the mod portal through the
 * hub's catalog on every change, with the dependencies it added and the ones it can't resolve, which stop the update
 * from starting), and the history; the running update's steps in place of the summary, followed live from
 * `packUpdateStep` notices like the Pack section's. It answers for a stopped server too: the update then starts it.
 */
@Component({
  selector: 'app-server-game',
  imports: [NgIcon, HlmButton, HlmInput, HlmSheetImports, HlmSpinner, ModBrowser, ModImport, UpdateHistory, UpdateSteps],
  viewProviders: [provideIcons({ lucideArrowLeft, lucideCheck, lucideFileUp, lucideLock, lucidePlus, lucideSearch, lucideX })],
  template: `
    @if (state(); as g) {
      <div class="flex max-w-4xl flex-col gap-8">
        @if (running(); as r) {
          <app-update-steps [title]="'Updating ' + r.from + ' → ' + r.to" [update]="r" [labels]="steps" [busy]="busy()" (cancel)="cancel()" />
        } @else {
          <section class="rounded-xl border bg-card p-5" data-summary>
            @if (done(); as d) {
              <p class="mb-3 flex items-center gap-1 text-sm font-medium text-status-ok" data-done><ng-icon name="lucideCheck" /> Done: {{ d }} is running.</p>
            }
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="text-xs font-medium text-muted-foreground">Installed</p>
                @if (g.installed; as i) {
                  <h2 class="text-xl font-semibold" data-installed>Factorio {{ i.factorio }}</h2>
                  <ul class="mt-2 flex flex-wrap gap-1.5" aria-label="Mods">
                    @for (m of i.mods; track m.name) {
                      <li
                        class="rounded-md px-2 py-0.5 font-mono text-xs"
                        [class]="isGame(m.name) ? 'bg-muted text-muted-foreground' : 'border'"
                        [attr.title]="isGame(m.name) ? 'Comes with Factorio' : null"
                        [attr.data-mod]="m.name"
                      >
                        {{ m.name }} {{ m.version }}
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="text-sm text-muted-foreground" data-not-reported>Its Agent hasn't said yet what the server runs: it does once it is connected.</p>
                }
              </div>
              <div class="flex flex-col items-end gap-1">
                <button hlmBtn [disabled]="!g.installed || !!g.blocked || busy()" (click)="open()" data-update>Update game</button>
                @if (g.blocked; as why) {
                  <p class="text-xs text-muted-foreground" data-update-why>{{ why }}</p>
                }
              </div>
            </div>
            @if (failedPrep(); as f) {
              <div class="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm" data-failed-prep>
                <b class="text-destructive">Update to {{ f.to }} failed while preparing.</b> The server wasn't touched. {{ f.why }}
              </div>
            }
          </section>
        }
        <app-update-history [rows]="g.history" empty="No game updates yet." />
      </div>
    } @else if (missing(); as why) {
      <p class="text-muted-foreground">{{ why }}</p>
    }

    @if (sheet()) {
      <hlm-sheet side="right" state="open" (closed)="sheet.set(false)">
        <hlm-sheet-content *hlmSheetPortal="let ctx" class="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md" data-sheet>
          <hlm-sheet-header>
            @if (browsing()) {
              <div class="flex items-center gap-1">
                <button hlmBtn variant="ghost" size="icon-sm" class="-ms-2" aria-label="Back to the update" (click)="closeBrowse()" data-browse-back>
                  <ng-icon name="lucideArrowLeft" aria-hidden="true" />
                </button>
                <h2 hlmSheetTitle>Browse mods</h2>
              </div>
            } @else if (importing()) {
              <div class="flex items-center gap-1">
                <button hlmBtn variant="ghost" size="icon-sm" class="-ms-2" aria-label="Back to the update" (click)="closeImport()" data-import-back>
                  <ng-icon name="lucideArrowLeft" aria-hidden="true" />
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
                [base]="base"
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
              [base]="base"
              [factorio]="factorio()"
              [picks]="pickNames()"
              [required]="required()"
              [installed]="state()?.installed?.mods ?? []"
              (add)="importMods($event)"
            />
          }
          <div class="flex flex-col gap-4 px-4 pb-4 text-sm" [hidden]="browsing() || importing()" data-update-view>
            <label
              >Factorio version
              <select class="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" (change)="setFactorio($any($event.target).value)" data-factorio>
                @for (v of versions(); track v.version) {
                  <option [value]="v.version" [selected]="v.version === factorio()">{{ v.label }}</option>
                }
              </select>
            </label>
            <div>
              <h3 class="mb-1 font-medium">Mods</h3>
              <ul class="divide-y rounded-lg border">
                @for (p of picks(); track p.name) {
                  <li class="flex items-center gap-2 px-3 py-2" [attr.data-pick]="p.name">
                    <div class="min-w-0 flex-1">
                      <p class="truncate">{{ titleOf(p.name) }}</p>
                      <p class="truncate font-mono text-xs text-muted-foreground">{{ p.name }}</p>
                    </div>
                    <select
                      class="h-8 max-w-40 rounded-md border bg-background px-2 text-sm"
                      [attr.aria-label]="'Version of ' + p.name"
                      (change)="setVersion(p.name, $any($event.target).value || null)"
                      data-version
                    >
                      <option value="" [selected]="p.version === null">Newest that fits{{ newest(p.name) }}</option>
                      @for (v of releasesOf(p); track v) {
                        <option [value]="v" [selected]="v === p.version">{{ v }}</option>
                      }
                    </select>
                    @if (p.name === orrery) {
                      <span class="flex size-8 items-center justify-center text-muted-foreground" title="Its Agent needs it: not removable" data-locked>
                        <ng-icon name="lucideLock" aria-hidden="true" /><span class="sr-only">Not removable: its Agent needs it</span>
                      </span>
                    } @else {
                      <button hlmBtn variant="ghost" size="sm" [attr.aria-label]="'Remove ' + p.name" (click)="remove(p.name)" data-remove><ng-icon name="lucideX" /></button>
                    }
                  </li>
                }
                @for (m of dependencies(); track m.name) {
                  <li class="flex items-center gap-2 bg-muted/40 px-3 py-2 text-muted-foreground" [attr.data-dependency]="m.name">
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
            <form class="flex flex-col gap-1" (submit)="$event.preventDefault(); add()">
              <span class="flex gap-2">
                <input
                  hlmInput
                  class="min-w-0 flex-1 font-mono"
                  placeholder="its name on the mod portal"
                  aria-label="Add a mod by its name on the mod portal"
                  [value]="adding()"
                  (input)="adding.set($any($event.target).value); addError.set(null)"
                  data-add-name
                />
                <button hlmBtn variant="outline" type="submit" [disabled]="!adding().trim()" data-add><ng-icon name="lucidePlus" /> Add</button>
              </span>
              @if (addError(); as e) {
                <span class="text-xs text-muted-foreground" data-add-error>{{ e }}</span>
              }
            </form>
            <span class="-mt-2 flex flex-wrap gap-1">
              <button hlmBtn variant="ghost" (click)="openBrowse($event)" data-browse><ng-icon name="lucideSearch" aria-hidden="true" /> Browse the mod portal</button>
              <button hlmBtn variant="ghost" (click)="openImport($event)" data-import><ng-icon name="lucideFileUp" aria-hidden="true" /> Import mod list</button>
            </span>
            @if (catalogError(); as e) {
              <p class="text-destructive" data-catalog-error>{{ e }}</p>
            }
            @if (current(); as c) {
              @if (c.unresolved.length) {
                <div class="rounded-lg bg-destructive/10 px-3 py-2" data-unresolved>
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
                <h3 class="mb-1 font-medium">What changes</h3>
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
            <button hlmBtn [disabled]="!!startWhy() || busy()" (click)="start()" data-update-go>Update…</button>
            @if (startWhy(); as why) {
              <p class="text-xs text-muted-foreground" data-update-go-why>{{ why }}</p>
            }
          </div>
        </hlm-sheet-content>
      </hlm-sheet>
    }
  `,
})
export default class Game {
  readonly #server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly #injector = inject(Injector);
  protected readonly base = `/api/servers/${encodeURIComponent(this.#server.id)}/game`;
  protected readonly steps = STEPS;
  protected readonly flow = FLOW;
  protected readonly orrery = ORRERY;

  readonly state = signal<GameState | null>(null);
  protected readonly missing = signal<string | null>(null);
  /** The update under way, kept current from the stream. */
  protected readonly running = signal<RunningGameUpdate | null>(null);
  /** What an update watched here just put in place, for the summary card's "Done" line. */
  protected readonly done = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly failedPrep = computed(() => failedPrep(this.state()?.history ?? []));

  // The sheet: the update asked for, and the catalog's answer for it.
  protected readonly sheet = signal(false);
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
  readonly #catalog = signal<{ asked: string; answer: GameCatalog } | null>(null);
  readonly #asks = new Subject<GameUpdateRequest>();
  readonly #reload = new Subject<void>();

  protected readonly request = computed<GameUpdateRequest>(() => ({ factorio: this.factorio(), mods: this.picks() }));
  /** The catalog's answer only while it is for the update as picked now: it decides whether the update can start. */
  protected readonly current = computed(() => {
    const c = this.#catalog();
    return c && c.asked === JSON.stringify(this.request()) ? c.answer : null;
  });
  /** Factorio's own releases on offer, and the one running. */
  protected readonly versions = computed(() => {
    const running = this.state()?.installed?.factorio;
    // Null: the running one, before the catalog says its channel.
    const list: { version: string; channel: FactorioRelease['channel'] | null }[] = running ? [{ version: running, channel: null }] : [];
    for (const v of this.#catalog()?.answer.versions ?? []) {
      // factorio.com can list one release as both stable and experimental: it is stable, whatever the order.
      const at = list.findIndex((l) => l.version === v.version);
      if (at < 0) list.push({ version: v.version, channel: v.channel });
      else if (list[at]!.channel === null || v.channel === 'stable') list[at] = { version: v.version, channel: v.channel };
    }
    return list.map(({ version, channel }) => ({ version, label: `${version}${channel ? ` · ${channel}` : ''}${version === running ? ' (running)' : ''}` }));
  });
  /** The mods the catalog added for a picked one's required dependency. */
  protected readonly dependencies = computed(() => this.#catalog()?.answer.mods.filter((m) => m.requiredBy !== null) ?? []);
  protected readonly gameMods = computed(() =>
    (this.state()?.installed?.mods ?? [])
      .filter((m) => GAME_MODS.has(m.name))
      .map((m) => m.name)
      .join(', '),
  );
  // What the Browse view needs to say each mod's standing and the footer's count.
  protected readonly pickNames = computed(() => this.picks().map((p) => p.name));
  protected readonly installedNames = computed(() => (this.state()?.installed?.mods ?? []).map((m) => m.name));
  protected readonly required = computed(() => new Map(this.dependencies().map((m) => [m.name, m.requiredBy!])));
  protected readonly browseStatus = computed<BrowseStatus>(() => {
    const c = this.current();
    return { checking: this.checking(), changes: c ? c.changes.length : null, unresolved: c?.unresolved.length ?? 0, error: !!this.catalogError() };
  });
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

  constructor() {
    this.#reload
      .pipe(
        debounceTime(50),
        startWith(undefined),
        switchMap(() =>
          this.#http.get<GameState>(this.base).pipe(
            catchError((err: HttpErrorResponse) => {
              if (!this.state()) this.missing.set(err.status === 404 ? 'This server has no game updates.' : `The hub didn't answer (HTTP ${err.status}).`);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((g) => {
        this.state.set(g);
        this.running.set(g.running);
      });
    // Each change in the sheet asks the catalog again; an answer for an earlier pick is dropped.
    this.#asks
      .pipe(
        switchMap((req) => {
          this.checking.set(true);
          this.catalogError.set(null);
          return this.#http.post<GameCatalog>(`${this.base}/catalog`, req).pipe(
            map((answer) => ({ asked: JSON.stringify(req), answer })),
            catchError((err: HttpErrorResponse) => (this.catalogError.set(`The catalog: ${why(err)}`), of(null))),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((c) => {
        this.checking.set(false);
        if (c) this.#catalog.set(c);
      });
    const events = inject(LiveEvents).all$;
    // Why an update can't start changes with an Agent deploy, and with the Agent leaving or coming back.
    events.pipe(filter((l) => ofTarget('deploy')(l) || agentNotice(l.event)), takeUntilDestroyed()).subscribe(() => this.#reload.next());
    events.pipe(filter(ofServer(this.#server.id)), takeUntilDestroyed()).subscribe(({ event: e }) => {
      if (e.type === 'notice' && e.kind === 'packUpdateStep') {
        const r = this.running();
        if (!r) return this.#reload.next(); // started elsewhere: fetch it with its steps
        const step = { step: e.step, state: e.state, detail: e.detail };
        const steps = r.steps.some((s) => s.step === e.step) ? r.steps.map((s) => (s.step === e.step ? step : s)) : [...r.steps, step];
        this.running.set({ ...r, steps, cancellable: e.cancellable });
      } else if (e.type === 'notice' && e.kind === 'packUpdateStarted') {
        this.done.set(null);
        this.#reload.next();
      } else if (e.type === 'notice' && e.kind === 'packUpdateFinished') {
        if (e.outcome === 'ok' && this.running()) this.done.set(e.to);
        this.#reload.next();
      } else if (changesCard(e)) this.#reload.next(); // a countdown, or the server coming or going
    });
  }

  protected isGame = (name: string) => GAME_MODS.has(name);
  protected titleOf = (name: string) => this.#catalog()?.answer.mods.find((m) => m.name === name)?.title ?? name;
  /** What "Newest that fits" stands for now: the version the catalog picked, once it has said. */
  protected newest = (name: string) => {
    const m = this.#catalog()?.answer.mods.find((x) => x.name === name);
    return m ? ` (${m.version})` : '';
  };
  /** A picked mod's releases that fit, and the version picked even when the catalog doesn't list it. */
  protected releasesOf = (p: GameModPick) => {
    const releases = this.#catalog()?.answer.mods.find((m) => m.name === p.name)?.releases ?? [];
    return p.version && !releases.includes(p.version) ? [...releases, p.version] : releases;
  };

  /** Opens the sheet on what the server runs now: its Factorio version and portal mods at their versions. */
  protected open(): void {
    const i = this.state()!.installed!;
    this.factorio.set(i.factorio);
    this.picks.set(i.mods.filter((m) => !GAME_MODS.has(m.name)).map((m) => ({ name: m.name, version: m.version })));
    this.adding.set('');
    this.addError.set(null);
    this.browsing.set(false);
    this.importing.set(false);
    this.sheet.set(true);
    this.#ask();
  }

  #ask(): void {
    this.#asks.next(this.request());
  }

  protected setFactorio(version: string): void {
    this.factorio.set(version);
    this.#ask();
  }

  protected setVersion(name: string, version: string | null): void {
    this.picks.update((picks) => picks.map((p) => (p.name === name ? { name, version } : p)));
    this.#ask();
  }

  protected remove(name: string): void {
    this.picks.update((picks) => picks.filter((p) => p.name !== name));
    this.#ask();
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
    this.#ask();
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
    this.#ask();
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

  #confirmText(): string {
    const card = this.#server.card()!;
    if (!card.online) {
      return "The server is stopped, so no save is made first. It swaps Factorio and the mods and starts the server; if it isn't back with them within 5 minutes, it rolls back to the old ones and the newest save.";
    }
    const players = card.players.length;
    return `Saves, then stops the server${players ? ` (a 5-minute countdown: ${players} player${players === 1 ? '' : 's'} online)` : ''}, swaps Factorio and the mods, and starts it. If it isn't back with them within 5 minutes, it rolls back to the old ones and the pre-update save.`;
  }

  protected async start(): Promise<void> {
    const req = this.request();
    const changes = this.current()!.changes;
    const name = this.#server.card()!.name;
    this.sheet.set(false);
    const ok = await this.#feedback.confirm({
      title: req.factorio === this.state()!.installed!.factorio ? `Update the mods of ${name}?` : `Update ${name} to Factorio ${req.factorio}?`,
      description: `${changes.length ? `${changes.join('; ')}. ` : ''}${this.#confirmText()}`,
      verb: 'Update',
    });
    // Cancelled: back to the sheet as it was.
    if (!ok) return this.sheet.set(true);
    const answer = await this.#request('Starting the update', () => firstValueFrom(this.#http.post<GameUpdateAnswer>(`${this.base}/update`, req)));
    if (answer) this.#reload.next();
  }

  protected async cancel(): Promise<void> {
    const done = await this.#request('Cancelling the update', () => firstValueFrom(this.#http.post(`${this.base}/update/cancel`, {})));
    if (done !== undefined) this.#feedback.ok('Cancelling: nothing is swapped.');
  }

  /** Runs a request with the buttons disabled; reports a failure as a toast. Resolves with the answer, or undefined. */
  async #request<T>(what: string, run: () => Promise<T>): Promise<T | undefined> {
    this.busy.set(true);
    try {
      return await run();
    } catch (err) {
      if (err instanceof HttpErrorResponse) this.#feedback.failed(what, err);
      else throw err;
      return undefined;
    } finally {
      this.busy.set(false);
    }
  }
}

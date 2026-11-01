import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { afterNextRender, Component, computed, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { GameModPick, ModCheckAnswer, ModCheckRequest } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { catchError, map, of, Subject, switchMap } from 'rxjs';
import { LIST_MAX_BYTES, type ModList, ModListError, MODS_MAX, parseModList, shown } from './mod-list';

const HUB_RELEASE = "This hub can't check a mod list yet: deploy hub-v2.17.0 or later.";
const why = (err: HttpErrorResponse) => (err.status === 404 ? HUB_RELEASE : typeof err.error === 'string' && err.error ? err.error : `The hub didn't answer (HTTP ${err.status}).`);
const FOUND: Record<'noRelease' | 'missing' | 'unchecked', (line: string) => string> = {
  noRelease: (line) => `no release for Factorio ${line}`,
  missing: () => 'not on the mod portal',
  unchecked: () => 'not checked: add it by name to see',
};
const mods = (n: number) => `${n} mod${n === 1 ? '' : 's'}`;

/** The preview: what Confirm adds, what's in the update already, and what's skipped and why. */
type Preview = {
  add: { name: string; title: string; version: string | null }[];
  already: string[];
  skipped: { name: string; why: string }[];
  /** What the list left out on its own: disabled mods, and names given twice. */
  left: string | null;
  /** Why Confirm can't add them; null: it can. */
  blocked: string | null;
};

/**
 * The update sheet's Import mod list view: a client's `mod-list.json` (uploaded) or pasted names, parsed here
 * (`mod-list.ts`), then the names not in the update yet checked with the hub (`POST …/game/check`) for the picked
 * Factorio version's line. The preview says what would be added, what's there already and every name skipped with
 * why; Confirm hands the ones to add to the sheet, which merges them into its picks and asks the catalog, so their
 * dependencies follow. Nothing changes before Confirm.
 */
@Component({
  selector: 'app-mod-import',
  imports: [HlmButton, HlmSpinner],
  host: { class: 'flex flex-col gap-4 px-4 pb-4' },
  template: `
    <div class="flex flex-col gap-1">
      <label for="mod-list-file" class="font-medium">Upload your game's <span class="font-mono">mod-list.json</span></label>
      <p class="text-xs text-muted-foreground" id="mod-list-where">
        It is in the game's mods folder: <span class="font-mono">%APPDATA%\\Factorio\\mods</span> on Windows,
        <span class="font-mono">~/.factorio/mods</span> on Linux, <span class="font-mono">~/Library/Application Support/factorio/mods</span> on macOS.
        Only enabled mods are imported.
      </p>
      <input
        #file
        id="mod-list-file"
        type="file"
        accept=".json,application/json"
        aria-describedby="mod-list-where"
        class="mt-1 text-sm file:me-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
        (change)="pick($event)"
        data-import-file
      />
    </div>
    <div class="flex flex-col gap-1">
      <label for="mod-list-text" class="font-medium">Or paste mod names</label>
      <textarea
        id="mod-list-text"
        rows="4"
        class="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
        placeholder="flib&#10;helmod&#10;Squeak Through"
        aria-describedby="mod-list-how"
        [value]="text()"
        (input)="text.set($any($event.target).value)"
        data-import-text
      ></textarea>
      <span class="flex items-center justify-between gap-2">
        <span id="mod-list-how" class="text-xs text-muted-foreground">One per line or comma-separated, by their names on the mod portal.</span>
        <button hlmBtn variant="outline" size="sm" [disabled]="!text().trim() || checking()" (click)="read(text(), 'pasted')" data-import-check>Check</button>
      </span>
    </div>

    @if (error(); as e) {
      <p class="text-destructive" role="alert" data-import-error>{{ e }}</p>
    }
    @if (checking()) {
      <p class="flex items-center gap-2 text-muted-foreground" data-import-checking><hlm-spinner /> Checking with the mod portal…</p>
    }
    <div aria-live="polite">
      @if (preview(); as p) {
        <section class="flex flex-col gap-3 rounded-lg border p-3" data-import-preview>
          <h3 class="font-medium" data-import-count>{{ p.add.length ? mods(p.add.length) + ' to add' : 'Nothing to add' }}{{ from() ? ' from ' + from() : '' }}</h3>
          @if (hasVersions()) {
            <label class="flex items-start gap-2">
              <input type="checkbox" class="mt-0.5 size-4 accent-[var(--brand)]" [checked]="keep()" (change)="keep.set(!keep())" data-import-keep />
              <span>Keep the versions in the file<span class="block text-xs text-muted-foreground">Unticked, each is the newest that fits Factorio {{ line() }}.</span></span>
            </label>
          }
          @if (p.add.length) {
            <ul class="divide-y rounded-md border">
              @for (m of p.add; track m.name) {
                <li class="flex items-center gap-2 px-3 py-1.5" [attr.data-import-add]="m.name">
                  <span class="min-w-0 flex-1">
                    <span class="block truncate">{{ m.title }}</span>
                    <span class="block truncate font-mono text-xs text-muted-foreground">{{ m.name }}</span>
                  </span>
                  <span class="shrink-0 text-xs text-muted-foreground">{{ m.version ?? 'Newest that fits' }}</span>
                </li>
              }
            </ul>
          }
          @if (p.already.length) {
            <p class="text-muted-foreground" data-import-already>{{ mods(p.already.length) }} already in the update: {{ p.already.join(', ') }}.</p>
          }
          @if (p.skipped.length) {
            <div data-import-skipped>
              <p class="font-medium">Skipped ({{ p.skipped.length }})</p>
              <ul class="list-inside list-disc text-muted-foreground">
                @for (s of p.skipped; track $index) {
                  <li data-import-skip><span class="font-mono text-xs">{{ s.name }}</span>: {{ s.why }}</li>
                }
              </ul>
            </div>
          }
          @if (p.left; as left) {
            <p class="text-xs text-muted-foreground" data-import-left>{{ left }}</p>
          }
          <button hlmBtn class="self-start" [disabled]="!!p.blocked" (click)="confirm(p)" data-import-go>{{ p.add.length ? 'Add ' + mods(p.add.length) : 'Add' }}</button>
          @if (p.blocked; as b) {
            <p class="text-xs text-muted-foreground" data-import-go-why>{{ b }}</p>
          }
        </section>
      }
    </div>
  `,
})
export class ModImport {
  readonly #http = inject(HttpClient);
  /** `/api/servers/<id>/game`. */
  readonly base = input.required<string>();
  /** The Factorio version picked in the sheet, whose line the names are checked for. */
  readonly factorio = input.required<string>();
  /** The sheet's picks, and the mods the catalog added for them: both in the update already. */
  readonly picks = input.required<string[]>();
  readonly required = input.required<ReadonlyMap<string, string>>();
  /** What the server runs: a mod it runs (removed in the sheet) comes back at its version, as Add by name does. */
  readonly installed = input.required<readonly { name: string; version: string }[]>();
  /** Confirm: the mods to put in the picks. */
  readonly add = output<GameModPick[]>();

  protected readonly mods = mods;
  protected readonly text = signal('');
  protected readonly keep = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly checking = signal(false);
  /** Where the list came from: the file's name, or "pasted". */
  protected readonly from = signal<string | null>(null);
  /** The list as read, and the hub's answer for the names it had to check. */
  readonly #list = signal<ModList | null>(null);
  readonly #answer = signal<ModCheckAnswer | null>(null);
  readonly #asks = new Subject<ModCheckRequest | null>();
  private readonly file = viewChild.required<ElementRef<HTMLInputElement>>('file');

  protected readonly line = computed(() => this.factorio().split('.').slice(0, 2).join('.'));
  protected readonly hasVersions = computed(() => !!this.#list()?.mods.some((m) => m.version !== null));
  protected readonly preview = computed<Preview | null>(() => {
    const list = this.#list();
    const answer = this.#answer();
    if (!list || !answer) return null;
    const inUpdate = (name: string) => this.picks().includes(name) || this.required().has(name);
    const fileVersion = new Map(list.mods.map((m) => [m.name, m.version]));
    const running = new Map(this.installed().map((m) => [m.name, m.version]));
    const add: Preview['add'] = [];
    const skipped: Preview['skipped'] = [];
    for (const m of answer.mods) {
      // A catalog answer that landed after the check went out can have made it a dependency meanwhile.
      if (inUpdate(m.name)) continue;
      if (m.found === 'fits') {
        const pinned = this.keep() ? fileVersion.get(m.name) : null;
        add.push({ name: m.name, title: m.title ?? m.name, version: pinned ?? running.get(m.name) ?? null });
      } else skipped.push({ name: m.name, why: FOUND[m.found](answer.line) });
    }
    skipped.push(...list.game.map((name) => ({ name, why: 'comes with Factorio' })));
    skipped.push(...list.invalid.map((name) => ({ name: shown(name), why: "not a mod's name" })));
    const left = [list.disabled.length && `${mods(list.disabled.length)} disabled in the file left out`, list.duplicates && `${list.duplicates} given twice, taken once`].filter(Boolean).join('; ');
    const total = this.picks().length + add.length;
    const blocked = !add.length ? 'Nothing here is new to the update.' : total > MODS_MAX ? `That makes ${total} mods: an update takes at most ${MODS_MAX}.` : null;
    return { add, already: list.mods.filter((m) => inUpdate(m.name)).map((m) => m.name), skipped, left: left ? `${left}.` : null, blocked };
  });

  constructor() {
    afterNextRender(() => this.file().nativeElement.focus());
    // A newer list's check replaces an older one's, whose answer is dropped.
    this.#asks
      .pipe(
        switchMap((req) => {
          if (!req) return of({ line: this.line(), mods: [] } satisfies ModCheckAnswer);
          this.checking.set(true);
          return this.#http.post<ModCheckAnswer>(`${this.base()}/check`, req).pipe(
            map((a) => a as ModCheckAnswer | null),
            catchError((err: HttpErrorResponse) => (this.error.set(`The mod portal check: ${why(err)}`), of(null))),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((answer) => {
        this.checking.set(false);
        this.#answer.set(answer);
      });
  }

  /** A file picked: its size checked before it is read. */
  protected async pick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = ''; // so picking the same file again (fixed, say) reads it again
    if (file.size > LIST_MAX_BYTES) return this.#fail(`${file.name} is over ${LIST_MAX_BYTES / 1024} KiB: a mod-list.json is much smaller.`);
    let text: string;
    try {
      text = await file.text();
    } catch {
      return this.#fail(`${file.name} can't be read.`);
    }
    this.read(text, file.name);
  }

  /** Reads a list; the names not in the update yet go to the hub to check. */
  protected read(text: string, from: string): void {
    let list: ModList;
    try {
      list = parseModList(text);
    } catch (err) {
      if (err instanceof ModListError) return this.#fail(err.message);
      throw err;
    }
    this.error.set(null);
    this.from.set(from);
    this.#list.set(list);
    this.#answer.set(null);
    const names = list.mods.map((m) => m.name).filter((n) => !this.picks().includes(n) && !this.required().has(n));
    this.#asks.next(names.length ? { factorio: this.factorio(), names } : null);
  }

  protected confirm(p: Preview): void {
    if (!p.blocked) this.add.emit(p.add.map(({ name, version }) => ({ name, version })));
  }

  #fail(message: string): void {
    this.#asks.next(null); // drops a check still running for an earlier list
    this.error.set(message);
    this.#list.set(null);
    this.#answer.set(null);
    this.from.set(null);
  }
}

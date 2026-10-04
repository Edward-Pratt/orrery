import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { LibraryAdd, LibraryAddAnswer, LibraryAddRequest, LibraryPack, LibraryState } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleAlert, lucidePackage, lucidePlus } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { catchError, debounceTime, EMPTY, filter, firstValueFrom, startWith, Subject, switchMap } from 'rxjs';
import { LiveEvents, ofTarget } from '../events';
import { Feedback } from '../feedback';
import { formatBytes } from '../units';
import { Uploader } from '../uploads';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** A pack's name and version from its zip's file name ("GT_New_Horizons_2.7.4_Server_Java_17-21.zip"): a guess to correct. */
export function fromFileName(file: string): { name: string; version: string } {
  const base = file.split(/[/?#]/).filter(Boolean).at(-1)?.replace(/\.zip$/i, '') ?? '';
  const m = /\d+\.\d+(?:\.\d+)*(?:-(?:beta|rc|pre)(?:[-.]?\d+)*)?/i.exec(base);
  if (!m) return { name: base.replace(/[_-]+/g, ' ').trim(), version: '' };
  return { name: base.slice(0, m.index).replace(/[_-]+/g, ' ').trim(), version: m[0] };
}

/**
 * The Library page: the Environment's pack versions, newest first, an add sheet (a link or an upload) and the running
 * add's card with its progress and Cancel, followed live from `libraryAdd` events. Delete asks for the typed name.
 */
@Component({
  selector: 'app-library',
  imports: [DatePipe, DecimalPipe, NgIcon, HlmButton, HlmInput, HlmSheetImports, HlmSkeleton, HlmSpinner, HlmToggleGroupImports],
  viewProviders: [provideIcons({ lucideCircleAlert, lucidePackage, lucidePlus })],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Library</h1>
    <section class="flex max-w-4xl flex-col gap-4" data-packs>
      <div class="flex items-center gap-3">
        <h2 class="text-base font-semibold">Packs</h2>
        <button hlmBtn size="sm" class="ml-auto" [disabled]="!!running()" (click)="openSheet()" data-add>
          <ng-icon name="lucidePlus" /> Add pack
        </button>
      </div>
      @if (running(); as r) {
        <div class="flex flex-wrap items-center gap-3 rounded-xl border p-4 text-sm" data-running>
          <hlm-spinner />
          <span class="min-w-0 flex-1">
            Adding <b>{{ r.name }} {{ r.version }}</b><span class="text-muted-foreground"> (by {{ r.by }})</span>
            <span class="block text-xs text-muted-foreground" data-detail>{{ r.detail }}</span>
          </span>
          <button hlmBtn variant="outline" size="sm" [disabled]="busy()" (click)="cancel()" data-cancel>Cancel</button>
        </div>
      }
      @if (ended(); as e) {
        <div
          class="flex items-center gap-3 rounded-xl border p-3 text-sm"
          [class]="e.outcome === 'failed' ? 'border-status-down/40 bg-status-down/10' : 'bg-muted'"
          [attr.data-ended]="e.outcome"
        >
          @if (e.outcome === 'failed') {
            <ng-icon name="lucideCircleAlert" class="text-status-down" />
            <span>Adding {{ e.name }} {{ e.version }} failed: {{ e.reason }}</span>
          } @else {
            <span>{{ e.reason }}</span>
          }
        </div>
      }
      @if (state(); as s) {
        @if (s.packs.length) {
          <ul class="divide-y rounded-lg border">
            @for (p of s.packs; track p.id) {
              <li class="flex flex-wrap items-start gap-x-4 gap-y-1 p-3 text-sm" [attr.data-pack]="p.id">
                <div class="min-w-0 flex-1">
                  <p class="font-medium" data-name>{{ p.name }} {{ p.version }}</p>
                  <p class="text-xs text-muted-foreground" data-meta>
                    Minecraft {{ p.mc }} · {{ p.loader }} · {{ bytes(p.size) }} · added by {{ p.by }} {{ p.at | date: 'd MMM y HH:mm' }}
                  </p>
                  <p class="truncate text-xs text-muted-foreground" [title]="p.source" data-source>{{ p.source }}</p>
                  <p class="truncate font-mono text-xs text-muted-foreground" [title]="p.sha256" data-sha>sha256 {{ p.sha256 }}</p>
                </div>
                <span class="text-xs text-muted-foreground" data-used>{{ p.usedBy.length ? 'used by ' + p.usedBy.join(', ') : 'used by no server' }}</span>
                <button hlmBtn variant="ghost" size="sm" [disabled]="busy()" (click)="remove(p)" data-delete>Delete</button>
              </li>
            }
          </ul>
        } @else {
          <div class="rounded-xl border border-dashed p-8 text-center" data-empty>
            <ng-icon name="lucidePackage" class="text-3xl text-muted-foreground" />
            <p class="mt-2 font-medium">No packs yet</p>
            <p class="text-sm text-muted-foreground">Add a pack version from a link or an upload: servers install and update from here.</p>
          </div>
        }
      } @else if (missing(); as why) {
        <p class="text-muted-foreground">{{ why }}</p>
      } @else {
        <hlm-skeleton class="h-24 rounded-lg" data-skeleton />
      }
    </section>

    @if (sheet()) {
      <hlm-sheet side="right" state="open" (closed)="sheet.set(false)">
        <hlm-sheet-content *hlmSheetPortal="let ctx" class="data-[side=right]:w-full data-[side=right]:sm:max-w-md" data-sheet>
          <hlm-sheet-header>
            <h2 hlmSheetTitle>Add pack</h2>
          </hlm-sheet-header>
          <div class="flex flex-col gap-3 px-4 pb-4 text-sm">
            <hlm-toggle-group type="single" [value]="from()" (valueChange)="from.set($any($event) || from())" class="w-full">
              <button hlmToggleGroupItem value="url" class="flex-1" data-from-url>Link</button>
              <button hlmToggleGroupItem value="upload" class="flex-1" data-from-upload>Upload</button>
            </hlm-toggle-group>
            @if (from() === 'url') {
              <label>Pack URL <input hlmInput class="mt-1 w-full" [value]="url()" (input)="setUrl($any($event.target).value)" data-url /></label>
            } @else {
              <label>Zip <input type="file" accept=".zip" hlmInput class="mt-1 w-full" (change)="setFile($any($event.target).files?.[0])" data-file /></label>
            }
            <div class="grid grid-cols-2 gap-2">
              <label>Name <input hlmInput class="mt-1 w-full" [value]="name()" (input)="name.set($any($event.target).value)" data-name /></label>
              <label>Version <input hlmInput class="mt-1 w-full" [value]="version()" (input)="version.set($any($event.target).value)" data-version /></label>
              <label>Minecraft <input hlmInput class="mt-1 w-full" placeholder="from the zip" [value]="mc()" (input)="mc.set($any($event.target).value)" data-mc /></label>
              <label>Loader <input hlmInput class="mt-1 w-full" placeholder="from the zip" [value]="loader()" (input)="loader.set($any($event.target).value)" data-loader /></label>
            </div>
            <p class="text-xs text-muted-foreground">
              Name and version are read from the file name; fix them if wrong. Left blank, the Minecraft version and loader are read from the zip's Forge jar.
            </p>
            <button hlmBtn [disabled]="busy() || !ready()" (click)="add()" data-go>
              @if (busy()) {
                <hlm-spinner />
              }
              Add to library
            </button>
            @if (uploaded() !== null) {
              <p class="text-xs text-muted-foreground" data-uploaded>Uploading… {{ uploaded()! * 100 | number: '1.0-0' }}%</p>
            }
            <p class="text-xs text-muted-foreground">It runs in the background: you can leave the page.</p>
          </div>
        </hlm-sheet-content>
      </hlm-sheet>
    }
  `,
})
export default class Library {
  readonly #http = inject(HttpClient);
  readonly #uploader = inject(Uploader);
  readonly #feedback = inject(Feedback);
  readonly #reload = new Subject<void>();
  protected readonly bytes = formatBytes;

  readonly state = signal<LibraryState | null>(null);
  protected readonly missing = signal<string | null>(null);
  protected readonly running = computed(() => this.state()?.running ?? null);
  /** How the last add watched here ended, when there is something to say: a failure, or "already in the library". */
  protected readonly ended = signal<Extract<LibraryAdd, { phase: 'finished' }> | null>(null);
  protected readonly busy = signal(false);
  protected readonly uploaded = signal<number | null>(null);
  protected readonly sheet = signal(false);
  protected readonly from = signal<'url' | 'upload'>('url');
  protected readonly url = signal('');
  protected readonly file = signal<File | null>(null);
  protected readonly name = signal('');
  protected readonly version = signal('');
  protected readonly mc = signal('');
  protected readonly loader = signal('');
  protected readonly ready = computed(
    () => (this.from() === 'url' ? /^https:\/\//.test(this.url().trim()) : !!this.file()) && !!this.name().trim() && !!this.version().trim(),
  );

  constructor() {
    this.#reload
      .pipe(
        debounceTime(50),
        startWith(undefined),
        switchMap(() =>
          this.#http.get<LibraryState>('/api/library').pipe(
            catchError((err: HttpErrorResponse) => {
              if (!this.state()) this.missing.set(`The hub didn't answer (HTTP ${err.status}).`);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((s) => this.state.set(s));
    inject(LiveEvents)
      .all$.pipe(filter(ofTarget('library')), takeUntilDestroyed())
      .subscribe(({ event: e }) => {
        if (e.type !== 'libraryAdd') return;
        const s = this.state();
        if (e.phase === 'finished') {
          this.ended.set(e.outcome === 'failed' || e.reason ? e : null);
          return this.#reload.next();
        }
        this.ended.set(null);
        if (s?.running?.add === e.add) this.state.set({ ...s, running: { ...s.running, detail: e.detail } });
        else this.#reload.next(); // started elsewhere: fetch it
      });
  }

  protected openSheet(): void {
    for (const s of [this.url, this.name, this.version, this.mc, this.loader]) s.set('');
    this.file.set(null);
    this.sheet.set(true);
  }

  protected setUrl(url: string): void {
    this.url.set(url);
    this.#guess(url);
  }

  protected setFile(file: File | undefined): void {
    this.file.set(file ?? null);
    if (file) this.#guess(file.name);
  }

  #guess(file: string): void {
    const { name, version } = fromFileName(file);
    if (name) this.name.set(name);
    if (version) this.version.set(version);
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

  protected async add(): Promise<void> {
    const fields = { name: this.name().trim(), version: this.version().trim(), mc: this.mc().trim(), loader: this.loader().trim() };
    const answer = await this.#request(`Adding ${fields.name} ${fields.version}`, async () => {
      let body: LibraryAddRequest;
      if (this.from() === 'url') body = { url: this.url().trim(), ...fields };
      else {
        this.uploaded.set(0);
        try {
          body = { upload: await this.#uploader.send(this.file()!, (share) => this.uploaded.set(share)), ...fields };
        } finally {
          this.uploaded.set(null);
        }
      }
      return firstValueFrom(this.#http.post<LibraryAddAnswer>('/api/library/packs', body));
    });
    if (!answer) return;
    this.sheet.set(false);
    this.ended.set(null);
    this.#reload.next();
  }

  protected async cancel(): Promise<void> {
    await this.#request('Cancelling', () => firstValueFrom(this.#http.post('/api/library/cancel', null, { headers: JSON_HEADERS })));
  }

  protected async remove(p: LibraryPack): Promise<void> {
    const what = `${p.name} ${p.version}`;
    const ok = await this.#feedback.confirm({
      title: `Delete ${what}?`,
      verb: `Delete ${what}`,
      description: `Its zip (${formatBytes(p.size)}) is deleted from the host. Add it again to get it back.`,
      destructive: true,
      typeName: what,
    });
    if (!ok) return;
    const done = await this.#request(`Deleting ${what}`, async () => {
      await firstValueFrom(this.#http.delete(`/api/library/packs/${p.id}`, { headers: JSON_HEADERS }));
      return true;
    });
    if (!done) return;
    this.#feedback.ok(`Deleted ${what}.`);
    this.#reload.next();
  }
}

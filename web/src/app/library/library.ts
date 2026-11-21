import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { LibraryAdd, LibraryAddAnswer, LibraryPack, LibraryRuntime, LibraryState, RuntimeAddRequest } from '@hub/api';
import { catchError, debounceTime, EMPTY, filter, firstValueFrom, startWith, Subject, switchMap } from 'rxjs';
import { LiveEvents, ofTarget } from '../events';
import { Feedback } from '../feedback';
import { formatBytes } from '../units';
import { LibraryPacks } from './library-packs';
import { LibraryRunning } from './library-running';
import { LibraryRuntimes } from './library-runtimes';
import { LibrarySheet, type SheetSave } from './library-sheet';

export { fromFileName } from './library-rules';

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * The Library page: the running add's card (either kind) with its progress and Cancel (`library-running.ts`), followed
 * live from `libraryAdd` events, the Environment's pack versions, newest first (`library-packs.ts`), its Java runtimes
 * (`library-runtimes.ts`), and their add sheets (`library-sheet.ts`: a link, an Actions artifact or an upload; a Java
 * version). Delete asks for the typed name. It holds the state, the stream and every request; the pure rules are
 * `library-rules.ts`.
 */
@Component({
  selector: 'app-library',
  imports: [LibraryPacks, LibraryRunning, LibraryRuntimes, LibrarySheet],
  template: `
    <h1 class="ar-t-heading-md mb-4">Library</h1>
    <app-library-running [running]="running()" [ended]="ended()" [busy]="busy()" (cancel)="cancel()" />
    <app-library-packs [state]="state()" [missing]="missing()" [running]="running()" [busy]="busy()" (add)="openSheet()" (remove)="remove($event)" />

    @if (state(); as s) {
      <app-library-runtimes [state]="s" [running]="running()" [busy]="busy()" (add)="openRuntimeSheet()" (remove)="removeRuntime($event)" />
    }

    <app-library-sheet [sheet]="sheet()" [busy]="busy()" (closed)="sheet.set(null)" (save)="add($event)" (addRuntime)="addRuntime($event)" />
  `,
})
export default class Library {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly #reload = new Subject<void>();
  private readonly form = viewChild.required(LibrarySheet);

  readonly state = signal<LibraryState | null>(null);
  protected readonly missing = signal<string | null>(null);
  protected readonly running = computed(() => this.state()?.running ?? null);
  /** How the last add watched here ended, when there is something to say: a failure, or "already in the library". */
  protected readonly ended = signal<Extract<LibraryAdd, { phase: 'finished' }> | null>(null);
  protected readonly busy = signal(false);
  protected readonly sheet = signal<'pack' | 'runtime' | null>(null);

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
    this.form().open('pack');
    this.sheet.set('pack');
  }

  protected openRuntimeSheet(): void {
    this.form().open('runtime');
    this.sheet.set('runtime');
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

  protected async add(c: SheetSave): Promise<void> {
    const answer = await this.#request(c.what, c.run);
    if (!answer) return;
    this.sheet.set(null);
    this.ended.set(null);
    this.#reload.next();
  }

  protected async addRuntime(feature: RuntimeAddRequest['feature']): Promise<void> {
    const body: RuntimeAddRequest = { feature };
    const answer = await this.#request(`Adding Temurin ${body.feature}`, () => firstValueFrom(this.#http.post<LibraryAddAnswer>('/api/library/runtimes', body)));
    if (!answer) return;
    this.sheet.set(null);
    this.ended.set(null);
    this.#reload.next();
  }

  protected async removeRuntime(r: LibraryRuntime): Promise<void> {
    const ok = await this.#feedback.confirm({
      title: `Delete ${r.label}?`,
      verb: `Delete ${r.label}`,
      description: `Its JDK is deleted from the host. Add it again to get it back.`,
      destructive: true,
      typeName: r.name,
    });
    if (!ok) return;
    const done = await this.#request(`Deleting ${r.label}`, async () => {
      await firstValueFrom(this.#http.delete(`/api/library/runtimes/${encodeURIComponent(r.name)}`, { headers: JSON_HEADERS }));
      return true;
    });
    if (!done) return;
    this.#feedback.ok(`Deleted ${r.label}.`);
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

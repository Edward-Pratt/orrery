import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { CompareReport, ConfigEdit, Extra, LibraryState, PackRuntimeRequest, PackState, PackUpdateAnswer, PackUpdateRequest, RunningPackUpdate } from '@hub/api';
import { catchError, debounceTime, EMPTY, filter, firstValueFrom, Observable, startWith, Subject, switchMap } from 'rxjs';
import { LiveEvents, ofServer, ofTarget } from '../events';
import { Feedback } from '../feedback';
import { PackAdopt } from './pack-adopt';
import { PackEdits } from './pack-edits';
import { PackExtras } from './pack-extras';
import { PackKept } from './pack-kept';
import { PackRolledBack } from './pack-rolled-back';
import { confirmText, runtimeLabel, type Sheet, withStep } from './pack-rules';
import { PackSheet, type SheetSave } from './pack-sheet';
import { PackSummary } from './pack-summary';
import ServerPage from './server';
import { failedPrep, UpdateHistory, UpdateSteps } from './update-steps';

const PENDING_TOAST = 'Saved: changes pending, not on the server until you apply them.';

/**
 * A server's Pack section (only for a server that can have one): Adopt as the empty state (`pack-adopt.ts`), then the
 * installed pack with its one primary action (`pack-summary.ts`), Extras (`pack-extras.ts`), Config edits
 * (`pack-edits.ts`), Kept paths (`pack-kept.ts`) and the history; the running update's steps in place of the summary,
 * followed live from `packUpdateStep` notices. Adding or changing an Extra or edit asks nothing: it only marks changes
 * pending. An update or apply asks once (a dialog); restoring after a rollback (`pack-rolled-back.ts`'s offer) is the
 * Backups tab's typed restore. It holds the state, the stream and every request; the sheets are `pack-sheet.ts`, the
 * library picker `pack-source.ts`, the pure rules `pack-rules.ts`.
 */
@Component({
  selector: 'app-server-pack',
  imports: [PackAdopt, PackEdits, PackExtras, PackKept, PackRolledBack, PackSheet, PackSummary, UpdateHistory, UpdateSteps],
  template: `
    @if (state(); as p) {
      <div class="flex max-w-4xl flex-col gap-8">
        @if (!p.installed) {
          <app-pack-adopt
            [report]="report()"
            [keep]="keep()"
            [busy]="busy()"
            [library]="library()"
            [pick]="pick()"
            [picked]="picked()"
            (pickChange)="pick.set($event)"
            (compare)="compare()"
            (toggled)="toggle($event)"
            (adopt)="adopt()"
            (back)="report.set(null)"
          />
        } @else {
          @if (p.rolledBack; as rb) {
            <app-pack-rolled-back [rolledBack]="rb" [version]="p.installed.version" />
          }

          @if (running(); as r) {
            <app-update-steps [title]="'Updating to ' + r.name + ' ' + r.version" [update]="r" [busy]="busy()" (cancel)="cancel()" />
          } @else {
            <app-pack-summary
              [state]="p"
              [installed]="p.installed"
              [done]="done()"
              [blocked]="blocked()"
              [busy]="busy()"
              [library]="library()"
              [failedPrep]="failedPrep()"
              (open)="openSheet($event)"
              (apply)="apply()"
              (runtime)="setRuntime($event)"
            />
          }

          <app-pack-extras [state]="p" (open)="openSheet($event)" (remove)="removeExtra($event)" />

          <app-pack-edits [state]="p" (open)="openSheet($event)" (remove)="removeEdit($event)" />
        }

        <app-pack-kept [state]="p" />

        <app-update-history [rows]="p.history" empty="No pack updates yet." changesPrefix="changes applied: " />
      </div>
    } @else if (missing(); as why) {
      <p class="text-muted-foreground">{{ why }}</p>
    }

    <app-pack-sheet
      [sheet]="sheet()"
      [base]="base"
      [state]="state()"
      [busy]="busy()"
      [library]="library()"
      [pick]="pick()"
      [picked]="picked()"
      (pickChange)="pick.set($event)"
      (closed)="sheet.set(null)"
      (update)="update()"
      (save)="saved($event)"
    />
  `,
})
export default class Pack {
  readonly #server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  protected readonly base = `/api/servers/${encodeURIComponent(this.#server.id)}/pack`;
  private readonly form = viewChild.required(PackSheet);

  readonly state = signal<PackState | null>(null);
  protected readonly missing = signal<string | null>(null);
  /** The update under way, kept current from the stream. */
  protected readonly running = signal<RunningPackUpdate | null>(null);
  /** The version an update watched here just put in place, for the summary card's "Done" line. */
  protected readonly done = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly sheet = signal<Sheet | null>(null);
  protected readonly report = signal<CompareReport | null>(null);
  protected readonly keep = signal(new Set<string>());

  // The library version picked (Adopt and Update pack).
  protected readonly library = signal<LibraryState | null>(null);
  protected readonly pick = signal<number | null>(null);
  protected readonly picked = computed(() => this.library()?.packs.find((e) => e.id === this.pick()) ?? null);
  readonly #reload = new Subject<void>();

  /** Why an update can't start now: the hub's reason, or the server being offline (the backup needs it). */
  protected readonly blocked = computed(() => {
    const card = this.#server.card();
    return this.state()?.blocked ?? (card && !card.online ? `${card.name} is offline: an update needs it running, for the backup.` : null);
  });
  /** The latest update, when it failed while preparing: its cause, for the red box. */
  protected readonly failedPrep = computed(() => failedPrep(this.state()?.history ?? []));

  constructor() {
    this.#reload
      .pipe(
        debounceTime(50),
        startWith(undefined),
        switchMap(() =>
          this.#http.get<PackState>(this.base).pipe(
            catchError((err: HttpErrorResponse) => {
              if (!this.state()) this.missing.set(err.status === 404 ? 'This server has no pack.' : `The hub didn't answer (HTTP ${err.status}).`);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((p) => {
        this.#show(p);
        if (!this.library()) this.#fetchLibrary();
      });
    const events = inject(LiveEvents).all$;
    // A Mod deploy starting or ending changes why an update can't start.
    events.pipe(filter(ofTarget('deploy')), takeUntilDestroyed()).subscribe(() => this.#reload.next());
    events
      .pipe(filter(ofServer(this.#server.id)), takeUntilDestroyed())
      .subscribe(({ event: e }) => {
        if (e.type !== 'notice') return;
        if (e.kind === 'packUpdateStep') {
          const r = this.running();
          if (!r) return this.#reload.next(); // started elsewhere: fetch it with its steps
          this.running.set(withStep(r, e));
        } else if (e.kind === 'packUpdateStarted') {
          this.done.set(null);
          this.#reload.next();
        } else if (e.kind === 'packUpdateFinished') {
          if (e.outcome === 'ok' && this.running()) this.done.set(e.to);
          this.#reload.next();
        }
      });
  }

  #show(p: PackState): void {
    this.state.set(p);
    this.running.set(p.running);
  }

  /** The library's versions and runtimes, to pick from. */
  #fetchLibrary(): void {
    this.#http.get<LibraryState>('/api/library').subscribe({
      next: (l) => this.library.set(l),
      error: (err: HttpErrorResponse) => this.#feedback.failed('Reading the library', err),
    });
  }

  protected openSheet(s: Sheet): void {
    this.form().open(s);
    if (s.kind === 'update') {
      this.pick.set(null);
      this.#fetchLibrary();
    }
    this.sheet.set(s);
  }

  protected toggle(path: string): void {
    this.keep.update((k) => {
      const next = new Set(k);
      if (!next.delete(path)) next.add(path);
      return next;
    });
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

  protected async compare(): Promise<void> {
    const report = await this.#request('Comparing', async () => firstValueFrom(this.#http.post<CompareReport>(`${this.base}/compare`, { library: this.pick()! })));
    if (!report) return;
    this.keep.set(new Set()); // nothing kept unless ticked
    this.report.set(report);
  }

  protected async adopt(): Promise<void> {
    const p = await this.#request('Adopting', () => firstValueFrom(this.#http.post<PackState>(`${this.base}/adopt`, { keep: [...this.keep()] })));
    if (!p) return;
    this.report.set(null);
    this.#show(p);
    this.#feedback.ok(`Adopted ${p.installed!.name} ${p.installed!.version}.`);
  }

  protected async update(): Promise<void> {
    const server = this.#server.card()!.name;
    const { id, name, version } = this.picked()!;
    this.sheet.set(null);
    const ok = await this.#feedback.confirm({ title: `Update ${server} to ${name} ${version}?`, description: confirmText(this.#server.card()?.players.length ?? 0), verb: `Update to ${version}` });
    if (ok) await this.#start(async () => ({ library: id }));
  }

  protected async apply(): Promise<void> {
    const n = this.state()!.pending.length;
    const ok = await this.#feedback.confirm({
      title: `Apply ${n} change${n === 1 ? '' : 's'} to ${this.#server.card()!.name}?`,
      description: confirmText(this.#server.card()?.players.length ?? 0),
      verb: 'Apply and restart',
    });
    if (ok) await this.#start(async () => ({ pending: true }));
  }

  async #start(body: () => Promise<PackUpdateRequest>): Promise<void> {
    const answer = await this.#request('Starting the update', async () => firstValueFrom(this.#http.post<PackUpdateAnswer>(`${this.base}/update`, await body())));
    if (answer) this.#reload.next();
  }

  /** Points the server's Java link at a runtime (null: the host's own java), from its next start. */
  protected async setRuntime(name: string | null): Promise<void> {
    const body: PackRuntimeRequest = { runtime: name };
    const p = await this.#request('Setting the Java runtime', () => firstValueFrom(this.#http.put<PackState>(`${this.base}/runtime`, body)));
    if (!p) return;
    this.#show(p);
    this.#feedback.ok(`Set to ${runtimeLabel(this.library(), name)}: it applies at the server's next restart.`);
  }

  protected async cancel(): Promise<void> {
    const done = await this.#request('Cancelling the update', () => firstValueFrom(this.#http.post(`${this.base}/update/cancel`, {})));
    if (done !== undefined) this.#feedback.ok('Cancelling: the server is not touched.');
  }

  /** Saves a change to the pack's Extras or edits, which only marks changes pending. */
  async #change(what: string, run: () => Observable<PackState>): Promise<void> {
    const p = await this.#request(what, () => firstValueFrom(run()));
    if (!p) return;
    this.sheet.set(null);
    this.#show(p);
    this.#feedback.ok(PENDING_TOAST);
  }

  /** Runs a change a sheet saves. */
  protected saved(c: SheetSave): Promise<void> {
    return this.#change(c.what, c.run);
  }

  protected removeExtra(e: Extra): Promise<void> {
    return this.#change(`Removing ${e.target}`, () => this.#http.delete<PackState>(`${this.base}/extras/${e.id}`, { headers: { 'content-type': 'application/json' } }));
  }

  protected removeEdit(c: ConfigEdit): Promise<void> {
    return this.#change(`Removing the edit of ${c.path}`, () => this.#http.delete<PackState>(`${this.base}/edits/${c.id}`, { headers: { 'content-type': 'application/json' } }));
  }
}

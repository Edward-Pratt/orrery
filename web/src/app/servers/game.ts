import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { GameState, GameUpdateAnswer, LiveEvent, PackStep, RunningGameUpdate } from '@hub/api';
import { catchError, debounceTime, EMPTY, filter, firstValueFrom, startWith, Subject, switchMap } from 'rxjs';
import { LiveEvents, ofServer, ofTarget } from '../events';
import { Feedback } from '../feedback';
import { changesCard } from './changes';
import { GameSheet } from './game-sheet';
import { GameSummary } from './game-summary';
import { PortalUpdates } from './mod-updates';
import ServerPage from './server';
import { failedPrep, PACK_STEPS, UpdateHistory, UpdateSteps } from './update-steps';

const STEPS: Record<PackStep, string> = { ...PACK_STEPS, backup: 'Save' };
/** A Host's Agent went silent or came back: whether a game update can start changes. */
const agentNotice = (e: LiveEvent) => 'target' in e && e.target === 'host' && e.type === 'notice' && (e.kind === 'agentLost' || e.kind === 'agentBack');

/**
 * A factorio server's Game section (only with `features.update`): what it runs (`game-summary.ts`), Update game (a
 * sheet, `game-sheet.ts`, with its update view `game-update-view.ts`: the Factorio version and the portal mods, each at
 * a version or the newest that fits, checked against the mod portal through the hub's catalog on every change), and the
 * history; the running update's steps in place of the summary, followed live from `packUpdateStep` notices like the
 * Pack section's. It answers for a stopped server too: the update then starts it. It holds the state, the stream, the
 * tab's `PortalUpdates` and the update's requests; the sheet holds the picks and the catalog's answer.
 */
@Component({
  selector: 'app-server-game',
  imports: [GameSheet, GameSummary, UpdateHistory, UpdateSteps],
  providers: [PortalUpdates],
  template: `
    @if (state(); as g) {
      <div class="flex max-w-4xl flex-col gap-8">
        @if (running(); as r) {
          <app-update-steps [title]="'Updating ' + r.from + ' → ' + r.to" [update]="r" [labels]="steps" [busy]="busy()" (cancel)="cancel()" />
        } @else {
          <app-game-summary [state]="g" [done]="done()" [busy]="busy()" [failedPrep]="failedPrep()" (open)="open($event)" />
        }
        <app-update-history [rows]="g.history" empty="No game updates yet." />
      </div>
    } @else if (missing(); as why) {
      <p class="text-muted-foreground">{{ why }}</p>
    }

    <app-game-sheet [sheet]="sheet()" [base]="base" [state]="state()" [busy]="busy()" (closed)="sheet.set(false)" (start)="start()" />
  `,
})
export default class Game {
  readonly #server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  protected readonly updates = inject(PortalUpdates);
  protected readonly base = `/api/servers/${encodeURIComponent(this.#server.id)}/game`;
  protected readonly steps = STEPS;
  private readonly form = viewChild.required(GameSheet);

  readonly state = signal<GameState | null>(null);
  protected readonly missing = signal<string | null>(null);
  /** The update under way, kept current from the stream. */
  protected readonly running = signal<RunningGameUpdate | null>(null);
  /** What an update watched here just put in place, for the summary card's "Done" line. */
  protected readonly done = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly failedPrep = computed(() => failedPrep(this.state()?.history ?? []));
  /** Whether the Update game sheet is open. */
  protected readonly sheet = signal(false);
  readonly #reload = new Subject<void>();

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
        // What the server runs changed (or is first known): its portal mod updates are asked again.
        if (JSON.stringify(g.installed) !== JSON.stringify(this.state()?.installed ?? undefined)) this.updates.reload();
        this.state.set(g);
        this.running.set(g.running);
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

  /**
   * Opens the sheet on what the server runs now: its Factorio version and portal mods at their versions, or with
   * `allUpdates` each mod with a portal mod update at "Newest that fits".
   */
  protected open(allUpdates = false): void {
    const i = this.state()!.installed!;
    const newest = allUpdates ? this.updates.to() : new Map<string, string>();
    this.form().open(i, newest);
    this.sheet.set(true);
    this.form().ask();
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
    const req = this.form().request();
    const changes = this.form().current()!.changes;
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

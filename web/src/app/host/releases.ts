import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { DeployAnswer, DeployOutcome, DeployRequest, DeploysAnswer, LiveEvent } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { debounceTime, filter } from 'rxjs';
import { LiveEvents, ofTarget } from '../events';
import { Feedback } from '../feedback';
import { releaseRows, short, type ReleaseRow } from './release-rows';

/** A pack update started or ended: Deploy may be refused or allowed again. */
const packNotice = (e: LiveEvent) => 'serverId' in e && e.type === 'notice' && (e.kind === 'packUpdateStarted' || e.kind === 'packUpdateFinished');

const OUTCOME: Record<DeployOutcome, string> = {
  running: 'bg-muted text-muted-foreground',
  ok: 'bg-status-ok/15 text-status-ok',
  failed: 'bg-status-down/15 text-status-down',
  'rolled back': 'bg-status-down/15 text-status-down',
};

/**
 * The Host page's Releases section (only with the GitHub integration): what each part runs against the latest
 * published release, Deploy (pick a release, confirm the change), the deploy history, and Check now. Fetched again
 * on each deploy notice; the stream's reconnect covers the hub restarting during its own deploy.
 */
@Component({
  selector: 'app-releases',
  imports: [DatePipe, HlmButton, HlmSpinner],
  template: `
    <section id="releases" class="mt-8" data-releases>
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <h2 class="text-base font-semibold">Releases</h2>
        @if (answer(); as a) {
          <span class="text-xs text-muted-foreground" data-checked>
            @if (a.checkedAt) {
              Checked {{ a.checkedAt | date: 'd MMM HH:mm' }}
            }
          </span>
          @if (a.error) {
            <span class="text-xs text-status-down" data-error>Last check failed: {{ a.error }}</span>
          }
        }
        <button hlmBtn variant="outline" size="sm" class="ml-auto" [disabled]="checking()" (click)="check()" data-check>
          @if (checking()) {
            <hlm-spinner />
          }
          Check now
        </button>
      </div>
      <ul class="divide-y rounded-lg border">
        @for (r of rows(); track r.key) {
          <li class="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 text-sm" [attr.data-row]="r.key">
            <span class="w-36 font-medium">{{ r.label }}</span>
            <span class="min-w-0 flex-1">
              <span data-running>{{ r.running ?? 'unknown' }}</span>
              <span class="text-muted-foreground"> · latest <span data-latest>{{ r.latest ?? 'none' }}</span></span>
              @if (r.newer) {
                <span class="ml-2 rounded-full bg-amber-500/20 px-2 text-xs text-amber-700 dark:text-amber-300" data-newer>newer available</span>
              }
            </span>
            @if (r.deploying) {
              <span class="flex items-center gap-2 text-muted-foreground" data-deploying><hlm-spinner /> deploying {{ r.deploying.to }}</span>
            } @else if (picking() === r.key) {
              <span class="flex items-center gap-2">
                <select class="h-8 rounded-md border bg-background px-2 text-sm" data-pick [value]="choice()" (change)="choice.set($any($event.target).value)">
                  @for (rel of r.releases; track rel.tag) {
                    <option [value]="rel.tag" [selected]="rel.tag === choice()">{{ rel.tag }}{{ older(r, rel.tag) ? ' (older)' : '' }}{{ rel.tag === r.running ? ' (running)' : '' }}</option>
                  }
                </select>
                <button hlmBtn size="sm" [disabled]="posting() || choice() === r.running" (click)="deploy(r)" data-next>Deploy…</button>
                <button hlmBtn variant="ghost" size="sm" (click)="picking.set(null)">Cancel</button>
              </span>
            } @else if (r.releases.length) {
              @if (r.why) {
                <span class="text-xs text-muted-foreground" data-why>{{ r.why }}</span>
              }
              <button hlmBtn variant="outline" size="sm" [disabled]="busy() || !!r.why" (click)="pick(r)" data-deploy>Deploy</button>
            }
          </li>
        }
      </ul>
      @if (answer()?.history?.length) {
        <h3 class="mt-6 mb-2 text-sm font-semibold">History</h3>
        <ul class="divide-y rounded-lg border text-sm" data-history>
          @for (h of answer()!.history; track h.id) {
            <li class="p-3" [attr.data-deploy-row]="h.id">
              <div class="flex flex-wrap items-center gap-x-3">
                <span class="rounded-full px-2 text-xs" [class]="outcome[h.outcome]" data-outcome>{{ h.outcome }}</span>
                <span>{{ h.part === 'mod' ? 'Mod on ' + h.target : h.part === 'web' ? 'dashboard' : 'hub' }}: {{ h.from ?? 'unknown' }} → {{ h.to }}</span>
                <span class="text-muted-foreground">{{ h.by }}, {{ h.started | date: 'd MMM HH:mm' }}</span>
              </div>
              @if (h.log) {
                <details class="mt-1">
                  <summary class="cursor-pointer text-xs text-muted-foreground">Log</summary>
                  <pre class="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs" data-log>{{ h.log }}</pre>
                </details>
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class Releases {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  protected readonly outcome = OUTCOME;
  readonly answer = signal<DeploysAnswer | null>(null);
  protected readonly rows = computed(() => {
    const a = this.answer();
    return a ? releaseRows(a) : [];
  });
  /** One deploy at a time: no Deploy while one runs. */
  protected readonly busy = computed(() => !!this.answer()?.history.some((h) => h.outcome === 'running'));
  protected readonly checking = signal(false);
  protected readonly posting = signal(false);
  /** The row whose release picker is open, and the release picked. */
  protected readonly picking = signal<string | null>(null);
  protected readonly choice = signal('');

  constructor() {
    this.#load();
    inject(LiveEvents)
      .all$.pipe(filter((l) => ofTarget('deploy')(l) || packNotice(l.event)), debounceTime(50), takeUntilDestroyed())
      .subscribe(() => this.#load());
  }

  /** Going back: the tag is older than the one running (when that is a listed release). */
  protected older(r: ReleaseRow, tag: string): boolean {
    const at = r.releases.findIndex((rel) => rel.tag === r.running);
    return at >= 0 && r.releases.findIndex((rel) => rel.tag === tag) > at;
  }

  protected pick(r: ReleaseRow): void {
    this.choice.set(r.latest ?? '');
    this.picking.set(r.key);
  }

  protected async deploy(r: ReleaseRow): Promise<void> {
    const tag = this.choice();
    const older = this.older(r, tag);
    const ok = await this.#feedback.confirm({
      title: `Deploy ${r.part === 'mod' ? r.label : r.label.toLowerCase()} ${short(r.running)} → ${short(tag)}${older ? ' (older release)' : ''}?`,
      description: older ? 'This goes back to an older release than the one running.' : undefined,
      verb: 'Deploy',
      destructive: older,
    });
    if (!ok) return;
    const body: DeployRequest = { part: r.part, tag, ...(r.server && { server: r.server }) };
    this.posting.set(true);
    this.#http.post<DeployAnswer>('/api/deploys', body).subscribe({
      next: () => {
        this.posting.set(false);
        this.picking.set(null);
        this.#feedback.ok(`Deploying ${tag}.`);
        this.#load();
      },
      error: (err: HttpErrorResponse) => {
        this.posting.set(false);
        this.#feedback.failed(`Deploying ${tag}`, err);
        this.#load();
      },
    });
  }

  protected check(): void {
    this.checking.set(true);
    this.#http.post<DeploysAnswer>('/api/deploys/check', {}).subscribe({
      next: (a) => (this.checking.set(false), this.answer.set(a)),
      error: (err: HttpErrorResponse) => (this.checking.set(false), this.#feedback.failed('Checking GitHub', err)),
    });
  }

  #load(): void {
    this.#http.get<DeploysAnswer>('/api/deploys').subscribe({ next: (a) => this.answer.set(a), error: () => {} });
  }
}

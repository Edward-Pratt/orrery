import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ModerateAction, ModerateAnswer, ModerateOutcome, ModerateRequest, ModerationState } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { catchError, debounceTime, EMPTY, filter, firstValueFrom, merge, startWith, Subject, switchMap } from 'rxjs';
import { LiveEvents, ofServer } from '../events';
import { Feedback } from '../feedback';
import ServerPage from './server';

/** A player's name as Factorio and the hub take it. */
const NAME = /^[A-Za-z0-9_.-]{1,60}$/;
const NAME_RULE = 'Names are 1 to 60 letters, digits, "_", "." or "-".';
/** What a reason may not hold, as the hub refuses it. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const REASON_MAX = 200;
const FILTER_PAST = 20;
const DONE: Record<ModerateAction, (p: string) => string> = {
  kick: (p) => `${p} was kicked.`,
  ban: (p) => `${p} is banned.`,
  unban: (p) => `${p} is unbanned.`,
  promote: (p) => `${p} is an admin.`,
  demote: (p) => `${p} isn't an admin any more.`,
};
const ALREADY: Record<ModerateAction, (p: string) => string> = {
  kick: (p) => `${p} was kicked already.`,
  ban: (p) => `${p} was banned already.`,
  unban: (p) => `${p} wasn't banned.`,
  promote: (p) => `${p} was an admin already.`,
  demote: (p) => `${p} wasn't an admin.`,
};

/**
 * The Players tab's Moderation section, for a factorio server: who is online with Kick, Ban and Promote or Demote,
 * the bans with Unban and the admins with Demote, from `GET …/moderation`; each action a `POST`, its outcome a toast
 * and its answer's lists shown. Asked again on Refresh, after an action, and on the server's join and leave (2 s
 * apart at most). An older hub's 404 says which release it needs.
 */
@Component({
  selector: 'app-moderation',
  imports: [HlmButton, HlmInput],
  template: `
    <section class="mb-6 max-w-4xl rounded-xl border p-4 text-sm" data-moderation>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-semibold">Moderation</h2>
        <span class="flex gap-2">
          <button hlmBtn variant="outline" size="sm" [disabled]="!!blocked() || busy()" (click)="ask('ban', null)" data-ban-any>Ban a player…</button>
          <button hlmBtn variant="ghost" size="sm" (click)="reload.next()" data-refresh>Refresh</button>
        </span>
      </div>
      @if (oldHub()) {
        <p class="text-muted-foreground" data-old-hub>This hub has no player moderation yet: deploy hub-v2.20.0 or later.</p>
      } @else if (state(); as s) {
        @if (s.lists?.verification === false) {
          <p class="mb-2 text-status-warn" data-verification-off>User verification is off (Settings tab): names aren't checked, so a banned player can join again under another name.</p>
        }
        @if (s.blocked) {
          <p class="mb-2 text-muted-foreground" data-blocked>{{ s.blocked }}</p>
        }
        @if (s.lists?.problem; as p) {
          <p class="mb-2 text-status-warn" data-problem>{{ p }}</p>
        }
        @if (form(); as f) {
          <form class="mb-3 flex flex-col gap-2 rounded-lg border bg-muted/30 p-3" (submit)="$event.preventDefault(); submit()" data-form>
            <b>{{ f.action === 'ban' ? 'Ban' : 'Kick' }} {{ f.player ?? 'a player' }}?</b>
            <p class="text-muted-foreground">
              {{ f.action === 'ban' ? "They are disconnected if they are online, and can't join again until unbanned. Factorio shows them the reason." : 'They are disconnected and can join again at once.' }}
            </p>
            @if (f.player === null) {
              <input hlmInput class="font-mono" aria-label="Player to ban" aria-describedby="mod-name-error" [value]="typed()" (input)="typed.set($any($event.target).value)" data-form-name />
              @if (typed() && !nameOk(typed())) {
                <span id="mod-name-error" class="text-xs text-destructive" data-name-error>{{ nameRule }}</span>
              }
            }
            <label>
              Reason (optional)
              <input hlmInput class="mt-1 w-full" aria-describedby="mod-reason-error" [value]="reason()" (input)="reason.set($any($event.target).value)" data-reason />
            </label>
            <span class="text-xs text-muted-foreground" data-reason-count>{{ reason().trim().length }}/200</span>
            @if (reasonError(); as e) {
              <span id="mod-reason-error" class="text-xs text-destructive" data-reason-error>{{ e }}</span>
            }
            <span class="flex gap-2">
              <button hlmBtn type="button" variant="ghost" (click)="form.set(null)">Cancel</button>
              <button hlmBtn type="submit" [variant]="f.action === 'ban' ? 'destructive' : 'default'" [disabled]="!formOk() || busy()" data-form-go>{{ f.action === 'ban' ? 'Ban' : 'Kick' }}</button>
            </span>
          </form>
        }
        <h3 class="mb-1 font-medium">Online now ({{ s.online.length }})</h3>
        <ul class="mb-4 divide-y rounded-lg border">
          @for (p of s.online; track p) {
            <li class="flex flex-wrap items-center gap-2 px-3 py-1.5" [attr.data-online]="p">
              <span class="flex-1 font-medium">{{ p }} @if (isAdmin(p)) {<span class="ml-1 rounded bg-muted px-1.5 text-xs" data-admin-badge>Admin</span>}</span>
              @let off = !!s.blocked || busy() || !s.lists || !nameOk(p);
              @let why = nameOk(p) ? null : "This name can't be moderated from the dashboard: use the Console tab.";
              <button hlmBtn variant="outline" size="sm" [disabled]="off" [attr.title]="why" [attr.aria-label]="'Kick ' + p" (click)="ask('kick', p)" data-kick>Kick…</button>
              <button hlmBtn variant="outline" size="sm" [disabled]="off" [attr.title]="why" [attr.aria-label]="'Ban ' + p" (click)="ask('ban', p)" data-ban>Ban…</button>
              @if (isAdmin(p)) {
                <button hlmBtn variant="ghost" size="sm" [disabled]="off" [attr.aria-label]="'Demote ' + p" (click)="act('demote', p)" data-demote>Demote</button>
              } @else {
                <button hlmBtn variant="ghost" size="sm" [disabled]="off" [attr.aria-label]="'Promote ' + p" (click)="promote(p)" data-promote>Promote…</button>
              }
            </li>
          } @empty {
            <li class="px-3 py-1.5 text-muted-foreground">Nobody is online.</li>
          }
        </ul>
        @if (s.lists; as l) {
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 class="mb-1 font-medium">Bans ({{ l.bansTotal }})</h3>
              @if (l.bans.length > filterPast) {
                <input hlmInput class="mb-2 w-full" placeholder="Filter" aria-label="Filter the bans" [value]="filter()" (input)="filter.set($any($event.target).value)" data-filter />
              }
              <ul class="divide-y rounded-lg border">
                @for (b of shownBans(); track b.name) {
                  <li class="flex items-center gap-2 px-3 py-1.5" [attr.data-banned]="b.name">
                    <span class="font-mono">{{ b.name }}</span>
                    <span class="flex-1 truncate text-muted-foreground">{{ b.reason ?? '(no reason)' }}</span>
                    <button hlmBtn variant="ghost" size="sm" [disabled]="!!s.blocked || busy()" [attr.aria-label]="'Unban ' + b.name" (click)="act('unban', b.name)" data-unban>Unban</button>
                  </li>
                } @empty {
                  <li class="px-3 py-1.5 text-muted-foreground">No bans.</li>
                }
              </ul>
              @if (l.bansTotal > l.bans.length) {
                <p class="mt-1 text-xs text-muted-foreground" data-bans-cut>Showing {{ l.bans.length }} of {{ l.bansTotal.toLocaleString() }} bans, by name.</p>
              }
              @if (l.hidden) {
                <p class="mt-1 text-xs text-muted-foreground" data-bans-hidden>{{ l.hidden }} {{ l.hidden === 1 ? 'ban has a name' : 'bans have names' }} the dashboard can't show: see /bans in the Console tab.</p>
              }
            </div>
            <div>
              <h3 class="mb-1 font-medium">Admins ({{ l.admins.length }})</h3>
              <ul class="mb-2 flex flex-wrap gap-1.5">
                @for (a of l.admins; track a) {
                  <li class="flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs" [attr.data-admin]="a">
                    {{ a }}
                    <button hlmBtn variant="ghost" size="sm" [disabled]="!!s.blocked || busy()" [attr.aria-label]="'Demote ' + a" (click)="act('demote', a)">Demote</button>
                  </li>
                }
              </ul>
              <form class="flex gap-2" (submit)="$event.preventDefault(); promote(adminName().trim())">
                <input hlmInput class="min-w-0 flex-1 font-mono" aria-label="Player to make an admin" aria-describedby="mod-admin-error" [value]="adminName()" (input)="adminName.set($any($event.target).value)" data-admin-name />
                <button hlmBtn variant="outline" type="submit" [disabled]="!!s.blocked || busy() || !nameOk(adminName().trim())" data-admin-add>Promote…</button>
              </form>
              @if (adminName().trim() && !nameOk(adminName().trim())) {
                <span id="mod-admin-error" class="text-xs text-destructive" data-admin-error>{{ nameRule }}</span>
              }
              <p class="mt-1 text-xs text-muted-foreground">Admins can also change in the Settings tab, also while the server is stopped.</p>
            </div>
          </div>
        }
      } @else {
        <p class="text-muted-foreground" data-loading>Reading the bans and admins…</p>
      }
    </section>
  `,
})
export class ModerationSection {
  readonly #server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly #url = `/api/servers/${encodeURIComponent(this.#server.id)}/moderation`;
  protected readonly nameRule = NAME_RULE;
  protected readonly filterPast = FILTER_PAST;
  protected readonly reload = new Subject<void>();

  protected readonly state = signal<ModerationState | null>(null);
  protected readonly oldHub = signal(false);
  protected readonly busy = signal(false);
  protected readonly form = signal<{ action: 'kick' | 'ban'; player: string | null } | null>(null);
  protected readonly typed = signal('');
  protected readonly reason = signal('');
  protected readonly filter = signal('');
  protected readonly adminName = signal('');

  protected readonly blocked = computed(() => this.state()?.blocked ?? (this.state() ? null : 'loading'));
  protected readonly shownBans = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const bans = this.state()?.lists?.bans ?? [];
    return q ? bans.filter((b) => b.name.includes(q) || b.reason?.toLowerCase().includes(q)) : bans;
  });
  protected readonly reasonError = computed(() => {
    const r = this.reason();
    if (UNSAFE.test(r)) return 'A reason is one line, with no control characters.';
    return r.trim().length > REASON_MAX ? `At most ${REASON_MAX} characters.` : null;
  });
  protected readonly formOk = computed(() => {
    const f = this.form();
    return !!f && !this.reasonError() && (f.player !== null || this.nameOk(this.typed().trim()));
  });

  constructor() {
    const events = inject(LiveEvents).all$.pipe(
      filter(ofServer(this.#server.id)),
      filter(({ event: e }) => e.type === 'join' || e.type === 'leave'),
      debounceTime(2000),
    );
    merge(this.reload, events)
      .pipe(
        startWith(undefined),
        switchMap(() =>
          this.#http.get<ModerationState>(this.#url).pipe(
            catchError((err: HttpErrorResponse) => {
              if (err.status === 404) this.oldHub.set(true);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((s) => this.state.set(s));
  }

  protected nameOk = (name: string) => NAME.test(name);
  protected isAdmin = (name: string) => (this.state()?.lists?.admins ?? []).some((a) => a.toLowerCase() === name.toLowerCase());

  protected ask(action: 'kick' | 'ban', player: string | null): void {
    this.typed.set('');
    this.reason.set('');
    this.form.set({ action, player });
  }

  protected async submit(): Promise<void> {
    const f = this.form();
    if (!f || !this.formOk()) return;
    const reason = this.reason().trim();
    this.form.set(null);
    await this.act(f.action, f.player ?? this.typed().trim(), reason || undefined);
  }

  protected async promote(player: string): Promise<void> {
    if (!this.nameOk(player)) return;
    const ok = await this.#feedback.confirm({
      title: `Make ${player} an admin?`,
      description: 'Admins can kick, ban and pause, and run Lua commands when commands are on for admins.',
      verb: 'Promote',
    });
    if (ok && (await this.act('promote', player))) this.adminName.set('');
  }

  /** Sends one action; true once the hub answered. */
  protected async act(action: ModerateAction, player: string, reason?: string): Promise<boolean> {
    this.busy.set(true);
    try {
      const body: ModerateRequest = { action, player, ...(reason && { reason }) };
      const answer = await firstValueFrom(this.#http.post<ModerateAnswer>(this.#url, body));
      this.state.update((s) => s && { ...s, lists: answer.lists });
      this.#tell(answer.outcome, action, player);
      return true;
    } catch (err) {
      if (err instanceof HttpErrorResponse) this.#feedback.failed(`${action[0]!.toUpperCase()}${action.slice(1)} ${player}`, err);
      else throw err;
      return false;
    } finally {
      this.busy.set(false);
      if (action === 'kick') this.reload.next(); // who is online changed
    }
  }

  #tell(outcome: ModerateOutcome, action: ModerateAction, player: string): void {
    if (outcome === 'done') return this.#feedback.ok(DONE[action](player));
    if (outcome === 'already') return this.#feedback.ok(ALREADY[action](player));
    if (outcome === 'notOnline') return this.#feedback.ok(`${player} isn't online any more.`);
    const where = action === 'kick' ? `${player} is still online` : `the ${action === 'promote' || action === 'demote' ? 'adminlist' : 'banlist'} doesn't show it yet`;
    this.#feedback.notice(`Sent, but ${where}: check the Console tab.`);
  }
}

// The logged-out card: the login form (username and password, `POST /api/login`; the hub's text for a 401 or a 429
// shown as it is), or, with `?invite=<token>` in the address, the invite (`GET /api/invites/:token` names whom it is
// for; the password typed twice, then its `POST`; an unknown, used or expired one says so). The token leaves the
// address at once (`history.replaceState`), so it stays out of history and bookmarks. A success loads the session.
// "Your session ended" when the hub ended it under the open page.

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import type { InviteInfo, LoginRequest, PasswordRequest } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { StagingBadge } from './environment';
import { Logo } from './logo';
import { Session } from './session';

const JSON_HEADERS = { 'content-type': 'application/json' };
/** The hub's rule for a password (`users/password.ts`), checked here first so the form says what's wrong. */
export const PASSWORD_MIN = 12;

/**
 * `hlmInput`'s look without the directive: the card is in the first load, and the directive brings the form-field
 * machinery with it (about 30 kB), over the first load's budget.
 */
const INPUT =
  'mt-1 h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30';

/** The hub's own text for a refusal, else its status. */
const why = (err: HttpErrorResponse) => (typeof err.error === 'string' && err.error ? err.error : `The hub didn't answer (HTTP ${err.status}). Try again.`);

/** Takes `?invite=` out of the address, answering its token. */
function takeInvite(): string | null {
  const url = new URL(location.href);
  const token = url.searchParams.get('invite');
  if (token === null) return null;
  url.searchParams.delete('invite');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  return token;
}

/** The logged-out view: a centred card, no sidebar, with the login form or an invite's password form. */
@Component({
  selector: 'app-login',
  imports: [HlmButton, HlmSpinner, StagingBadge, Logo],
  template: `
    <div class="grid min-h-dvh place-items-center p-4">
      <div class="flex w-full max-w-sm flex-col items-center gap-5 rounded-xl border bg-card p-8 text-card-foreground">
        <app-logo class="size-20" [animated]="true" />
        <span class="flex items-center gap-2 text-2xl font-bold tracking-tight">
          orrery
          <app-staging-badge />
        </span>
        @if (invite) {
          @if (invitee(); as name) {
            <form class="flex w-full flex-col gap-3 text-sm" (submit)="$event.preventDefault(); setPassword(first.value, second.value)" data-invite-form>
              <p class="text-center text-base">Set a password for <strong data-invitee>{{ name }}</strong></p>
              <label>New password <input #first type="password" autocomplete="new-password" [class]="input" (input)="typed.set(first.value)" data-password /></label>
              <label>Again <input #second type="password" autocomplete="new-password" [class]="input" data-again /></label>
              <p class="text-xs text-muted-foreground">At least {{ min }} characters. A long phrase is easiest.</p>
              <button hlmBtn type="submit" [disabled]="busy() || typed().length < min" data-go>
                @if (busy()) {
                  <hlm-spinner />
                }
                Set password and log in
              </button>
            </form>
          } @else if (invitee() === null) {
            <p class="text-center" data-invite-gone>This invite has expired or was already used. Ask for a new one.</p>
          } @else if (!error()) {
            <p class="text-muted-foreground">Checking the invite…</p>
          }
        } @else {
          <form class="flex w-full flex-col gap-3 text-sm" (submit)="$event.preventDefault(); login(user.value, pass.value)" data-login-form>
            <label>Username <input #user autocomplete="username" autocapitalize="none" spellcheck="false" [class]="input" data-username /></label>
            <label>Password <input #pass type="password" autocomplete="current-password" [class]="input" data-password /></label>
            <button hlmBtn type="submit" [disabled]="busy()" data-go>
              @if (busy()) {
                <hlm-spinner />
              }
              Log in
            </button>
          </form>
        }
        @if (message(); as m) {
          <p class="text-center text-sm text-muted-foreground" role="alert" data-message>{{ m }}</p>
        }
      </div>
    </div>
  `,
})
export class Login {
  readonly #http = inject(HttpClient);
  readonly #session = inject(Session);
  protected readonly min = PASSWORD_MIN;
  protected readonly input = INPUT;
  /** The invite's token, taken out of the address. */
  protected readonly invite = takeInvite();
  /** Whom the invite is for: undefined while asking, null when it is no longer valid. */
  protected readonly invitee = signal<string | null | undefined>(undefined);
  protected readonly typed = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  readonly #ended = this.#session.ended() ? 'Your session ended. Log in again.' : null;
  protected readonly message = computed(() => this.error() ?? this.#ended);

  constructor() {
    if (this.invite === null) return;
    this.#http.get<InviteInfo>(`/api/invites/${encodeURIComponent(this.invite)}`).subscribe({
      next: ({ username }) => this.invitee.set(username),
      error: (err: HttpErrorResponse) => (err.status === 404 ? this.invitee.set(null) : this.error.set(why(err))),
    });
  }

  protected login(username: string, password: string): void {
    this.#post('/api/login', { username: username.trim(), password } satisfies LoginRequest);
  }

  protected setPassword(password: string, again: string): void {
    if (password !== again) return this.error.set('The two passwords differ.');
    this.#post(`/api/invites/${encodeURIComponent(this.invite!)}`, { password } satisfies PasswordRequest);
  }

  #post(url: string, body: object): void {
    this.busy.set(true);
    this.error.set(null);
    this.#http.post(url, body, { headers: JSON_HEADERS }).subscribe({
      next: () => {
        this.busy.set(false);
        this.#session.ended.set(false);
        this.#session.load();
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        if (err.status === 404 && this.invite !== null) this.invitee.set(null);
        else this.error.set(why(err));
      },
    });
  }
}

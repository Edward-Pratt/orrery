// The Account page (`/account`, from the user menu): one's own username and roles, Change password (`PUT
// /api/me/password` with the current one, the new one typed twice, at least 12 characters; the user's other sessions
// end; the hub's text for a wrong current password or a lock shown inline) and Log out everywhere (`POST
// /api/me/logout-all`, after asking: this browser too, so back to the login card).

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import type { PasswordChange } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { firstValueFrom } from 'rxjs';
import { Feedback } from '../feedback';
import { PASSWORD_MIN } from '../login';
import { Session } from '../session';

const JSON_HEADERS = { 'content-type': 'application/json' };

@Component({
  selector: 'app-account',
  imports: [HlmButton, HlmInput, HlmSpinner],
  template: `
    <h1 class="mb-1 text-lg font-semibold">Account</h1>
    <p class="mb-6 text-sm text-muted-foreground" data-who>
      Logged in as <b>{{ session.user()?.username }}</b>{{ session.owner() ? ', an owner' : '' }}.
    </p>
    <section class="mb-8 flex max-w-sm flex-col gap-3 text-sm" data-password-section>
      <h2 class="font-medium">Change password</h2>
      <form class="flex flex-col gap-3" (submit)="$event.preventDefault(); change(current.value, next.value, again.value, $any($event.target))" data-password-form>
        <label>Current password <input #current hlmInput type="password" autocomplete="current-password" class="mt-1 w-full" data-current /></label>
        <label>New password <input #next hlmInput type="password" autocomplete="new-password" class="mt-1 w-full" data-next /></label>
        <label>Again <input #again hlmInput type="password" autocomplete="new-password" class="mt-1 w-full" data-again /></label>
        <p class="text-xs text-muted-foreground">At least {{ min }} characters. Your other browsers are logged out.</p>
        <button hlmBtn type="submit" class="self-start" [disabled]="busy()" data-change>
          @if (busy()) {
            <hlm-spinner />
          }
          Change password
        </button>
      </form>
      @if (error(); as e) {
        <p class="text-destructive" role="alert" data-error>{{ e }}</p>
      }
    </section>
    <section class="flex max-w-sm flex-col gap-2 text-sm">
      <h2 class="font-medium">Log out everywhere</h2>
      <p class="text-muted-foreground">Ends every session of yours, this one too: a lost phone, a shared computer.</p>
      <button hlmBtn variant="outline" class="self-start" (click)="logoutAll()" data-logout-all>Log out everywhere</button>
    </section>
  `,
})
export default class Account {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  protected readonly session = inject(Session);
  protected readonly min = PASSWORD_MIN;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async change(current: string, password: string, again: string, form: HTMLFormElement): Promise<void> {
    if (password.length < PASSWORD_MIN) return this.error.set(`A password is at least ${PASSWORD_MIN} characters.`);
    if (password !== again) return this.error.set('The two new passwords differ.');
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.#http.put('/api/me/password', { current, password } satisfies PasswordChange, { headers: JSON_HEADERS }));
      form.reset();
      this.#feedback.ok('Your password is changed. Your other browsers are logged out.');
    } catch (err) {
      if (!(err instanceof HttpErrorResponse)) throw err;
      this.error.set(typeof err.error === 'string' && err.error ? err.error : `The hub didn't answer (HTTP ${err.status}).`);
    } finally {
      this.busy.set(false);
    }
  }

  protected async logoutAll(): Promise<void> {
    const ok = await this.#feedback.confirm({ title: 'Log out everywhere?', description: 'Every browser you are logged in on, this one too, has to log in again.', verb: 'Log out everywhere' });
    if (!ok) return;
    try {
      await firstValueFrom(this.#http.post('/api/me/logout-all', null, { headers: JSON_HEADERS }));
      this.session.user.set(null);
    } catch (err) {
      if (!(err instanceof HttpErrorResponse)) throw err;
      this.#feedback.failed('Logging out everywhere', err);
    }
  }
}

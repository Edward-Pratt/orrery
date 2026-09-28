import { Component } from '@angular/core';
import { HlmButton } from '@spartan-ng/helm/button';

/** Why the hub sent a failed login back here (`/?login=<why>`). */
const REASONS = new Map([
  ['admin', 'That account is not an admin.'],
  ['state', 'The login expired or was interrupted. Try again.'],
  ['discord', 'Discord did not answer. Try again.'],
]);

/** The logged-out view: a centred card, no sidebar. */
@Component({
  selector: 'app-login',
  imports: [HlmButton],
  template: `
    <div class="grid min-h-dvh place-items-center p-4">
      <div class="flex w-full max-w-sm flex-col items-center gap-5 rounded-xl border bg-card p-8 text-center text-card-foreground">
        <span class="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <span class="size-3 rounded-full bg-brand ring-4 ring-brand/20"></span>
          orrery
        </span>
        <p class="text-muted-foreground">Admins of this Discord server only</p>
        <a hlmBtn class="w-full" href="/api/login">Log in with Discord</a>
        @if (reason) {
          <p class="text-sm text-muted-foreground">{{ reason }}</p>
        }
      </div>
    </div>
  `,
})
export class Login {
  protected readonly reason = REASONS.get(new URLSearchParams(location.search).get('login') ?? '');
}

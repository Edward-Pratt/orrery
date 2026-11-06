// The Users tab: every user (`GET /api/users`) with their roles and where (`GET /api/roles`, server names from `GET
// /api/servers`), "Invited" until their link is used, "Disabled", and when they last logged in; Invite… and, per user,
// a ⋯ menu: Edit… (both `user-sheet.ts`'s `UserSheet`), Reset password (a new invite link; the old password works
// until it is used), Log out everywhere, Disable (asks: their sessions end) or Enable, and Delete (typed username).
// None of one's own but Edit, Reset and Log out; no menu on an owner, or on a user with a Discord id, for a user who
// isn't an owner (the hub refuses it, as it refuses anything above the user's own level: its text is the toast). An
// invite link is shown once, with Copy, until Done. Fetched again after each change.

import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import type { InviteAnswer, RoleView, ServerCard, UserView } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCopy, lucideEllipsis, lucidePlus } from '@ng-icons/lucide';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { catchError, firstValueFrom, of } from 'rxjs';
import { Feedback } from '../feedback';
import { Session } from '../session';
import { UserSheet } from './user-sheet';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** A user's grants in words: "Admin, Operator on Space Age". */
export function grantsText(u: UserView, serverName: (id: string) => string): string {
  return u.grants.map((g) => (g.servers ? `${g.role} on ${g.servers.map(serverName).join(', ')}` : g.role)).join('; ') || 'No roles: reads only';
}

@Component({
  selector: 'app-users',
  imports: [DatePipe, NgIcon, HlmBadge, HlmButton, HlmDropdownMenuImports, HlmSkeleton, UserSheet],
  viewProviders: [provideIcons({ lucideCopy, lucideEllipsis, lucidePlus })],
  template: `
    <div class="mb-4 flex items-center gap-3">
      <p class="text-sm text-muted-foreground">Who may log in, and what each may do.</p>
      <button hlmBtn size="sm" class="ml-auto" (click)="editing.set('new')" data-invite><ng-icon name="lucidePlus" /> Invite…</button>
    </div>
    @if (link(); as l) {
      <div class="mb-4 flex flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-link>
        <p>The link for <b>{{ l.username }}</b> works once, for 24 hours, and isn't shown again: send it to them.</p>
        <div class="flex items-start gap-2 rounded-md border bg-background p-2">
          <code class="min-w-0 flex-1 font-mono text-xs break-all" data-link-url>{{ l.invite }}</code>
          <button hlmBtn variant="ghost" size="sm" (click)="copy(l.invite)" aria-label="Copy" data-copy><ng-icon name="lucideCopy" /></button>
        </div>
        <button hlmBtn variant="ghost" size="sm" class="self-end" (click)="link.set(null)" data-done>Done</button>
      </div>
    }
    @if (users(); as list) {
      <div class="flex flex-col gap-2">
        @for (u of list; track u.id) {
          <div class="flex flex-wrap items-center gap-3 rounded-lg border p-3" [attr.data-user]="u.username">
            <div class="min-w-0 flex-1">
              <span class="font-medium">{{ u.username }}</span>
              @if (u.id === me()?.id) {
                <span class="text-sm text-muted-foreground"> (you)</span>
              }
              @if (!u.hasPassword) {
                <span hlmBadge variant="outline" class="ms-2" data-invited>Invited</span>
              }
              @if (u.disabled) {
                <span hlmBadge variant="destructive" class="ms-2" data-disabled>Disabled</span>
              }
              <p class="text-sm text-muted-foreground" data-grants>{{ grants(u) }}</p>
            </div>
            <span class="text-xs text-muted-foreground" data-last-login>
              @if (u.lastLogin) {
                last in {{ u.lastLogin | date: 'd MMM y HH:mm' }}
              } @else {
                never logged in
              }
            </span>
            @if (manageable(u)) {
              <button hlmBtn variant="outline" size="sm" aria-label="More actions" [hlmDropdownMenuTrigger]="menu" data-more>
                <ng-icon name="lucideEllipsis" />
              </button>
              <ng-template #menu>
                <div hlmDropdownMenu class="w-48">
                  <button hlmDropdownMenuItem type="button" (click)="editing.set(u)" data-edit>Edit…</button>
                  <button hlmDropdownMenuItem type="button" (click)="reset(u)" data-reset>Reset password</button>
                  <button hlmDropdownMenuItem type="button" (click)="logout(u)" data-logout>Log out everywhere</button>
                  @if (u.id !== me()?.id) {
                    <button hlmDropdownMenuItem type="button" (click)="setDisabled(u, !u.disabled)" data-toggle>{{ u.disabled ? 'Enable' : 'Disable…' }}</button>
                    <button hlmDropdownMenuItem type="button" class="text-status-down" (click)="remove(u)" data-delete>Delete…</button>
                  }
                </div>
              </ng-template>
            }
          </div>
        }
      </div>
    } @else {
      <div class="flex flex-col gap-2" data-skeleton>
        @for (i of [1, 2]; track i) {
          <hlm-skeleton class="h-16 w-full" />
        }
      </div>
    }
    @if (editing(); as e) {
      <app-user-sheet [user]="e === 'new' ? null : e" [roles]="roles()" [servers]="servers()" (closed)="editing.set(null)" (saved)="saved($event)" />
    }
  `,
})
export default class Users {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  protected readonly me = inject(Session).user;
  protected readonly users = signal<UserView[] | null>(null);
  protected readonly roles = signal<RoleView[]>([]);
  protected readonly servers = signal<Pick<ServerCard, 'id' | 'name'>[]>([]);
  /** The sheet: a new user's, or the user being edited. */
  protected readonly editing = signal<UserView | 'new' | null>(null);
  /** The invite link to show once. */
  protected readonly link = signal<InviteAnswer | null>(null);
  readonly #names = computed(() => new Map(this.servers().map((s) => [s.id, s.name])));

  constructor() {
    this.fetch();
    this.#http.get<RoleView[]>('/api/roles').pipe(catchError(() => of([]))).subscribe((r) => this.roles.set(r));
    this.#http.get<ServerCard[]>('/api/servers').pipe(catchError(() => of([]))).subscribe((s) => this.servers.set(s));
  }

  protected grants = (u: UserView) => grantsText(u, (id) => this.#names().get(id) ?? id);

  /** A user who holds Owner, or has a Discord id (their chat goes in game under its linked name), is changed by owners only. */
  protected manageable = (u: UserView) => this.me()?.owner || (!u.grants.some((g) => g.roleId === 'owner') && !u.discordId);

  protected fetch(): void {
    this.#http.get<UserView[]>('/api/users').subscribe({
      next: (u) => this.users.set(u),
      error: (err: HttpErrorResponse) => (this.users.set(this.users() ?? []), this.#feedback.failed('Reading the users', err)),
    });
  }

  protected saved(invite: InviteAnswer | null): void {
    this.editing.set(null);
    if (invite) this.link.set(invite);
    this.fetch();
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.#feedback.ok('Copied.');
    } catch {
      this.#feedback.ok('Copy failed: select the link instead.');
    }
  }

  protected async reset(u: UserView): Promise<void> {
    const answer = await this.#call<InviteAnswer>('POST', `/api/users/${u.id}/reset`, `Resetting ${u.username}'s password`);
    if (answer) this.link.set(answer);
  }

  protected async logout(u: UserView): Promise<void> {
    const ok = await this.#feedback.confirm({ title: `Log ${u.username} out everywhere?`, description: 'Every browser they are logged in on has to log in again.', verb: 'Log out' });
    if (ok && (await this.#call('POST', `/api/users/${u.id}/logout`, `Logging ${u.username} out`)) !== undefined) this.#feedback.ok(`${u.username} is logged out everywhere.`);
  }

  protected async setDisabled(u: UserView, disabled: boolean): Promise<void> {
    if (disabled) {
      const ok = await this.#feedback.confirm({
        title: `Disable ${u.username}?`,
        description: 'Their sessions and invite links end, and they can’t log in until enabled again.',
        verb: `Disable ${u.username}`,
        destructive: true,
      });
      if (!ok) return;
    }
    if ((await this.#call('PUT', `/api/users/${u.id}`, `${disabled ? 'Disabling' : 'Enabling'} ${u.username}`, { disabled })) !== undefined) {
      this.#feedback.ok(`${u.username} is ${disabled ? 'disabled' : 'enabled'}.`);
    }
  }

  protected async remove(u: UserView): Promise<void> {
    const ok = await this.#feedback.confirm({
      title: `Delete ${u.username}?`,
      description: 'Their account, roles, invite links and sessions go. The audit log keeps what they did.',
      verb: `Delete ${u.username}`,
      destructive: true,
      typeName: u.username,
    });
    if (ok && (await this.#call('DELETE', `/api/users/${u.id}`, `Deleting ${u.username}`)) !== undefined) this.#feedback.ok(`${u.username} is deleted.`);
  }

  /** One request: its answer (null for 204), or undefined after a refusal's toast; the list is fetched again either way. */
  async #call<T>(method: string, url: string, what: string, body: object = {}): Promise<T | null | undefined> {
    try {
      return await firstValueFrom(this.#http.request<T>(method, url, { body, headers: JSON_HEADERS }));
    } catch (err) {
      if (!(err instanceof HttpErrorResponse)) throw err;
      this.#feedback.failed(what, err);
      return undefined;
    } finally {
      this.fetch();
    }
  }
}

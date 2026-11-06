// `UserSheet`: a full-height sheet that invites a user (`POST /api/users`: a username, checked as the hub checks it)
// or edits one (`PUT /api/users/:id`, only what changed): their roles, each for every server or for the servers picked
// (a role with servers picked gives only its server permissions, on those), and, for an owner, the Discord id that puts
// their dashboard chat in game under the name that Discord user linked. Owner is offered only to an owner, and always
// for every server. `saved` with the invite link for a new user, null after an edit; the hub's refusals are toasts.

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import type { GrantRequest, InviteAnswer, NewUserRequest, RoleView, ServerCard, UserChange, UserView } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { firstValueFrom } from 'rxjs';
import { Feedback } from '../feedback';
import { Session } from '../session';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** The hub's rules (`users/users.ts`), checked here first so the form says what's wrong. */
const USERNAME = /^[A-Za-z0-9._-]{2,32}$/;
const DISCORD_ID = /^(\d{17,20})?$/;

/** A role's grant in the form: null for every server, else the servers picked. */
type Scope = string[] | null;

@Component({
  selector: 'app-user-sheet',
  imports: [HlmButton, HlmInput, HlmSheetImports, HlmSpinner],
  template: `
    <hlm-sheet side="right" state="open" (closed)="closed.emit()">
      <hlm-sheet-content *hlmSheetPortal="let ctx" class="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md" data-sheet>
        <hlm-sheet-header>
          <h2 hlmSheetTitle>{{ user() ? 'Edit ' + user()!.username : 'Invite a user' }}</h2>
        </hlm-sheet-header>
        <div class="flex flex-col gap-4 px-4 pb-4 text-sm">
          @if (!user()) {
            <label
              >Username
              <input hlmInput class="mt-1 w-full" autocomplete="off" autocapitalize="none" spellcheck="false" [value]="username()" (input)="username.set($any($event.target).value.trim())" data-username
            /></label>
            @if (username() && !usernameOk()) {
              <p class="text-xs text-status-down" data-username-error>2 to 32 letters, digits, dots, dashes or underscores.</p>
            }
          }
          <fieldset class="flex flex-col gap-3">
            <legend class="mb-1 font-medium">Roles</legend>
            @for (r of offered(); track r.id) {
              <div class="flex flex-col gap-1.5 rounded-md border p-2" [attr.data-role]="r.name">
                <label class="flex items-start gap-2">
                  <input type="checkbox" class="mt-0.5 size-4 accent-[var(--brand)]" [checked]="scopes().has(r.id)" (change)="toggle(r.id)" data-grant />
                  <span><b>{{ r.name }}</b> <span class="text-muted-foreground">{{ r.note }}</span></span>
                </label>
                @if (scopes().has(r.id) && r.id !== 'owner') {
                  @let scope = scopes().get(r.id)!;
                  <div class="ms-6 flex flex-col gap-1" data-scope>
                    <label class="flex items-center gap-2"><input type="radio" [name]="'scope-' + r.id" [checked]="scope === null" (change)="setScope(r.id, null)" data-every /> Every server</label>
                    <label class="flex items-center gap-2"><input type="radio" [name]="'scope-' + r.id" [checked]="scope !== null" (change)="setScope(r.id, [])" data-some /> Only these:</label>
                    @if (scope !== null) {
                      <div class="ms-6 flex flex-col gap-1">
                        @for (s of servers(); track s.id) {
                          <label class="flex items-center gap-2">
                            <input type="checkbox" class="size-4 accent-[var(--brand)]" [checked]="scope.includes(s.id)" (change)="pick(r.id, s.id)" [attr.data-server]="s.id" /> {{ s.name }}
                          </label>
                        }
                        <p class="text-xs text-muted-foreground">Only the role's server permissions, on these servers.</p>
                      </div>
                    }
                  </div>
                }
              </div>
            }
            @if (!scopes().size) {
              <p class="text-xs text-muted-foreground">No role: they can read what the dashboard shows, and do nothing.</p>
            }
            @if (emptyScope()) {
              <p class="text-xs text-status-down" data-scope-error>Pick at least one server, or every server.</p>
            }
          </fieldset>
          @if (owner()) {
            <label
              >Discord id <span class="text-muted-foreground">(optional)</span>
              <input hlmInput class="mt-1 w-full font-mono" inputmode="numeric" [value]="discordId()" (input)="discordId.set($any($event.target).value.trim())" data-discord
            /></label>
            <p class="-mt-3 text-xs text-muted-foreground">Their dashboard chat goes in game under the name this Discord user linked.</p>
            @if (!discordOk()) {
              <p class="text-xs text-status-down" data-discord-error>A Discord id is 17 to 20 digits.</p>
            }
          }
          <button hlmBtn [disabled]="busy() || !ready()" (click)="save()" data-save>
            @if (busy()) {
              <hlm-spinner />
            }
            {{ user() ? 'Save' : 'Invite' }}
          </button>
          @if (!user()) {
            <p class="text-xs text-muted-foreground">You get a link to send them: it works once, for 24 hours, and sets their password.</p>
          }
        </div>
      </hlm-sheet-content>
    </hlm-sheet>
  `,
})
export class UserSheet implements OnInit {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly #session = inject(Session);
  /** The user to edit; null to invite one. */
  readonly user = input.required<UserView | null>();
  readonly roles = input.required<RoleView[]>();
  readonly servers = input.required<Pick<ServerCard, 'id' | 'name'>[]>();
  readonly closed = output<void>();
  readonly saved = output<InviteAnswer | null>();

  protected readonly owner = () => this.#session.owner();
  protected readonly username = signal('');
  protected readonly scopes = signal(new Map<string, Scope>());
  protected readonly discordId = signal('');
  protected readonly busy = signal(false);
  /** Owner only for an owner (and always shown on a user who has it, to an owner). */
  protected readonly offered = computed(() => this.roles().filter((r) => r.id !== 'owner' || this.owner()));
  protected readonly usernameOk = computed(() => USERNAME.test(this.username()));
  protected readonly discordOk = computed(() => DISCORD_ID.test(this.discordId()));
  protected readonly emptyScope = computed(() => [...this.scopes().values()].some((s) => s !== null && !s.length));
  protected readonly ready = computed(() => (this.user() !== null || this.usernameOk()) && this.discordOk() && !this.emptyScope());

  ngOnInit(): void {
    const u = this.user();
    this.scopes.set(new Map(u?.grants.map((g) => [g.roleId, g.servers]) ?? []));
    this.discordId.set(u?.discordId ?? '');
  }

  protected toggle(roleId: string): void {
    this.#edit((m) => (m.has(roleId) ? m.delete(roleId) : m.set(roleId, null)));
  }

  protected setScope(roleId: string, scope: Scope): void {
    this.#edit((m) => m.set(roleId, scope));
  }

  protected pick(roleId: string, serverId: string): void {
    this.#edit((m) => {
      const now = m.get(roleId) ?? [];
      m.set(roleId, now.includes(serverId) ? now.filter((s) => s !== serverId) : [...now, serverId]);
    });
  }

  #edit(change: (m: Map<string, Scope>) => unknown): void {
    const next = new Map(this.scopes());
    change(next);
    this.scopes.set(next);
  }

  protected async save(): Promise<void> {
    const grants: GrantRequest[] = [...this.scopes()].map(([roleId, servers]) => ({ roleId, servers }));
    const discordId = this.discordId() || null;
    const u = this.user();
    this.busy.set(true);
    try {
      if (!u) {
        const body: NewUserRequest = { username: this.username(), grants, ...(this.owner() && discordId && { discordId }) };
        this.saved.emit(await firstValueFrom(this.#http.post<InviteAnswer>('/api/users', body, { headers: JSON_HEADERS })));
        return;
      }
      const change: UserChange = {};
      const before = JSON.stringify(u.grants.map(({ roleId, servers }) => ({ roleId, servers })));
      if (JSON.stringify(grants) !== before) change.grants = grants;
      // A Discord id is sent only by an owner, and only when changed: anyone else's edit would clear it.
      if (this.owner() && discordId !== u.discordId) change.discordId = discordId;
      if (Object.keys(change).length) await firstValueFrom(this.#http.put(`/api/users/${u.id}`, change, { headers: JSON_HEADERS }));
      this.saved.emit(null);
    } catch (err) {
      if (!(err instanceof HttpErrorResponse)) throw err;
      this.#feedback.failed(u ? `Saving ${u.username}` : 'Inviting', err);
    } finally {
      this.busy.set(false);
    }
  }
}

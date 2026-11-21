import { Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arClose } from '@armil/icons';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { ADMIN, ADMIN_RULE, AT_RESTART, COMMANDS, type Edit, type Form, isChanged, type Key, LABELS, show } from './settings-rules';

/**
 * The Settings tab's form, its cards: Server (name, description, max players, the game password), Joining (the
 * account check, a `role="switch"` button, its warning in an `aria-live` region, and the idle kick), Pausing, Saving,
 * Lua commands (a native select) and Admins (chips, and an Add checked as typed). Changed
 * fields are marked "●" with the saved value in the title. The page holds the form, the password and every request;
 * this shows them and says what was changed or clicked. The password is never shown back, only "Set" or "Not set".
 */
@Component({
  selector: 'app-settings-form',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButton, HlmInput],
  viewProviders: [provideIcons({ arClose })],
  template: `
    <fieldset class="ar-panel flex flex-col gap-3 p-5" [disabled]="readOnly()" data-card="server">
      <legend class="px-1 font-semibold">Server</legend>
      <label class="flex flex-col gap-1">
        <span class="flex items-center gap-2">Name @if (changed('name')) { <span [title]="was('name')" data-changed="name">● <span class="sr-only">changed</span></span> }</span>
        <input hlmInput [value]="form().name" (input)="set('name', $any($event.target).value)" [attr.aria-describedby]="errors()['name'] ? 'err-name' : null" data-field="name" />
        @if (errors()['name']; as e) {
          <span id="err-name" class="text-xs text-destructive" data-error="name">{{ e }}</span>
        }
      </label>
      <label class="flex flex-col gap-1">
        <span class="flex items-center gap-2">Description @if (changed('description')) { <span [title]="was('description')" data-changed="description">● <span class="sr-only">changed</span></span> }</span>
        <input hlmInput [value]="form().description" (input)="set('description', $any($event.target).value)" [attr.aria-describedby]="errors()['description'] ? 'err-description' : null" data-field="description" />
        @if (errors()['description']; as e) {
          <span id="err-description" class="text-xs text-destructive" data-error="description">{{ e }}</span>
        }
      </label>
      <label class="flex flex-col gap-1">
        <span class="flex items-center gap-2">Max players @if (changed('max_players')) { <span [title]="was('max_players')" data-changed="max_players">● <span class="sr-only">changed</span></span> }</span>
        <input hlmInput type="number" min="0" max="1000" step="1" class="max-w-32" [value]="form().max_players" (input)="setNumber('max_players', $any($event.target).value)" aria-describedby="hint-max-players" data-field="max_players" />
        <span id="hint-max-players" class="text-xs text-muted-foreground">0: no limit</span>
        @if (errors()['max_players']; as e) {
          <span class="text-xs text-destructive" data-error="max_players">{{ e }}</span>
        }
      </label>
      <div class="flex flex-col gap-1" data-password>
        <span id="label-password" class="flex items-center gap-2">Game password @if (password() !== 'keep') { <span title="Saved: {{ passwordSet() ? 'set' : 'not set' }}" data-changed="game_password">● <span class="sr-only">changed</span></span> }</span>
        @if (password() === 'keep') {
          <span class="flex items-center gap-2">
            <span data-password-state>{{ passwordSet() ? 'Set' : 'Not set' }}</span>
            <button hlmBtn variant="outline" size="sm" type="button" (click)="changePassword.emit()" data-password-change>Change</button>
          </span>
        } @else if (password() === 'remove') {
          <span class="flex items-center gap-2">
            <span data-password-state>Removed when saved</span>
            <button hlmBtn variant="ghost" size="sm" type="button" (click)="keepPassword.emit()" data-password-keep>Keep it</button>
          </span>
        } @else {
          <span class="flex flex-wrap items-center gap-2">
            <input
              hlmInput
              class="min-w-0 flex-1 ar-input--mono"
              [type]="reveal() ? 'text' : 'password'"
              autocomplete="new-password"
              aria-labelledby="label-password"
              [attr.aria-describedby]="errors()['game_password'] ? 'err-password' : 'hint-password'"
              [value]="newPassword()"
              (input)="newPasswordChange.emit($any($event.target).value)"
              data-password-input
            />
            <button hlmBtn variant="outline" size="sm" type="button" (click)="revealChange.emit(!reveal())" [attr.aria-pressed]="reveal()" data-password-reveal>{{ reveal() ? 'Hide' : 'Show' }}</button>
            <button hlmBtn variant="outline" size="sm" type="button" (click)="generate.emit()" data-password-generate>Generate</button>
            <button hlmBtn variant="ghost" size="sm" type="button" (click)="keepPassword.emit()" data-password-keep>Keep the old one</button>
          </span>
          <span id="hint-password" class="text-xs text-muted-foreground" data-password-note>Players need the new password. /srv/factorio/first-boot.txt on the friend's VM still shows the first one.</span>
        }
        @if (password() !== 'remove' && passwordSet()) {
          <button hlmBtn variant="ghost" size="sm" type="button" class="self-start" [disabled]="!form().require_user_verification" (click)="removePassword.emit()" data-password-remove>Remove password</button>
        }
        @if (errors()['game_password']; as e) {
          <span id="err-password" class="text-xs text-destructive" data-error="game_password">{{ e }}</span>
        }
      </div>
    </fieldset>

    <fieldset class="ar-panel flex flex-col gap-3 p-5" [disabled]="readOnly()" data-card="joining">
      <legend class="px-1 font-semibold">Joining</legend>
      <div class="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          [attr.aria-checked]="form().require_user_verification"
          aria-labelledby="label-verification"
          class="ar-switch disabled:opacity-45"
          (click)="verification.emit(!form().require_user_verification)"
          data-field="require_user_verification"
        ></button>
        <span id="label-verification" class="flex items-center gap-2">{{ labelOf('require_user_verification') }}: {{ form().require_user_verification ? 'on' : 'off' }} @if (changed('require_user_verification')) { <span [title]="was('require_user_verification')" data-changed="require_user_verification">● <span class="sr-only">changed</span></span> }</span>
      </div>
      <div aria-live="polite" data-warning-region>
        @if (!form().require_user_verification) {
          <div class="ar-callout ar-callout--warn block" data-warning>
            <b>Names are not checked.</b> Without this, players join with no factorio.com account check: anyone who has the game password can join under any name, an admin's included. As an admin they can run Lua commands,
            when commands are on for admins, and through those take over the game, post to Discord as anyone, and pass for a linked player. Bans by name stop no one. Turn it off only for players without a factorio.com account
            (such as a family-shared copy). Keep the game password secret, and change it here if it leaks.
          </div>
        }
      </div>
      <label class="flex flex-col gap-1">
        <span class="flex items-center gap-2">Kick idle players after (minutes) @if (changed('afk_autokick_interval')) { <span [title]="was('afk_autokick_interval')" data-changed="afk_autokick_interval">● <span class="sr-only">changed</span></span> }</span>
        <input hlmInput type="number" min="0" max="1440" step="1" class="max-w-32" [value]="form().afk_autokick_interval" (input)="setNumber('afk_autokick_interval', $any($event.target).value)" aria-describedby="hint-afk" data-field="afk_autokick_interval" />
        <span id="hint-afk" class="text-xs text-muted-foreground">0: never</span>
        @if (errors()['afk_autokick_interval']; as e) {
          <span class="text-xs text-destructive" data-error="afk_autokick_interval">{{ e }}</span>
        }
      </label>
    </fieldset>

    <fieldset class="ar-panel flex flex-col gap-2 p-5" [disabled]="readOnly()" data-card="pausing">
      <legend class="px-1 font-semibold">Pausing</legend>
      @for (k of pauseKeys; track k) {
        <label class="ar-check flex items-center gap-2">
          <input type="checkbox" [checked]="form()[k]" (change)="set(k, $any($event.target).checked)" [attr.data-field]="k" />
          {{ labelOf(k) }}
          @if (atRestart(k)) {
            <span class="rounded border px-1.5 text-xs text-muted-foreground" data-badge>next restart</span>
          }
          @if (changed(k)) {
            <span [title]="was(k)" [attr.data-changed]="k">● <span class="sr-only">changed</span></span>
          }
        </label>
      }
    </fieldset>

    <fieldset class="ar-panel flex flex-col gap-3 p-5" [disabled]="readOnly()" data-card="saving">
      <legend class="px-1 font-semibold">Saving</legend>
      <label class="flex flex-col gap-1">
        <span class="flex items-center gap-2">Autosave every (minutes) @if (changed('autosave_interval')) { <span [title]="was('autosave_interval')" data-changed="autosave_interval">● <span class="sr-only">changed</span></span> }</span>
        <input hlmInput type="number" min="0" max="1440" step="1" class="max-w-32" [value]="form().autosave_interval" (input)="setNumber('autosave_interval', $any($event.target).value)" aria-describedby="hint-autosave" data-field="autosave_interval" />
        <span id="hint-autosave" class="text-xs text-muted-foreground">0: off</span>
        @if (errors()['autosave_interval']; as e) {
          <span class="text-xs text-destructive" data-error="autosave_interval">{{ e }}</span>
        }
      </label>
      <label class="flex flex-col gap-1">
        <span class="flex items-center gap-2"
          >Autosave slots <span class="rounded border px-1.5 text-xs text-muted-foreground" data-badge>next restart</span>
          @if (changed('autosave_slots')) { <span [title]="was('autosave_slots')" data-changed="autosave_slots">● <span class="sr-only">changed</span></span> }</span
        >
        <input hlmInput type="number" min="1" max="100" step="1" class="max-w-32" [value]="form().autosave_slots" (input)="setNumber('autosave_slots', $any($event.target).value)" data-field="autosave_slots" />
        @if (errors()['autosave_slots']; as e) {
          <span class="text-xs text-destructive" data-error="autosave_slots">{{ e }}</span>
        }
      </label>
      <p class="text-xs text-muted-foreground">orrery's own saves (every 6 h after play, and before updates) are separate from Factorio's autosaves.</p>
    </fieldset>

    <fieldset class="ar-panel flex flex-col gap-2 p-5" [disabled]="readOnly()" data-card="commands">
      <legend class="px-1 font-semibold">Lua commands</legend>
      <label class="flex flex-col gap-1">
        <span class="flex items-center gap-2">Who may run them @if (changed('allow_commands')) { <span [title]="was('allow_commands')" data-changed="allow_commands">● <span class="sr-only">changed</span></span> }</span>
        <select class="ar-input max-w-48" (change)="set('allow_commands', $any($event.target).value)" aria-describedby="hint-commands" data-field="allow_commands">
          @for (o of commands; track o.value) {
            <option [value]="o.value" [selected]="o.value === form().allow_commands">{{ o.label }}</option>
          }
        </select>
      </label>
      @if (!form().require_user_verification && form().allow_commands !== 'false') {
        <p class="text-xs text-destructive" data-commands-risk>Anyone with the game password can run Lua as an admin.</p>
      } @else if (!form().require_user_verification && commandsOffWithCheck()) {
        <p class="text-xs text-muted-foreground" data-commands-off>Turned off with the account check: names can't be trusted.</p>
      }
      <p id="hint-commands" class="text-xs text-muted-foreground">Commands can change anything in the game, and using one disables achievements for that save for good.</p>
    </fieldset>

    <fieldset class="ar-panel flex flex-col gap-2 p-5" [disabled]="readOnly()" data-card="admins">
      <legend class="px-1 font-semibold">Admins @if (changed('admins')) { <span [title]="was('admins')" data-changed="admins">● <span class="sr-only">changed</span></span> }</legend>
      @if (form().admins.length) {
        <ul class="flex flex-wrap gap-1.5" aria-label="Admins">
          @for (a of form().admins; track a) {
            <li class="flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2 font-mono text-xs" [attr.data-admin]="a">
              {{ a }}
              @if (!form().require_user_verification) {
                <span class="font-sans text-muted-foreground">(name not checked)</span>
              }
              <button hlmBtn variant="ghost" size="icon-sm" type="button" [attr.aria-label]="'Remove ' + a + ' from the admins'" (click)="removeAdmin(a)" data-admin-remove>
                <ng-icon name="arClose" />
              </button>
            </li>
          }
        </ul>
      } @else {
        <p class="text-muted-foreground" data-no-admins>No admins.</p>
      }
      <form class="flex flex-col gap-1" (submit)="$event.preventDefault(); addAdmin()">
        <span class="flex gap-2">
          <input
            hlmInput
            class="min-w-0 flex-1 ar-input--mono"
            aria-label="A player name to make an admin"
            [attr.aria-describedby]="adminError() ? 'err-admin' : null"
            [value]="adding()"
            (input)="addingChange.emit($any($event.target).value)"
            data-admin-name
          />
          <button hlmBtn variant="outline" type="submit" [disabled]="!adding().trim() || !!adminError()" data-admin-add>Add</button>
        </span>
        @if (adminError(); as e) {
          <span id="err-admin" class="text-xs text-destructive" data-error="admin">{{ e }}</span>
        }
      </form>
    </fieldset>
  `,
})
export class SettingsForm {
  readonly form = input.required<Form>();
  readonly saved = input.required<Form>();
  readonly readOnly = input.required<boolean>();
  readonly errors = input.required<Record<string, string>>();
  readonly password = input.required<'keep' | 'new' | 'remove'>();
  readonly passwordSet = input.required<boolean>();
  readonly newPassword = input.required<string>();
  readonly reveal = input.required<boolean>();
  readonly commandsOffWithCheck = input.required<boolean>();
  readonly adding = input.required<string>();
  readonly edit = output<Edit>();
  readonly verification = output<boolean>();
  readonly changePassword = output();
  readonly generate = output();
  readonly keepPassword = output();
  readonly removePassword = output();
  readonly newPasswordChange = output<string>();
  readonly revealChange = output<boolean>();
  readonly addingChange = output<string>();
  protected readonly commands = COMMANDS;
  protected readonly pauseKeys = ['auto_pause', 'auto_pause_when_players_connect', 'only_admins_can_pause_the_game'] as const;
  protected readonly adminError = computed(() => {
    const name = this.adding().trim();
    if (!name) return null;
    if (!ADMIN.test(name)) return ADMIN_RULE;
    if (this.form().admins.some((a) => a.toLowerCase() === name.toLowerCase())) return `${name} is an admin already.`;
    if (this.form().admins.length >= 100) return 'At most 100 admins.';
    return null;
  });
  protected labelOf = (k: Key) => LABELS[k];
  protected atRestart = (k: string) => AT_RESTART.has(k);
  protected changed = (k: Key | 'admins'): boolean => isChanged(this.form(), this.saved(), k);
  /** The saved value, for a changed field's title. */
  protected was = (k: Key | 'admins') => {
    const s = this.saved()[k];
    return `Saved: ${Array.isArray(s) ? s.join(', ') || 'none' : show(s)}`;
  };

  protected set<K extends keyof Form>(key: K, value: Form[K]): void {
    this.edit.emit({ key, value } as Edit);
  }

  protected setNumber(key: Key, raw: string): void {
    this.edit.emit({ key, value: raw === '' ? Number.NaN : Number(raw) } as Edit);
  }

  protected addAdmin(): void {
    const name = this.adding().trim();
    if (!name || this.adminError()) return;
    this.set('admins', [...this.form().admins, name]);
    this.addingChange.emit('');
  }

  protected removeAdmin(name: string): void {
    this.set(
      'admins',
      this.form().admins.filter((a) => a !== name),
    );
  }
}

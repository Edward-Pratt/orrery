import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { AllowCommands, GameSettingsAnswer, GameSettingsFields, GameSettingsRequest, GameSettingsState, LiveEvent, RestartRequest } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { catchError, debounceTime, EMPTY, filter, firstValueFrom, startWith, Subject, switchMap } from 'rxjs';
import { LiveEvents, ofServer, ofTarget } from '../events';
import { Feedback } from '../feedback';
import { changesCard } from './changes';
import ServerPage from './server';

type Key = keyof GameSettingsFields;
/** The form: every field, and the admins. */
type Form = GameSettingsFields & { admins: string[] };

/** What a field is called on the page; `game_password` and `admins` too, for the footer and the pending banner. */
const LABELS: Record<Key | 'game_password' | 'admins', string> = {
  name: 'Name',
  description: 'Description',
  max_players: 'Max players',
  game_password: 'Game password',
  require_user_verification: "Check players' factorio.com accounts",
  autosave_interval: 'Autosave every',
  autosave_slots: 'Autosave slots',
  afk_autokick_interval: 'Kick idle players after',
  auto_pause: 'Pause while nobody is on',
  auto_pause_when_players_connect: 'Pause while a player joins',
  only_admins_can_pause_the_game: 'Only admins can pause',
  allow_commands: 'Lua commands',
  admins: 'Admins',
};
const KEYS = Object.keys(LABELS).filter((k): k is Key => k !== 'game_password' && k !== 'admins');
/** The keys Factorio takes only at a start (no `/config set` option). */
const AT_RESTART = new Set<string>(['auto_pause', 'autosave_slots']);
/** What setup writes: shown while the file can't be read, so a save writes a fresh one. */
const DEFAULTS: GameSettingsFields = {
  name: 'orrery Factorio',
  description: '',
  max_players: 0,
  require_user_verification: true,
  autosave_interval: 10,
  autosave_slots: 5,
  afk_autokick_interval: 0,
  auto_pause: true,
  auto_pause_when_players_connect: false,
  only_admins_can_pause_the_game: true,
  allow_commands: 'admins-only',
};
// The hub's and the Agent's rules (hub/src/protocol.ts, GAME_SETTINGS), for the form's own checks.
const RANGES: Partial<Record<Key, [number, number]>> = { max_players: [0, 1000], autosave_interval: [0, 1440], autosave_slots: [1, 100], afk_autokick_interval: [0, 1440] };
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const PASSWORD = /^[\x21-\x7e]{1,64}$/;
const ADMIN = /^[A-Za-z0-9_.-]{1,60}$/;
const ADMIN_RULE = 'Names are 1 to 60 letters, digits, _, . or -.';
const NEEDS_PASSWORD = 'Without the account check a game password is needed.';
const COMMANDS: { value: AllowCommands; label: string }[] = [
  { value: 'false', label: 'Off' },
  { value: 'admins-only', label: 'Admins only' },
  { value: 'true', label: 'Everyone' },
];
const GENERATED = 20;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** A Host's Agent went silent or came back: whether a save can go changes. */
const agentNotice = (e: LiveEvent) => 'target' in e && e.target === 'host' && e.type === 'notice' && (e.kind === 'agentLost' || e.kind === 'agentBack');
/**
 * The hub's reasons that leave nothing to edit (hub/src/game-settings.ts): an Agent too old for game settings, one
 * not connected, and one that hasn't reported yet. Any other reason only holds Save back.
 */
const readOnlyWhy = (blocked: string | null) =>
  blocked !== null && (blocked.startsWith("This server's Agent runs ") || blocked === "The Agent isn't connected." || blocked.endsWith("hasn't reported its game settings yet."));
const show = (v: unknown) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : v === '' ? '(empty)' : String(v));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const lower = (names: string[]) => names.map((n) => n.toLowerCase()).sort();

/** 20 random letters and digits, made here in the browser. */
export function generatePassword(): string {
  const out: string[] = [];
  const bytes = new Uint8Array(1);
  while (out.length < GENERATED) {
    crypto.getRandomValues(bytes);
    if (bytes[0]! < 248) out.push(ALPHABET[bytes[0]! % ALPHABET.length]!); // 248 = 4 × 62: no bias
  }
  return out.join('');
}

/**
 * A factorio server's Settings section (only with `features.settings`): its game settings, as its Agent last read
 * them, in cards (Server, Joining, Pausing, Saving, Lua commands, Admins), changed here and saved with one PUT. The
 * footer says what applies now and what at the next restart; keys waiting for a restart stay in a banner with
 * Restart…. Turning the account check off shows what that costs, switches Lua commands off and needs a game
 * password. The password is write-only: typed or generated here, sent once, and never shown back.
 */
@Component({
  selector: 'app-server-settings',
  imports: [NgIcon, HlmButton, HlmInput, HlmSpinner],
  viewProviders: [provideIcons({ lucideX })],
  template: `
    @if (missing(); as why) {
      <p class="text-muted-foreground" data-missing>{{ why }}</p>
    } @else if (state(); as s) {
      <div class="flex max-w-3xl flex-col gap-4 pb-28 text-sm">
        @if (s.rolledBack; as r) {
          <div class="rounded-lg bg-destructive/10 px-3 py-2" role="alert" data-rolled-back>
            <b class="text-destructive">The server didn't start with the settings saved last,</b> so the Agent put back the ones it last started with: {{ r }}
          </div>
        }
        @if (old()) {
          <p class="rounded-lg border px-3 py-2" data-old-agent>{{ s.blocked }}</p>
        } @else if (readOnly()) {
          <p class="rounded-lg border px-3 py-2 text-muted-foreground" data-read-only>{{ s.blocked }} The fields show its last report.</p>
        }
        @if (s.pending.length) {
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-warn/40 bg-status-warn/10 px-3 py-2" data-pending>
            <span>Waiting for a restart: {{ labels(s.pending) }}.</span>
            @if (online()) {
              <button hlmBtn variant="outline" size="sm" [disabled]="restarting()" (click)="restart()" data-restart>
                @if (restarting()) {
                  <hlm-spinner />
                }
                Restart…
              </button>
            }
          </div>
        }
        @if (stopped()) {
          <p class="rounded-lg bg-muted px-3 py-2 text-muted-foreground" data-stopped>The server is stopped: changes are written now and apply when it starts.</p>
        }
        @if (s.problem; as p) {
          <p class="rounded-lg bg-status-warn/10 px-3 py-2" data-problem>server-settings.json can't be read ({{ p }}). Saving writes a new one from these fields.</p>
        }

        <fieldset class="flex flex-col gap-3 rounded-xl border bg-card p-5" [disabled]="readOnly()" data-card="server">
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
            <input hlmInput type="number" min="0" max="1000" step="1" class="w-32" [value]="form().max_players" (input)="setNumber('max_players', $any($event.target).value)" aria-describedby="hint-max-players" data-field="max_players" />
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
                <button hlmBtn variant="outline" size="sm" type="button" (click)="changePassword()" data-password-change>Change</button>
              </span>
            } @else if (password() === 'remove') {
              <span class="flex items-center gap-2">
                <span data-password-state>Removed when saved</span>
                <button hlmBtn variant="ghost" size="sm" type="button" (click)="keepPassword()" data-password-keep>Keep it</button>
              </span>
            } @else {
              <span class="flex flex-wrap items-center gap-2">
                <input
                  hlmInput
                  class="min-w-0 flex-1 font-mono"
                  [type]="reveal() ? 'text' : 'password'"
                  autocomplete="new-password"
                  aria-labelledby="label-password"
                  [attr.aria-describedby]="errors()['game_password'] ? 'err-password' : 'hint-password'"
                  [value]="newPassword()"
                  (input)="newPassword.set($any($event.target).value)"
                  data-password-input
                />
                <button hlmBtn variant="outline" size="sm" type="button" (click)="reveal.set(!reveal())" [attr.aria-pressed]="reveal()" data-password-reveal>{{ reveal() ? 'Hide' : 'Show' }}</button>
                <button hlmBtn variant="outline" size="sm" type="button" (click)="generate()" data-password-generate>Generate</button>
                <button hlmBtn variant="ghost" size="sm" type="button" (click)="keepPassword()" data-password-keep>Keep the old one</button>
              </span>
              <span id="hint-password" class="text-xs text-muted-foreground" data-password-note>Players need the new password. /srv/factorio/first-boot.txt on the friend's VM still shows the first one.</span>
            }
            @if (password() !== 'remove' && passwordSet()) {
              <button hlmBtn variant="ghost" size="sm" type="button" class="self-start" [disabled]="!form().require_user_verification" (click)="removePassword()" data-password-remove>Remove password</button>
            }
            @if (errors()['game_password']; as e) {
              <span id="err-password" class="text-xs text-destructive" data-error="game_password">{{ e }}</span>
            }
          </div>
        </fieldset>

        <fieldset class="flex flex-col gap-3 rounded-xl border bg-card p-5" [disabled]="readOnly()" data-card="joining">
          <legend class="px-1 font-semibold">Joining</legend>
          <div class="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              [attr.aria-checked]="form().require_user_verification"
              aria-labelledby="label-verification"
              class="relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-50"
              [class]="form().require_user_verification ? 'bg-primary' : 'bg-muted'"
              (click)="setVerification(!form().require_user_verification)"
              data-field="require_user_verification"
            >
              <span class="absolute top-0.5 size-4.5 rounded-full bg-background shadow transition-all" [class]="form().require_user_verification ? 'left-5.5' : 'left-0.5'"></span>
            </button>
            <span id="label-verification" class="flex items-center gap-2">{{ labelOf('require_user_verification') }}: {{ form().require_user_verification ? 'on' : 'off' }} @if (changed('require_user_verification')) { <span [title]="was('require_user_verification')" data-changed="require_user_verification">● <span class="sr-only">changed</span></span> }</span>
          </div>
          <div aria-live="polite" data-warning-region>
            @if (!form().require_user_verification) {
              <div class="rounded-lg border border-status-warn/50 bg-status-warn/10 px-3 py-2" data-warning>
                <b>Names are not checked.</b> Without this, players join with no factorio.com account check: anyone who has the game password can join under any name, an admin's included. As an admin they can run Lua commands,
                when commands are on for admins, and through those take over the game, post to Discord as anyone, and pass for a linked player. Bans by name stop no one. Turn it off only for players without a factorio.com account
                (such as a family-shared copy). Keep the game password secret, and change it here if it leaks.
              </div>
            }
          </div>
          <label class="flex flex-col gap-1">
            <span class="flex items-center gap-2">Kick idle players after (minutes) @if (changed('afk_autokick_interval')) { <span [title]="was('afk_autokick_interval')" data-changed="afk_autokick_interval">● <span class="sr-only">changed</span></span> }</span>
            <input hlmInput type="number" min="0" max="1440" step="1" class="w-32" [value]="form().afk_autokick_interval" (input)="setNumber('afk_autokick_interval', $any($event.target).value)" aria-describedby="hint-afk" data-field="afk_autokick_interval" />
            <span id="hint-afk" class="text-xs text-muted-foreground">0: never</span>
            @if (errors()['afk_autokick_interval']; as e) {
              <span class="text-xs text-destructive" data-error="afk_autokick_interval">{{ e }}</span>
            }
          </label>
        </fieldset>

        <fieldset class="flex flex-col gap-2 rounded-xl border bg-card p-5" [disabled]="readOnly()" data-card="pausing">
          <legend class="px-1 font-semibold">Pausing</legend>
          @for (k of pauseKeys; track k) {
            <label class="flex items-center gap-2">
              <input type="checkbox" class="size-4" [checked]="form()[k]" (change)="set(k, $any($event.target).checked)" [attr.data-field]="k" />
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

        <fieldset class="flex flex-col gap-3 rounded-xl border bg-card p-5" [disabled]="readOnly()" data-card="saving">
          <legend class="px-1 font-semibold">Saving</legend>
          <label class="flex flex-col gap-1">
            <span class="flex items-center gap-2">Autosave every (minutes) @if (changed('autosave_interval')) { <span [title]="was('autosave_interval')" data-changed="autosave_interval">● <span class="sr-only">changed</span></span> }</span>
            <input hlmInput type="number" min="0" max="1440" step="1" class="w-32" [value]="form().autosave_interval" (input)="setNumber('autosave_interval', $any($event.target).value)" aria-describedby="hint-autosave" data-field="autosave_interval" />
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
            <input hlmInput type="number" min="1" max="100" step="1" class="w-32" [value]="form().autosave_slots" (input)="setNumber('autosave_slots', $any($event.target).value)" data-field="autosave_slots" />
            @if (errors()['autosave_slots']; as e) {
              <span class="text-xs text-destructive" data-error="autosave_slots">{{ e }}</span>
            }
          </label>
          <p class="text-xs text-muted-foreground">orrery's own saves (every 6 h after play, and before updates) are separate from Factorio's autosaves.</p>
        </fieldset>

        <fieldset class="flex flex-col gap-2 rounded-xl border bg-card p-5" [disabled]="readOnly()" data-card="commands">
          <legend class="px-1 font-semibold">Lua commands</legend>
          <label class="flex flex-col gap-1">
            <span class="flex items-center gap-2">Who may run them @if (changed('allow_commands')) { <span [title]="was('allow_commands')" data-changed="allow_commands">● <span class="sr-only">changed</span></span> }</span>
            <select class="h-9 w-48 rounded-md border bg-background px-2" (change)="set('allow_commands', $any($event.target).value)" aria-describedby="hint-commands" data-field="allow_commands">
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

        <fieldset class="flex flex-col gap-2 rounded-xl border bg-card p-5" [disabled]="readOnly()" data-card="admins">
          <legend class="px-1 font-semibold">Admins @if (changed('admins')) { <span [title]="was('admins')" data-changed="admins">● <span class="sr-only">changed</span></span> }</legend>
          @if (form().admins.length) {
            <ul class="flex flex-wrap gap-1.5" aria-label="Admins">
              @for (a of form().admins; track a) {
                <li class="flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2 font-mono text-xs" [attr.data-admin]="a">
                  {{ a }}
                  @if (!form().require_user_verification) {
                    <span class="font-sans text-muted-foreground">(name not checked)</span>
                  }
                  <button hlmBtn variant="ghost" size="sm" type="button" class="size-6 p-0" [attr.aria-label]="'Remove ' + a + ' from the admins'" (click)="removeAdmin(a)" data-admin-remove>
                    <ng-icon name="lucideX" />
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
                class="min-w-0 flex-1 font-mono"
                aria-label="A player name to make an admin"
                [attr.aria-describedby]="adminError() ? 'err-admin' : null"
                [value]="adding()"
                (input)="adding.set($any($event.target).value)"
                data-admin-name
              />
              <button hlmBtn variant="outline" type="submit" [disabled]="!adding().trim() || !!adminError()" data-admin-add>Add</button>
            </span>
            @if (adminError(); as e) {
              <span id="err-admin" class="text-xs text-destructive" data-error="admin">{{ e }}</span>
            }
          </form>
        </fieldset>
      </div>

      @if (!old()) {
        <footer class="sticky bottom-0 -mx-4 flex max-w-3xl flex-col gap-2 border-t bg-background/95 px-4 py-3 text-sm backdrop-blur md:mx-0 md:px-0" data-footer>
          @if (dirty()) {
            <p data-applies>{{ applies() }}</p>
          }
          @if (s.extra.length) {
            <p class="text-xs text-muted-foreground" data-extra>Saving rewrites server-settings.json without: {{ s.extra.join(', ') }}.</p>
          }
          <div class="flex flex-wrap items-center gap-3">
            <button hlmBtn [disabled]="!canSave()" (click)="save()" data-save>
              @if (saving()) {
                <hlm-spinner />
              }
              Save
            </button>
            @if (s.blocked && !readOnly()) {
              <span class="text-muted-foreground" data-blocked>{{ s.blocked }}</span>
            } @else if (dirty() && !valid()) {
              <span class="text-destructive" data-invalid>Fix the fields marked above first.</span>
            }
          </div>
        </footer>
      }
    }
  `,
})
export default class Settings {
  readonly #server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly #url = `/api/servers/${encodeURIComponent(this.#server.id)}/settings`;
  protected readonly commands = COMMANDS;
  protected readonly pauseKeys = ['auto_pause', 'auto_pause_when_players_connect', 'only_admins_can_pause_the_game'] as const;

  readonly state = signal<GameSettingsState | null>(null);
  protected readonly missing = signal<string | null>(null);
  /** The fields changed here, over what the Agent last reported (unchanged ones follow its reports). */
  protected readonly edits = signal<Partial<Form>>({});
  /** The password: kept, a new one typed (`newPassword`), or removed. */
  protected readonly password = signal<'keep' | 'new' | 'remove'>('keep');
  protected readonly newPassword = signal('');
  protected readonly reveal = signal(false);
  /** Lua commands were switched off here with the account check. */
  protected readonly commandsOffWithCheck = signal(false);
  protected readonly adding = signal('');
  protected readonly saving = signal(false);
  protected readonly restarting = signal(false);
  readonly #reload = new Subject<void>();

  /** What the Agent last reported, or setup's defaults while the file can't be read. */
  protected readonly saved = computed<Form>(() => {
    const s = this.state();
    const { game_password_set: _, ...fields } = s?.settings ?? { ...DEFAULTS, game_password_set: false };
    return { ...fields, admins: s?.admins ?? [] };
  });
  protected readonly form = computed<Form>(() => ({ ...this.saved(), ...this.edits() }));
  protected readonly passwordSet = computed(() => this.state()?.settings?.game_password_set ?? false);
  protected readonly old = computed(() => this.state()?.blocked?.startsWith("This server's Agent runs ") ?? false);
  protected readonly readOnly = computed(() => readOnlyWhy(this.state()?.blocked ?? null));
  protected readonly online = computed(() => this.#server.card()?.online ?? false);
  protected readonly stopped = computed(() => {
    const state = this.#server.card()?.service?.state;
    return state === 'inactive' || state === 'failed';
  });
  /** The keys changed here, in the page's order. */
  protected readonly changes = computed(() => {
    const keys: (Key | 'game_password' | 'admins')[] = KEYS.filter((k) => this.changed(k));
    if (this.password() !== 'keep') keys.splice(KEYS.indexOf('max_players') + 1, 0, 'game_password');
    if (this.changed('admins')) keys.push('admins');
    return keys;
  });
  protected readonly dirty = computed(() => this.changes().length > 0);
  /** Each field's problem, by key. */
  protected readonly errors = computed(() => {
    const f = this.form();
    const out: Record<string, string> = {};
    if (f.name !== f.name.trim() || !f.name || f.name.length > 100 || CONTROL.test(f.name)) out['name'] = 'Name: 1 to 100 characters on one line, with no space at either end.';
    if (f.description.length > 256 || CONTROL.test(f.description)) out['description'] = 'Description: at most 256 characters on one line.';
    for (const [k, [min, max]] of Object.entries(RANGES) as [Key, [number, number]][]) {
      const v = f[k] as number;
      if (!Number.isInteger(v) || v < min || v > max) out[k] = `A whole number from ${min} to ${max}.`;
    }
    const pw = this.password();
    if (pw === 'new' && !PASSWORD.test(this.newPassword())) out['game_password'] = '1 to 64 characters of printable ASCII, with no space.';
    else if (!f.require_user_verification && (pw === 'remove' || (pw === 'keep' && !this.passwordSet()))) out['game_password'] = NEEDS_PASSWORD;
    return out;
  });
  protected readonly valid = computed(() => Object.keys(this.errors()).length === 0);
  protected readonly canSave = computed(() => this.dirty() && this.valid() && !this.saving() && !this.state()?.blocked);
  /** What a save would do, said before it is done. */
  protected readonly applies = computed(() => {
    const keys = this.changes();
    if (this.stopped()) return `Applies when the server starts: ${this.labels(keys)}.`;
    const later = keys.filter((k) => AT_RESTART.has(k) || (k === 'description' && this.form().description === ''));
    const now = keys.filter((k) => !later.includes(k));
    return [now.length ? `Applies now: ${this.labels(now)}.` : '', later.length ? `At the next restart: ${this.labels(later)}.` : ''].filter(Boolean).join(' ');
  });
  protected readonly adminError = computed(() => {
    const name = this.adding().trim();
    if (!name) return null;
    if (!ADMIN.test(name)) return ADMIN_RULE;
    if (this.form().admins.some((a) => a.toLowerCase() === name.toLowerCase())) return `${name} is an admin already.`;
    if (this.form().admins.length >= 100) return 'At most 100 admins.';
    return null;
  });

  constructor() {
    this.#reload
      .pipe(
        debounceTime(50),
        startWith(undefined),
        switchMap(() =>
          this.#http.get<GameSettingsState>(this.#url).pipe(
            catchError((err: HttpErrorResponse) => {
              if (!this.state()) {
                // The dashboard runs ahead of the hub: an older one has no such route.
                this.missing.set(err.status === 404 ? 'This hub has no game settings yet: deploy hub-v2.16.0 or later.' : `The hub didn't answer (HTTP ${err.status}).`);
              }
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((s) => this.state.set(s));
    const events = inject(LiveEvents).all$;
    // Whether a save can go changes with deploys, the service starting or stopping, and the Agent leaving or coming back.
    events.pipe(filter((l) => ofTarget('deploy')(l) || ofTarget('service')(l) || agentNotice(l.event)), takeUntilDestroyed()).subscribe(() => this.#reload.next());
    events.pipe(filter(ofServer(this.#server.id)), takeUntilDestroyed()).subscribe(({ event: e }) => {
      if ((e.type === 'notice' && (e.kind === 'settings' || e.kind.startsWith('packUpdate'))) || changesCard(e)) this.#reload.next();
    });
  }

  protected labelOf = (k: Key) => LABELS[k];
  protected labels = (keys: string[]) => keys.map((k) => LABELS[k as Key] ?? k).join(', ');
  protected atRestart = (k: string) => AT_RESTART.has(k);
  protected changed = (k: Key | 'admins'): boolean => {
    const f = this.form()[k];
    const s = this.saved()[k];
    return Array.isArray(f) ? lower(f).join() !== lower(s as string[]).join() : f !== s;
  };
  /** The saved value, for a changed field's title. */
  protected was = (k: Key | 'admins') => {
    const s = this.saved()[k];
    return `Saved: ${Array.isArray(s) ? s.join(', ') || 'none' : show(s)}`;
  };

  protected set<K extends keyof Form>(key: K, value: Form[K]): void {
    this.edits.update((e) => ({ ...e, [key]: value }));
  }

  protected setNumber(key: Key, raw: string): void {
    this.edits.update((e) => ({ ...e, [key]: raw === '' ? Number.NaN : Number(raw) }));
  }

  /** Turning the account check off also switches Lua commands off, which the owner can change back. */
  protected setVerification(on: boolean): void {
    this.set('require_user_verification', on);
    if (!on && this.form().allow_commands !== 'false') {
      this.set('allow_commands', 'false');
      this.commandsOffWithCheck.set(true);
    }
    if (on) this.commandsOffWithCheck.set(false);
  }

  protected changePassword(): void {
    this.password.set('new');
    this.newPassword.set('');
    this.reveal.set(false);
  }

  protected generate(): void {
    this.password.set('new');
    this.newPassword.set(generatePassword());
    this.reveal.set(true);
  }

  protected keepPassword(): void {
    this.password.set('keep');
    this.newPassword.set('');
  }

  protected removePassword(): void {
    this.password.set('remove');
    this.newPassword.set('');
  }

  protected addAdmin(): void {
    const name = this.adding().trim();
    if (!name || this.adminError()) return;
    this.set('admins', [...this.form().admins, name]);
    this.adding.set('');
  }

  protected removeAdmin(name: string): void {
    this.set(
      'admins',
      this.form().admins.filter((a) => a !== name),
    );
  }

  /** The request: every field and the admins; the password only when it changes. */
  request(): GameSettingsRequest {
    const { admins, ...fields } = this.form();
    const pw = this.password();
    return { ...fields, admins, ...(pw === 'new' ? { game_password: this.newPassword() } : pw === 'remove' ? { game_password: null } : {}) };
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    try {
      const answer = await firstValueFrom(this.#http.put<GameSettingsAnswer>(this.#url, this.request()));
      this.edits.set({});
      this.keepPassword();
      this.commandsOffWithCheck.set(false);
      const later = answer.pending.length;
      this.#feedback.ok(later ? `Saved. ${plural(later, 'change applies', 'changes apply')} at the next restart.` : 'Saved.');
      this.#reload.next();
    } catch (err) {
      if (err instanceof HttpErrorResponse) this.#feedback.failed('Saving the settings', err);
      else throw err;
    } finally {
      this.saving.set(false);
    }
  }

  /** Restarts the server for what waits on a restart: a 5-minute countdown while players are on, else now. */
  protected async restart(): Promise<void> {
    const card = this.#server.card()!;
    const players = card.players.length;
    const ok = await this.#feedback.confirm({
      title: `Restart ${card.name}?`,
      description: players
        ? `${plural(players, 'player is', 'players are')} online: the restart counts down 5 minutes in game first.`
        : `${card.name} is briefly down while it restarts.`,
      verb: `Restart ${card.name}`,
    });
    if (!ok) return;
    this.restarting.set(true);
    try {
      await firstValueFrom(this.#http.post(`/api/servers/${encodeURIComponent(card.id)}/restart`, { minutes: players ? 5 : 0 } satisfies RestartRequest));
      this.#feedback.ok(players ? `${card.name} restarts in 5 minutes.` : `${card.name} is restarting.`);
      this.#server.refresh();
    } catch (err) {
      if (err instanceof HttpErrorResponse) this.#feedback.failed(`Restart of ${card.name}`, err);
      else throw err;
    } finally {
      this.restarting.set(false);
    }
  }
}

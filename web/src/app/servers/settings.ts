import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { GameSettingsAnswer, GameSettingsRequest, GameSettingsState, RestartRequest } from '@hub/api';
import { catchError, debounceTime, EMPTY, filter, firstValueFrom, startWith, Subject, switchMap } from 'rxjs';
import { LiveEvents, ofServer, ofTarget } from '../events';
import { Feedback } from '../feedback';
import { changesCard } from './changes';
import ServerPage from './server';
import { SettingsBanners } from './settings-banners';
import { SettingsFooter } from './settings-footer';
import { SettingsForm } from './settings-form';
import { agentNotice, AT_RESTART, CONTROL, DEFAULTS, type Form, generatePassword, isChanged, type Key, KEYS, labels, NAME_BYTES, NEEDS_PASSWORD, PASSWORD, plural, RANGES, readOnlyWhy } from './settings-rules';

// The spec makes one to compare with.
export { generatePassword };

/**
 * A factorio server's Settings section (only with `features.settings`): its game settings, as its Agent last read
 * them, in cards (Server, Joining, Pausing, Saving, Lua commands, Admins), changed here and saved with one PUT. The
 * footer says what applies now and what at the next restart; keys waiting for a restart stay in a banner with
 * Restart…. Turning the account check off shows what that costs, switches Lua commands off and needs a game
 * password. The password is write-only: typed or generated here, sent once, and never shown back.
 * It holds the state, the form's edits, the password and every request; the banners are `settings-banners.ts`, the
 * cards `settings-form.ts`, the footer `settings-footer.ts`, the pure rules `settings-rules.ts`.
 */
@Component({
  selector: 'app-server-settings',
  imports: [SettingsBanners, SettingsFooter, SettingsForm],
  template: `
    @if (missing(); as why) {
      <p class="text-muted-foreground" data-missing>{{ why }}</p>
    } @else if (state(); as s) {
      <div class="flex max-w-3xl flex-col gap-4 pb-28 text-sm">
        <app-settings-banners
          [state]="s"
          [old]="old()"
          [readOnly]="readOnly()"
          [unreported]="unreported()"
          [online]="online()"
          [restarting]="restarting()"
          [stopped]="stopped()"
          (restart)="restart()"
        />

        @if (!unreported()) {
          <app-settings-form
            [form]="form()"
            [saved]="saved()"
            [readOnly]="readOnly()"
            [errors]="errors()"
            [password]="password()"
            [passwordSet]="passwordSet()"
            [newPassword]="newPassword()"
            [reveal]="reveal()"
            [commandsOffWithCheck]="commandsOffWithCheck()"
            [adding]="adding()"
            (edit)="set($event.key, $event.value)"
            (verification)="setVerification($event)"
            (changePassword)="changePassword()"
            (generate)="generate()"
            (keepPassword)="keepPassword()"
            (removePassword)="removePassword()"
            (newPasswordChange)="newPassword.set($event)"
            (revealChange)="reveal.set($event)"
            (addingChange)="adding.set($event)"
          />
        }
      </div>

      @if (!old() && !unreported()) {
        <app-settings-footer
          [state]="s"
          [dirty]="dirty()"
          [applies]="applies()"
          [canSave]="canSave()"
          [saving]="saving()"
          [readOnly]="readOnly()"
          [valid]="valid()"
          (save)="save()"
        />
      }
    }
  `,
})
export default class Settings {
  readonly #server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly #url = `/api/servers/${encodeURIComponent(this.#server.id)}/settings`;

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

  /**
   * No values to show: an Agent too old to report its settings, or one that hasn't yet (a restarted hub has none).
   * Only the hub's reason shows then, never values made up as the server's.
   */
  protected readonly unreported = computed(() => {
    const s = this.state();
    return s !== null && s.settings === null && s.problem === null;
  });
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
    else if (this.changed('name') && new TextEncoder().encode(f.name).length > NAME_BYTES) out['name'] = `Name: Factorio keeps only the first ${NAME_BYTES} bytes, so at most ${NAME_BYTES} plain letters (fewer with accents or emoji).`;
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
    if (this.stopped()) return `Applies when the server starts: ${labels(keys)}.`;
    const later = keys.filter((k) => AT_RESTART.has(k));
    const now = keys.filter((k) => !later.includes(k));
    return [now.length ? `Applies now: ${labels(now)}.` : '', later.length ? `At the next restart: ${labels(later)}.` : ''].filter(Boolean).join(' ');
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
      if ((e.type === 'notice' && (e.kind === 'settings' || e.kind === 'packUpdateStarted' || e.kind === 'packUpdateFinished')) || changesCard(e)) this.#reload.next();
    });
  }

  protected changed = (k: Key | 'admins'): boolean => isChanged(this.form(), this.saved(), k);

  protected set<K extends keyof Form>(key: K, value: Form[K]): void {
    this.edits.update((e) => ({ ...e, [key]: value }));
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

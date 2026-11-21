// The shell: sidebar (a bottom tab bar and slim header on a phone) with the switched-on integrations' pages
// (`PAGES`; Audit log, Library and Users only for a user with that permission), `UserMenu` (initials → Account,
// Log out) and the `ThemeSwitch` in the sidebar's foot (in the header on a phone); the attention strip above
// `<router-outlet>` and count badges
// on Servers, Services (down checks count there too) and Host (overdue releases). An invite link opened while logged in
// leaves the address at once, with a notice to log out first. With `checks` on and `systemd` off
// the Services entry reads "Checks".

import { Component, computed, effect, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { Integrations as IntegrationsOn, Me, Permission } from '@hub/api';
import { HlmAvatarImports } from '@spartan-ng/helm/avatar';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmToaster } from '@spartan-ng/helm/sonner';
import { catchError, of } from 'rxjs';
import { Attention, AttentionStrip } from './attention';
import { Integrations } from './integrations';
import { Feedback } from './feedback';
import { Login, takeInvite } from './login';
import { Logo } from './logo';
import { reguardOnChange, Session } from './session';
import { Theme } from './theme';
import { ThemeSwitch } from './theme-switch';

/** A page per switched-on integration that has one, in the sidebar's order. */
const PAGES: { path: string; label: string; icon: string; on?: keyof IntegrationsOn; unless?: keyof IntegrationsOn; needs?: Permission }[] = [
  { path: 'servers', label: 'Servers', icon: 'server', }, // every hub has servers
  { path: 'services', label: 'Services', icon: 'layers', on: 'systemd' },
  // The services page holds the checks; without systemd it is "Checks" and holds only those.
  { path: 'services', label: 'Checks', icon: 'check', on: 'checks', unless: 'systemd' },
  { path: 'host', label: 'Host', icon: 'cpu', on: 'host' },
  { path: 'library', label: 'Library', icon: 'library', on: 'library', needs: 'library' },
  { path: 'audit', label: 'Audit log', icon: 'logs', on: 'web', needs: 'audit' },
  { path: 'users', label: 'Users', icon: 'users', on: 'web', needs: 'users' },
];

/** The user's initials; opens a menu with Account and Log out. */
@Component({
  selector: 'app-user-menu',
  imports: [RouterLink, HlmAvatarImports, HlmDropdownMenuImports],
  template: `
    <button type="button" class="flex max-w-full items-center gap-2 rounded-md p-1 text-[var(--ink-soft)] hover:bg-muted hover:text-foreground max-md:min-h-[var(--control-touch)] max-md:min-w-[var(--control-touch)] max-md:justify-center" [hlmDropdownMenuTrigger]="menu" aria-label="Account menu">
      <hlm-avatar>
        <span hlmAvatarFallback>{{ initials() }}</span>
      </hlm-avatar>
      @if (showName()) {
        <span class="truncate text-sm">{{ user().username }}</span>
      }
    </button>
    <ng-template #menu>
      <div hlmDropdownMenu class="w-44">
        <a hlmDropdownMenuItem routerLink="/account" data-account>Account</a>
        <div hlmDropdownMenuSeparator></div>
        <button hlmDropdownMenuItem type="button" (click)="session.logout()">Log out</button>
      </div>
    </ng-template>
  `,
})
export class UserMenu {
  readonly user = input.required<Me>();
  readonly showName = input(false);
  protected readonly session = inject(Session);
  protected readonly initials = computed(() => this.user().username.slice(0, 2).toUpperCase());
}

/** The shell: sidebar (tab bar on a phone) of the integrations' pages, or the login card. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, UserMenu, ThemeSwitch, Login, HlmToaster, AttentionStrip, Logo],
  template: `
    <hlm-toaster [theme]="theme.dark() ? 'dark' : 'light'" />
    @switch (session.user()) {
      @case (undefined) {}
      @case (null) {
        <app-login />
      }
      @default {
        <div class="ar-shell">
          <aside class="ar-sidebar">
            <span class="ar-sidebar__brand"><app-logo class="size-6" /> orrery</span>
            <nav class="ar-nav" aria-label="Pages">
              @for (p of visible(); track p.path) {
                <a [routerLink]="p.path" routerLinkActive ariaCurrentWhenActive="page">
                  <i class="ar-icon" [class]="'ar-icon--' + p.icon"></i><span class="ar-nav__label">{{ p.label }}</span>
                  @if (badge(p.path); as n) {
                    <span class="ar-nav__count" data-badge> {{ n }}</span>
                  }
                </a>
              }
            </nav>
            <div class="ar-sidebar__foot flex items-center justify-between gap-2">
              <app-user-menu class="min-w-0" [user]="session.user()!" [showName]="true" /><app-theme-switch class="shrink-0" />
            </div>
          </aside>
          <div class="ar-shell__main">
            <header class="ar-topbar">
              <span class="flex flex-1 items-center gap-2"><app-logo class="size-6" /> orrery</span>
              <app-user-menu [user]="session.user()!" [showName]="false" /><app-theme-switch class="ar-t-ui" />
            </header>
            <app-attention-strip />
            <main class="mx-auto w-full max-w-[var(--content)] px-4 pt-4 pb-28 md:px-5 md:pt-5 md:pb-10">
              <router-outlet />
            </main>
          </div>
          <nav class="ar-tabbar fixed" aria-label="Pages">
            @for (p of visible(); track p.path) {
              <a [routerLink]="p.path" routerLinkActive ariaCurrentWhenActive="page">
                <span class="relative">
                  <i class="ar-icon ar-icon--lg" [class]="'ar-icon--' + p.icon"></i>
                  @if (badge(p.path); as n) {
                    <span class="ar-nav__count tabbar__count" data-badge>{{ n }}</span>
                  }
                </span>
                {{ p.label }}
              </a>
            }
          </nav>
        </div>
      }
    }
  `,
})
export class App {
  protected readonly session = inject(Session);
  protected readonly theme = inject(Theme); // applies the remembered theme before the first page shows
  readonly #on = toSignal(inject(Integrations).on$.pipe(catchError(() => of(undefined))));
  readonly #attention = inject(Attention);
  protected readonly visible = computed(() =>
    PAGES.filter((p) => (!p.on || this.#on()?.[p.on]) && !(p.unless && this.#on()?.[p.unless]) && (!p.needs || this.session.canAnywhere(p.needs))),
  );

  /** The count on a sidebar entry: only Servers, Services (or Checks) and Host have one. */
  protected badge(path: string): number {
    return path === 'servers' || path === 'services' || path === 'host' ? this.#attention.count(path) : 0;
  }

  constructor() {
    reguardOnChange();
    const feedback = inject(Feedback);
    effect(() => {
      const me = this.session.user();
      if (me && takeInvite() !== null) feedback.notice(`You are logged in as ${me.username}: log out, then open the invite link again.`);
    });
    this.session.load();
  }
}

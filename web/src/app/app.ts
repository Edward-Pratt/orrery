import { Component, computed, effect, inject, input } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { Integrations as IntegrationsOn, Me } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCpu, lucideLayers, lucideLibrary, lucideMonitor, lucideMoon, lucideScrollText, lucideServer, lucideSun } from '@ng-icons/lucide';
import { HlmAvatarImports } from '@spartan-ng/helm/avatar';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmToaster } from '@spartan-ng/helm/sonner';
import { catchError, of } from 'rxjs';
import { Attention, AttentionStrip } from './attention';
import { Environment, StagingBadge } from './environment';
import { Integrations } from './integrations';
import { Login } from './login';
import { Session } from './session';
import { MODES, Theme } from './theme';

/** A page per switched-on integration that has one, in the sidebar's order. */
const PAGES: { path: string; label: string; icon: string; on?: keyof IntegrationsOn; unless?: keyof IntegrationsOn }[] = [
  { path: 'servers', label: 'Servers', icon: 'lucideServer', }, // every hub has servers
  { path: 'services', label: 'Services', icon: 'lucideLayers', on: 'systemd' },
  // The services page holds the checks; without systemd it is "Checks" and holds only those.
  { path: 'services', label: 'Checks', icon: 'lucideCheck', on: 'checks', unless: 'systemd' },
  { path: 'host', label: 'Host', icon: 'lucideCpu', on: 'host' },
  { path: 'library', label: 'Library', icon: 'lucideLibrary', on: 'library' },
  { path: 'audit', label: 'Audit log', icon: 'lucideScrollText', on: 'web' },
];
const MODE_ICONS = { light: 'lucideSun', system: 'lucideMonitor', dark: 'lucideMoon' };

/** The admin's avatar (initials without one); opens a menu with Theme and Log out. */
@Component({
  selector: 'app-user-menu',
  imports: [HlmAvatarImports, HlmDropdownMenuImports, NgIcon],
  viewProviders: [provideIcons({ lucideSun, lucideMonitor, lucideMoon })],
  template: `
    <button type="button" class="flex items-center gap-2 rounded-md p-1 hover:bg-muted" [hlmDropdownMenuTrigger]="menu" aria-label="Account menu">
      <hlm-avatar>
        @if (avatarUrl(); as src) {
          <img hlmAvatarImage [src]="src" alt="" />
        }
        <span hlmAvatarFallback class="bg-brand text-xs font-semibold text-white">{{ initials() }}</span>
      </hlm-avatar>
      @if (showName()) {
        <span class="truncate text-sm">{{ user().username }}</span>
      }
    </button>
    <ng-template #menu>
      <div hlmDropdownMenu class="w-44">
        <div hlmDropdownMenuLabel>Theme</div>
        <div hlmDropdownMenuGroup>
          @for (m of modes; track m) {
            <button hlmDropdownMenuItem type="button" (click)="theme.set(m)" [attr.aria-current]="theme.mode() === m">
              <ng-icon [name]="icons[m]" /> <span class="capitalize">{{ m }}</span>
              @if (theme.mode() === m) {
                <span class="ml-auto text-xs text-muted-foreground">on</span>
              }
            </button>
          }
        </div>
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
  protected readonly theme = inject(Theme);
  protected readonly modes = MODES;
  protected readonly icons = MODE_ICONS;
  protected readonly avatarUrl = computed(() => {
    const { id, avatar } = this.user();
    return avatar ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=64` : null;
  });
  protected readonly initials = computed(() => this.user().username.slice(0, 2).toUpperCase());
}

/** The shell: sidebar (tab bar on a phone) of the integrations' pages, or the login card. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NgIcon, UserMenu, Login, HlmToaster, AttentionStrip, StagingBadge],
  viewProviders: [provideIcons({ lucideServer, lucideLayers, lucideCheck, lucideCpu, lucideLibrary, lucideScrollText })],
  template: `
    <hlm-toaster />
    @switch (session.user()) {
      @case (undefined) {}
      @case (null) {
        <app-login />
      }
      @default {
        <div class="min-h-dvh md:flex">
          <aside class="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-sidebar px-3 py-5 md:flex">
            <span class="flex items-center gap-2 px-3 text-lg font-bold tracking-tight">
              <span class="size-3 rounded-full bg-brand ring-4 ring-brand/20"></span> orrery <app-staging-badge />
            </span>
            <nav class="mt-8 flex flex-col gap-0.5" aria-label="Pages">
              @for (p of visible(); track p.path) {
                <a
                  [routerLink]="p.path"
                  routerLinkActive="bg-brand/10 text-brand-foreground"
                  class="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                >
                  <ng-icon [name]="p.icon" class="text-lg" /> {{ p.label }}
                  @if (badge(p.path); as n) {
                    <span class="ml-auto rounded-full bg-amber-500 px-2 text-xs font-semibold text-black" data-badge>{{ n }}</span>
                  }
                </a>
              }
            </nav>
            <div class="mt-auto px-1"><app-user-menu [user]="session.user()!" [showName]="true" /></div>
          </aside>
          <header class="sticky top-0 z-10 flex items-center justify-between border-b bg-background/90 px-4 py-2 backdrop-blur md:hidden">
            <span class="flex items-center gap-2 font-bold"><span class="size-2.5 rounded-full bg-brand"></span> orrery <app-staging-badge /></span>
            <app-user-menu [user]="session.user()!" [showName]="false" />
          </header>
          <div class="min-w-0 flex-1">
            <app-attention-strip />
            <main class="mx-auto w-full max-w-5xl px-4 pt-6 pb-28 md:px-10 md:pt-10 md:pb-10">
              <router-outlet />
            </main>
          </div>
          <nav
            class="fixed inset-x-0 bottom-0 z-10 flex border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
            aria-label="Pages"
          >
            @for (p of visible(); track p.path) {
              <a
                [routerLink]="p.path"
                routerLinkActive="text-brand-foreground"
                class="flex flex-1 flex-col items-center gap-1 py-2 text-[11px] text-muted-foreground"
              >
                <span class="relative">
                  <ng-icon [name]="p.icon" class="text-xl" />
                  @if (badge(p.path); as n) {
                    <span class="absolute -top-1 -right-2 rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-black" data-badge>{{ n }}</span>
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
  readonly #on = toSignal(inject(Integrations).on$.pipe(catchError(() => of(undefined))));
  readonly #attention = inject(Attention);
  protected readonly visible = computed(() => PAGES.filter((p) => (!p.on || this.#on()?.[p.on]) && !(p.unless && this.#on()?.[p.unless])));

  /** The count on a sidebar entry: only Servers, Services (or Checks) and Host have one. */
  protected badge(path: string): number {
    return path === 'servers' || path === 'services' || path === 'host' ? this.#attention.count(path) : 0;
  }

  constructor() {
    inject(Theme); // applies the remembered mode before the first page shows
    const env = inject(Environment);
    const title = inject(Title);
    effect(() => title.setTitle(env.staging() ? 'orrery (staging)' : 'orrery'));
    this.session.load();
  }
}

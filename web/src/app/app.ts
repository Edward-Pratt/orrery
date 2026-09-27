import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { Integrations as IntegrationsOn } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { catchError, of } from 'rxjs';
import { Integrations } from './integrations';
import { Session } from './session';

/** A page per switched-on integration that has one. */
const PAGES: { path: string; label: string; on: keyof IntegrationsOn }[] = [
  { path: 'servers', label: 'Servers', on: 'minecraft' },
  { path: 'checks', label: 'Checks', on: 'checks' },
];

/** Links to the pages of the integrations that are on; only shown once logged in. */
@Component({
  selector: 'app-nav',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav class="flex gap-4 text-sm">
      @for (p of pages; track p.path) {
        @if (on()?.[p.on]) {
          <a [routerLink]="p.path" routerLinkActive="font-semibold" class="hover:underline">{{ p.label }}</a>
        }
      }
    </nav>
  `,
})
export class Nav {
  protected readonly pages = PAGES;
  protected readonly on = toSignal(inject(Integrations).on$.pipe(catchError(() => of(undefined))));
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, HlmButton, Nav],
  template: `
    <header class="flex items-center justify-between border-b px-4 py-3">
      <div class="flex items-center gap-6">
        <span class="font-semibold">orrery</span>
        @if (session.user()) {
          <app-nav />
        }
      </div>
      @if (session.user(); as user) {
        <div class="flex items-center gap-3">
          <span class="text-sm text-muted-foreground">{{ user.username }}</span>
          <button hlmBtn variant="outline" size="sm" (click)="session.logout()">Log out</button>
        </div>
      }
    </header>
    <main class="p-4">
      @switch (session.user()) {
        @case (undefined) {}
        @case (null) {
          <div class="flex flex-col items-center gap-4 pt-24">
            <p class="text-muted-foreground">The dashboard is for admins.</p>
            <a hlmBtn href="/api/login">Log in with Discord</a>
          </div>
        }
        @default {
          <router-outlet />
        }
      }
    </main>
  `,
})
export class App {
  protected readonly session = inject(Session);

  constructor() {
    this.session.load();
  }
}

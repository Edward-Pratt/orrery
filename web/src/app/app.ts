import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmButton } from '@spartan-ng/helm/button';
import { Session } from './session';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, HlmButton],
  template: `
    <header class="flex items-center justify-between border-b px-4 py-3">
      <span class="font-semibold">orrery</span>
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

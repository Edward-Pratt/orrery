// The Users page's routes (`/users`, matched only with the `users` permission): a shell (`UsersShell`: the title and
// the Users and Roles tabs) over `users.ts` (the list) and `roles.ts`.

import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, type Routes } from '@angular/router';

/** The Users page's title and tabs. */
@Component({
  selector: 'app-users-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <h1 class="ar-t-heading-md mb-2">Users</h1>
    <nav class="ar-tabs mb-4 overflow-visible" data-tabs>
      <a routerLink="." routerLinkActive="border-[var(--verdigris)] font-semibold text-[var(--verdigris-hi)]" [routerLinkActiveOptions]="{ exact: true }">Users</a>
      <a routerLink="roles" routerLinkActive="border-[var(--verdigris)] font-semibold text-[var(--verdigris-hi)]">Roles</a>
    </nav>
    <router-outlet />
  `,
})
export class UsersShell {}

export default [
  {
    path: '',
    component: UsersShell,
    children: [
      { path: '', loadComponent: () => import('./users') },
      { path: 'roles', loadComponent: () => import('./roles') },
    ],
  },
] satisfies Routes;

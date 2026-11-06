// The Users page's routes (`/users`, matched only with the `users` permission): a shell (`UsersShell`: the title and
// the Users and Roles tabs) over `users.ts` (the list) and `roles.ts`.

import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, type Routes } from '@angular/router';

/** The Users page's title and tabs. */
@Component({
  selector: 'app-users-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <h1 class="mb-2 text-lg font-semibold">Users</h1>
    <nav class="mb-4 flex gap-4 border-b text-sm" data-tabs>
      <a routerLink="." routerLinkActive="border-b-2 border-foreground font-semibold" [routerLinkActiveOptions]="{ exact: true }" class="-mb-px pb-2 hover:underline">Users</a>
      <a routerLink="roles" routerLinkActive="border-b-2 border-foreground font-semibold" class="-mb-px pb-2 hover:underline">Roles</a>
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

// `servers` (always: every hub has servers; a server without a Mod token just has no Mod features), `audit` (with the
// `audit` permission), `account` and `users` (with `users`), and one lazy route per other integration with pages,
// matched only when it is on (`host`; systemd or checks: `services`, which holds the checks too; there is no `checks`
// route; `library` when the hub has one and the user holds `library`).

import { Component } from '@angular/core';
import type { Routes } from '@angular/router';
import { enabled } from './integrations';
import { allowed } from './session';

@Component({
  selector: 'app-nothing',
  template: `<p class="pt-24 text-center text-muted-foreground">Nothing here: no integration with pages is on.</p>`,
})
export class Nothing {}

/**
 * The servers (always: a hub has at least one, with the Mod's features only where it has a token) and the audit log; one
 * lazy route per other integration with pages (services: systemd or checks), matched only when the hub has it on (the Library: when the hub has one).
 */
export const routes: Routes = [
  { path: 'servers', loadChildren: () => import('./servers/routes') },
  { path: 'host', canMatch: [enabled('host')], loadChildren: () => import('./host/routes') },
  { path: 'library', canMatch: [enabled('library'), allowed('library')], loadChildren: () => import('./library/routes') },
  { path: 'services', canMatch: [enabled('systemd', 'checks')], loadChildren: () => import('./services/routes') },
  { path: 'audit', canMatch: [allowed('audit')], loadComponent: () => import('./audit') },
  { path: 'users', canMatch: [allowed('users')], loadChildren: () => import('./users/routes') },
  { path: 'account', loadComponent: () => import('./users/account') },
  { path: '', pathMatch: 'full', redirectTo: 'servers' },
  { path: '**', component: Nothing },
];

import { Component } from '@angular/core';
import type { Routes } from '@angular/router';
import { enabled } from './integrations';

@Component({
  selector: 'app-nothing',
  template: `<p class="pt-24 text-center text-muted-foreground">Nothing here: no integration with pages is on.</p>`,
})
export class Nothing {}

/**
 * The servers (always: a hub has at least one, with the Mod's features only where it has a token) and the audit log; one
 * lazy route per other integration with pages (services: systemd or checks), matched only when the hub has it on.
 */
export const routes: Routes = [
  { path: 'servers', loadChildren: () => import('./servers/routes') },
  { path: 'host', canMatch: [enabled('host')], loadChildren: () => import('./host/routes') },
  { path: 'services', canMatch: [enabled('systemd', 'checks')], loadChildren: () => import('./services/routes') },
  { path: 'audit', loadComponent: () => import('./audit') },
  { path: '', pathMatch: 'full', redirectTo: 'servers' },
  { path: '**', component: Nothing },
];

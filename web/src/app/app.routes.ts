import { Component } from '@angular/core';
import type { Routes } from '@angular/router';
import { enabled } from './integrations';

@Component({
  selector: 'app-nothing',
  template: `<p class="pt-24 text-center text-muted-foreground">Nothing here: no integration with pages is on.</p>`,
})
export class Nothing {}

/** One lazy route per integration with pages, matched only when the hub has it on. */
export const routes: Routes = [
  { path: 'servers', canMatch: [enabled('minecraft')], loadChildren: () => import('./servers/routes') },
  { path: 'checks', canMatch: [enabled('checks')], loadChildren: () => import('./checks/routes') },
  { path: 'host', canMatch: [enabled('host')], loadChildren: () => import('./host/routes') },
  { path: '', pathMatch: 'full', redirectTo: 'servers' },
  { path: '**', component: Nothing },
];

import type { Routes } from '@angular/router';

export default [{ path: '', loadComponent: () => import('./library') }] satisfies Routes;

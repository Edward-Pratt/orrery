import type { Routes } from '@angular/router';

export default [
  { path: '', loadComponent: () => import('./cards') },
  { path: ':id', loadComponent: () => import('./server') },
] satisfies Routes;

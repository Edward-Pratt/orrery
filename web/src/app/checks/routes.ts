import type { Routes } from '@angular/router';

export default [{ path: '', loadComponent: () => import('./checks') }] satisfies Routes;

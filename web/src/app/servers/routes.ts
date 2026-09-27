import type { Routes } from '@angular/router';

export default [
  { path: '', loadComponent: () => import('./cards') },
  {
    path: ':id',
    loadComponent: () => import('./server'),
    // The server page's sections; the shell links only those the server has (`SECTIONS`).
    children: [
      { path: '', loadComponent: () => import('./overview') },
      { path: 'chat', loadComponent: () => import('./chat') },
    ],
  },
] satisfies Routes;

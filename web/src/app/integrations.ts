import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { CanMatchFn } from '@angular/router';
import type { Integrations as IntegrationsOn } from '@hub/api';
import { catchError, map, of, shareReplay } from 'rxjs';

/** Which integrations the hub has switched on, asked once. */
@Injectable({ providedIn: 'root' })
export class Integrations {
  readonly on$ = inject(HttpClient).get<IntegrationsOn>('/api/integrations').pipe(shareReplay(1));
}

/** Matches a route only when the hub has integration `name` on. */
export const enabled =
  (name: keyof IntegrationsOn): CanMatchFn =>
  () =>
    inject(Integrations).on$.pipe(
      map((on) => on[name]),
      catchError(() => of(false)),
    );

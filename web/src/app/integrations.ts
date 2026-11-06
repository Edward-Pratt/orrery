// `Integrations` (`GET /api/integrations`, asked once someone is logged in: the hub answers it behind the session, and
// a login is in-page, with no reload, so asked earlier it would be a 401 for good) and `enabled(...names)`, the
// `canMatch` guard (any of them on).

import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import type { CanMatchFn } from '@angular/router';
import type { Integrations as IntegrationsOn } from '@hub/api';
import { catchError, filter, map, of, shareReplay, switchMap, take } from 'rxjs';
import { Session } from './session';

/** Which integrations the hub has switched on, asked once, after the first login. */
@Injectable({ providedIn: 'root' })
export class Integrations {
  readonly #http = inject(HttpClient);
  readonly on$ = toObservable(inject(Session).user).pipe(
    filter((me) => !!me),
    take(1),
    switchMap(() => this.#http.get<IntegrationsOn>('/api/integrations')),
    shareReplay(1),
  );
}

/** Matches a route only when the hub has at least one of the integrations `names` on. */
export const enabled =
  (...names: (keyof IntegrationsOn)[]): CanMatchFn =>
  () =>
    inject(Integrations).on$.pipe(
      map((on) => names.some((name) => on[name])),
      catchError(() => of(false)),
    );

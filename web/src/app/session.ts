import { HttpClient, HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import type { Me } from '@hub/api';
import { catchError, of, throwError } from 'rxjs';

/** Who is logged in: undefined while asking the hub, null when logged out. */
@Injectable({ providedIn: 'root' })
export class Session {
  readonly #http = inject(HttpClient);
  readonly user = signal<Me | null | undefined>(undefined);

  load(): void {
    this.#http
      .get<Me>('/api/me')
      .pipe(catchError(() => of(null))) // 401 (the interceptor saw it) or the hub is down: show the login
      .subscribe((me) => this.user.set(me));
  }

  /** The hub wants JSON on every POST (CSRF); HttpClient adds no content type for an empty body. */
  logout(): void {
    this.#http
      .post('/api/logout', null, { headers: { 'content-type': 'application/json' } })
      .subscribe({ complete: () => this.user.set(null), error: () => this.user.set(null) });
  }
}

/** Any 401 means the session is gone: back to the logged-out view. */
export const loggedOutOn401: HttpInterceptorFn = (req, next) => {
  const session = inject(Session);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401) session.user.set(null);
      return throwError(() => err);
    }),
  );
};

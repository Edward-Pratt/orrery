// `Session` (who is logged in and what they may do: `can`, `canAnywhere`, `owner`, the hub's rule over `Me`'s
// permissions; logout; `lost()` on a 401, setting `ended` when a session was open; `refresh()` asks `/api/me` again),
// the `loggedOutOn401` interceptor, `refreshOn403` (a 403 means a grant may have been taken away under the open page:
// `/api/me` is asked again, so what the user can't do hides; the request's own error, the hub's "Needs …", is its
// caller's toast), `allowed(permission)`, the `canMatch` guard of a page that needs one (it waits for the login), and
// `reguardOnChange()`, which runs the open page's guards again when the user or what they may do changes.
// The dashboard hiding what the user can't do is never the check: the hub refuses it either way.

import { HttpClient, HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { effect, inject, Injectable, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Router, type CanMatchFn } from '@angular/router';
import type { Me, Permission } from '@hub/api';
import { catchError, filter, map, of, take, throwError } from 'rxjs';

/** Who is logged in: undefined while asking the hub, null when logged out. */
@Injectable({ providedIn: 'root' })
export class Session {
  readonly #http = inject(HttpClient);
  readonly user = signal<Me | null | undefined>(undefined);
  /** Whether the hub ended the session under this open page (expired, logged out everywhere, disabled), for the login card. */
  readonly ended = signal(false);
  #refreshing = false;

  load(): void {
    this.#http
      .get<Me>('/api/me')
      .pipe(catchError(() => of(null))) // 401 (the interceptor saw it) or the hub is down: show the login
      .subscribe((me) => this.user.set(me));
  }

  /** Asks the hub again who this is and what they may do; keeps what it has if the hub doesn't answer. */
  refresh(): void {
    if (this.#refreshing || !this.user()) return;
    this.#refreshing = true;
    this.#http.get<Me>('/api/me').subscribe({
      next: (me) => ((this.#refreshing = false), this.user.set(me)),
      error: () => (this.#refreshing = false),
    });
  }

  /** Whether the user holds `permission` for every server or, given one, on `serverId` (the hub's `can`). */
  can(permission: Permission, serverId?: string): boolean {
    const held = this.user()?.permissions.find((p) => p.permission === permission);
    return !!held && (held.servers === null || (serverId !== undefined && held.servers.includes(serverId)));
  }

  /** Whether a server permission is held on any server at all (an upload names none). */
  canAnywhere(permission: Permission): boolean {
    return !!this.user()?.permissions.some((p) => p.permission === permission);
  }

  /** Owners alone edit roles, grant Owner and set Discord ids. */
  owner(): boolean {
    return this.user()?.owner === true;
  }

  /** The hub answered 401: logged out. */
  lost(): void {
    if (this.user()) this.ended.set(true);
    this.user.set(null);
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
      if (err instanceof HttpErrorResponse && err.status === 401) session.lost();
      return throwError(() => err);
    }),
  );
};

/** A 403: what the user may do may have changed, so the session asks again (and the page hides what they lost). */
export const refreshOn403: HttpInterceptorFn = (req, next) => {
  const session = inject(Session);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 403 && req.url !== '/api/me') session.refresh();
      return throwError(() => err);
    }),
  );
};

/** Matches a page only for a user who holds `permission` (anywhere, for a server one); waits until someone is logged in. */
export const allowed =
  (permission: Permission): CanMatchFn =>
  () => {
    const session = inject(Session);
    return toObservable(session.user).pipe(
      filter((me) => !!me),
      take(1),
      map(() => session.canAnywhere(permission)),
    );
  };

/**
 * Runs the open page's guards again when the user or what they may do changes (another login on this page, a grant
 * taken away and seen by `refresh()`), so a page they may no longer open gives way. Call once, from the shell.
 */
export function reguardOnChange(): void {
  const session = inject(Session);
  const router = inject(Router);
  let seen: string | null = null;
  effect(() => {
    const me = session.user();
    const key = me ? `${me.id} ${JSON.stringify(me.permissions)}` : null;
    if (key && seen !== null && key !== seen) void router.navigateByUrl(router.url, { onSameUrlNavigation: 'reload' });
    if (key) seen = key;
  });
}

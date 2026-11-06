# web (orrery-web)

The dashboard: an Angular 22 app (standalone components, zoneless, signals) with Tailwind 4 and spartan/ui. It talks
only to the hub's HTTP API under `/api`, same origin (Caddy serves both in production).

```bash
npm test         # Vitest through ng test (jsdom), once
npm run build    # production build into dist/web/browser; type-checks against the hub's API types
npm start        # dev server on http://localhost:4200, /api proxied to a local hub (proxy.conf.json)
```

## The hub's API types

`@hub/api` maps to `../hub/src/api.ts` (`tsconfig.json` `paths`); import from it type-only (`import type`). A hub
change that breaks the dashboard fails `npm run build`. That module imports only pure files (`hub/src/types.ts`, and
through `api-users.ts` the permission list `hub/src/users/permissions.ts`), so nothing from the hub's runtime or Node
types gets compiled here. Don't redeclare API types locally.

## Files

Each file in `src/` starts with a comment that says its job, and each page folder has a `CLAUDE.md` saying what its
pages hold: read those before changing them, and change them with the code. By area:

- The shell and the session: `app/app.ts`, `app/app.routes.ts`, `app/login.ts`, `app/session.ts`, `app/reload.ts`,
  `app/theme.ts`, `app/integrations.ts`, `app/environment.ts`.
- Shared pieces: `app/status.ts`, `app/chart.ts`, `app/feedback.ts`, `app/uploads.ts`, `app/units.ts`,
  `app/events.ts`, `app/attention.ts`, `app/logo.ts` (the mark; `public/favicon.svg` and `favicon.ico` are its copies).
- Pages: `app/audit.ts`, and the folders `app/host/`, `app/library/`, `app/services/`, `app/servers/` and `app/users/`
  (Users, Roles, Account).
- The Status page, booted on its own for `/status` by `main.ts`, without the shell: `app/public/`.
- Tests: `test-setup.ts`, `app/testing.ts`.

## Rules

- Every POST, PUT and DELETE sends `content-type: application/json`, even with no body (HttpClient adds none for `null`):
  the hub rejects anything else (CSRF). The one exception is an upload's chunk (`PUT /api/uploads/:upload`), raw
  `application/octet-stream`; files go up only through `uploads.ts`'s `Uploader`. The browser adds `Origin` itself.
- Any 401 means logged out: the `loggedOutOn401` interceptor calls `Session.lost()` (the event stream does too). Not on
  the Status page (`app/public/`): it has no session and no interceptor, and a 401 there means the hub has no Status
  page.
- Logins are local Users (`login.ts`: username and password, or an invite's `?invite=` link). What a user may do is
  `Me.permissions`: show an action, tab or page only when `Session.can(permission, serverId?)` says so (the hub's rule:
  held for every server, or on that one; `canAnywhere` for one held on any; `owner()`), and a page that needs one
  behind `allowed(permission)`. Hiding is never the check: the hub refuses anyway, and a 403 makes `refreshOn403` ask
  `/api/me` again, so what was taken away hides; the request's own toast carries the hub's "Needs …".
- The first load stays under its budget (650 kB): the login card uses plain inputs styled as `hlmInput`, whose
  directive brings the form machinery with it.
- A deploy deletes the old build's chunks: a lazy page that fails to load after the first navigation reloads the page (`reload.ts`). The New server sheet's and the Game tab's Browse view's `@defer` say to reload instead; `chart.ts`'s lazy `echarts` import has no such fallback yet.
- Features come from the card (`features.chat`, `features.tps`, `features.console`, `features.update`, `features.settings`): a server without the mod shows
  none of them; a factorio server has all five (`update`, the Game tab, only a factorio server has, while the hub's game updates are on;
  `settings`, the Settings tab, likewise, and a hub before `hub-v2.16.0` leaves it out).
- spartan/ui components are generated into `libs/ui` (`npx ng g @spartan-ng/cli:ui <name>`, config in
  `components.json`), and are ours to edit.

## Local setup

Run a hub with the web integration on port 25581 (the proxy's target) and `"publicUrl": "http://localhost:4200"`,
so the hub's `Origin` check and its invite links match the dev server. Make yourself an owner with `npm run users --
invite me` in `hub/` (against the local hub's `config.json`) and open the link it prints. The session cookie is
`Secure`; browsers accept that on `localhost`.

## Tests

Vitest against a fake backend: `provideHttpClientTesting` + `HttpTestingController` for REST, `fakeEvents()` for the stream,
`loggedIn(me)` (`testing.ts`) for a `Session` already logged in: `OWNER` by default, `VIEWER` with no permission. Minimal component
tests; no end-to-end tests yet. A graph is checked through its `TimeSeries` inputs (`series()`), not the drawn SVG.

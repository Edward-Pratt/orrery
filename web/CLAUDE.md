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
change that breaks the dashboard fails `npm run build`. That module imports only `hub/src/types.ts`, which imports
nothing, so nothing from the hub's runtime or Node types gets compiled here. Don't redeclare API types locally.

## Files

Each file in `src/` starts with a comment that says its job, and each page folder has a `CLAUDE.md` saying what its
pages hold: read those before changing them, and change them with the code. By area:

- The shell and the session: `app/app.ts`, `app/app.routes.ts`, `app/login.ts`, `app/session.ts`, `app/reload.ts`,
  `app/theme.ts`, `app/integrations.ts`, `app/environment.ts`.
- Shared pieces: `app/status.ts`, `app/chart.ts`, `app/feedback.ts`, `app/uploads.ts`, `app/units.ts`,
  `app/events.ts`, `app/attention.ts`, `app/logo.ts` (the mark; `public/favicon.svg` and `favicon.ico` are its copies).
- Pages: `app/audit.ts`, and the folders `app/host/`, `app/library/`, `app/services/` and `app/servers/`.
- Tests: `test-setup.ts`, `app/testing.ts`.

## Rules

- Every POST, PUT and DELETE sends `content-type: application/json`, even with no body (HttpClient adds none for `null`):
  the hub rejects anything else (CSRF). The one exception is an upload's chunk (`PUT /api/uploads/:upload`), raw
  `application/octet-stream`; files go up only through `uploads.ts`'s `Uploader`. The browser adds `Origin` itself.
- Any 401 means logged out: the `loggedOutOn401` interceptor calls `Session.lost()` (the event stream does too).
- A deploy deletes the old build's chunks: a lazy page that fails to load after the first navigation reloads the page (`reload.ts`). The New server sheet's and the Game tab's Browse view's `@defer` say to reload instead; `chart.ts`'s lazy `echarts` import has no such fallback yet.
- Features come from the card (`features.chat`, `features.tps`, `features.console`, `features.update`, `features.settings`): a server without the mod shows
  none of them; a factorio server has all five (`update`, the Game tab, only a factorio server has, while the hub's game updates are on;
  `settings`, the Settings tab, likewise, and a hub before `hub-v2.16.0` leaves it out).
- spartan/ui components are generated into `libs/ui` (`npx ng g @spartan-ng/cli:ui <name>`, config in
  `components.json`), and are ours to edit.

## Local setup

Run a hub with the web integration on port 25581 (the proxy's target) and `"publicUrl": "http://localhost:4200"`,
so the hub's `Origin` check and its post-login redirect match the dev server. Add
`http://localhost:4200/api/callback` as a redirect URL in the Discord app's OAuth2 settings. The session cookie is
`Secure`; browsers accept that on `localhost`.

## Tests

Vitest against a fake backend: `provideHttpClientTesting` + `HttpTestingController` for REST, `fakeEvents()` for the stream. Minimal component
tests; no end-to-end tests yet. A graph is checked through its `TimeSeries` inputs (`series()`), not the drawn SVG.

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

## Rules

- Every POST sends `content-type: application/json`, even with no body (HttpClient adds none for `null`): the hub
  rejects anything else (CSRF). The browser adds `Origin` itself.
- Any 401 means logged out: the `loggedOutOn401` interceptor clears `Session.user`.
- spartan/ui components are generated into `libs/ui` (`npx ng g @spartan-ng/cli:ui <name>`, config in
  `components.json`), and are ours to edit.

## Local setup

Run a hub with the web integration on port 25581 (the proxy's target) and `"publicUrl": "http://localhost:4200"`,
so the hub's `Origin` check and its post-login redirect match the dev server. Add
`http://localhost:4200/api/callback` as a redirect URL in the Discord app's OAuth2 settings. The session cookie is
`Secure`; browsers accept that on `localhost`.

## Tests

Vitest on services against a fake backend (`provideHttpClientTesting` + `HttpTestingController`). Minimal component
tests; no end-to-end tests yet.

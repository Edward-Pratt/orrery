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

| File | Job |
|---|---|
| `src/app/session.ts` | `Session` (who is logged in, logout) and the `loggedOutOn401` interceptor. |
| `src/app/integrations.ts` | `Integrations` (`GET /api/integrations`, asked once) and `enabled(name)`, the `canMatch` guard. |
| `src/app/app.routes.ts` | One lazy route per integration with pages, matched only when it is on (Minecraft: `servers`; `host`; systemd: `services`; `checks`). |
| `src/app/app.ts` | The shell: header, `Nav` (links to the switched-on integrations' pages), login prompt. |
| `src/app/events.ts` | `LiveEvents.all$`: `GET /api/events` as an observable (fetch, not EventSource: a reconnect sends Last-Event-ID and skips ids already seen). Ends on 401. `ofServer(id)` keeps one server's events (not a same-named check's), `ofTarget(target)` the host's, services' or checks'. |
| `src/app/chart.ts` | `TimeSeries`: the one reusable graph, a line per `Series` (`[ms, value]` points), coloured from the theme's tokens. It loads `echarts.ts` (only the parts it uses, SVG renderer) lazily. |
| `src/app/host/` | The host page: CPU, load, memory and disks from its latest sample, replaced by each live `sample` event; graphs of the chosen period (1 h, 24 h, 7 d, 90 d; `GET /api/host/samples?hours=`, averaged by the hub past 25 hours), each live `sample` appended. |
| `src/app/checks/` | The checks page: each check's state, response time and linked service, fetched once, then replaced by each live `checked` result. |
| `src/app/services/` | The services page: each listed unit's state and linked checks (fetched again on a service event), its recent logs on demand; `ServiceActions` (start/stop/restart after `confirm()`, also on a linked server's page). |
| `src/app/servers/` | The Minecraft integration's pages: server cards (live TPS from `tps` events, re-fetched on lifecycle, join/leave and restart notices; nothing polls) and a server page: a shell (`server.ts`: name, state, linked service, links to the sections in `SECTIONS` the server has) over lazy child routes, one per section (`overview.ts`, `chat.ts`; `/servers/<id>/chat` links deep), which `inject(ServerPage)` for the detail. A new section is a child route plus a `SECTIONS` row. |
| `src/test-setup.ts` | Vitest setup: stubs for what jsdom lacks (canvas, `ResizeObserver`), so pages with graphs render in tests. |
| `src/app/testing.ts` | `fakeEvents()`: a fake `/api/events` for the `FETCH` token (each push reaches every open stream). |

## Rules

- Every POST sends `content-type: application/json`, even with no body (HttpClient adds none for `null`): the hub
  rejects anything else (CSRF). The browser adds `Origin` itself.
- Any 401 means logged out: the `loggedOutOn401` interceptor clears `Session.user` (the event stream does too).
- Features come from the card (`features.chat`, `features.tps`): a server without the mod shows neither.
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

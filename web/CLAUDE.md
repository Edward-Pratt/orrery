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
| `src/app/app.ts` | The shell: sidebar (a bottom tab bar and slim header on a phone) with the switched-on integrations' pages (`PAGES`), `UserMenu` (avatar → Theme, Log out); a room for the attention strip goes above `<router-outlet>`. |
| `src/app/login.ts` | The logged-out card; shows the reason the hub gave in `?login=`. |
| `src/app/theme.ts` | `Theme`: light / system / dark, kept in `localStorage` (blocked storage is fine), applied as `dark` on `<html>`. |
| `src/app/status.ts` | `Status`: the shared state display, a coloured dot plus a word (`--status-ok/warn/down` tokens in `styles.css`; teal `--brand`; Figtree). |
| `src/app/events.ts` | `LiveEvents.all$`: `GET /api/events` as an observable (fetch, not EventSource: a reconnect sends Last-Event-ID and skips ids already seen; `cache: 'no-store'`, since the browser's cache lock would hold a second stream to the same URL behind the first forever). Ends on 401. `ofServer(id)` keeps one server's events (not a same-named check's), `ofTarget(target)` the host's, services' or checks'. |
| `src/app/chart.ts` | `TimeSeries`: the one reusable graph, a line per `Series` (`[ms, value]` points; `step` for counts and states), coloured from the theme's tokens. It loads `echarts.ts` (only the parts it uses, SVG renderer) lazily. `PeriodPicker`: the period buttons (`PERIODS`) of every graph page. |
| `src/app/units.ts` | `formatDuration` and `formatBytes`, as Discord's (the hub's `units.ts` isn't importable here). |
| `src/app/audit.ts` | The audit log page (`/audit`, always there): newest first, filtered by `?server=` (the server page links to it). |
| `src/app/host/` | The host page: CPU, load, memory and disks from its latest sample, replaced by each live `sample` event; graphs of the chosen period (1 h, 24 h, 7 d, 90 d; `GET /api/host/samples?hours=`, averaged by the hub past 25 hours), each live `sample` appended. |
| `src/app/checks/` | The checks page: each check's state, response time and linked service, fetched once, then replaced by each live `checked` result. |
| `src/app/services/` | The services page: each listed unit's state and linked checks (fetched again on a service event), its recent logs on demand; `ServiceActions` (start/stop/restart after `confirm()`, also on a linked server's page). |
| `src/app/servers/` | The Minecraft integration's pages: server cards (live TPS from `tps` events, re-fetched on lifecycle, join/leave and restart notices; nothing polls; the name links to the page, and a server with the mod gets `restart.ts`'s controls) and a server page: a shell (`server.ts`: name, state, linked service, links to the sections in `SECTIONS` the server has; its `detail` is fetched again, debounced, on the events that change a card and on backup notices, or on `refresh()`) over lazy child routes, one per section (`overview.ts`, with `restart.ts`'s countdown restarts: schedule, cancel, and the time left, ticking each second; `chat.ts`, `console.ts`: commands, output shown from the stream only; `stats.ts`: top players per period and a player lookup; `backups.ts` (only with a backup folder): the list, total, free space against the minimum, growth, starting one, and restoring one while the linked service is stopped, after typing the server's name; `history.ts`: TPS, player and uptime graphs extended by live events newer than the history's `asOf`; `/servers/<id>/chat` links deep), which `inject(ServerPage)` for the detail. A new section is a child route plus a `SECTIONS` row (whose `has` reads the detail). |
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

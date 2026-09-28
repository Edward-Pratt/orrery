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
| `src/app/integrations.ts` | `Integrations` (`GET /api/integrations`, asked once) and `enabled(...names)`, the `canMatch` guard (any of them on). |
| `src/app/app.routes.ts` | One lazy route per integration with pages, matched only when it is on (Minecraft: `servers`; `host`; systemd or checks: `services`, which holds the checks too; there is no `checks` route). |
| `src/app/app.ts` | The shell: sidebar (a bottom tab bar and slim header on a phone) with the switched-on integrations' pages (`PAGES`), `UserMenu` (avatar → Theme, Log out); the attention strip above `<router-outlet>` and amber count badges on Servers and Services (down checks count there too). With `checks` on and `systemd` off the Services entry reads "Checks". |
| `src/app/login.ts` | The logged-out card; shows the reason the hub gave in `?login=`. |
| `src/app/theme.ts` | `Theme`: light / system / dark, kept in `localStorage` (blocked storage is fine), applied as `dark` on `<html>`. |
| `src/app/status.ts` | `Status`: the shared state display, a coloured dot plus a word (`--status-ok/warn/down` tokens in `styles.css`; teal `--brand`; Figtree). |
| `src/app/events.ts` | `LiveEvents.all$`: `GET /api/events` as an observable (fetch, not EventSource: a reconnect sends Last-Event-ID and skips ids already seen; `cache: 'no-store'`, since the browser's cache lock would hold a second stream to the same URL behind the first forever). Ends on 401. `ofServer(id)` keeps one server's events (not a same-named check's), `ofTarget(target)` the host's, services' or checks'. |
| `src/app/chart.ts` | `TimeSeries`: the one reusable graph, a line per `Series` (`[ms, value]` points; `step` for counts and states), coloured from the theme's tokens. It loads `echarts.ts` (only the parts it uses, SVG renderer) lazily. `PeriodPicker`: the period buttons (`PERIODS`) of every graph page. |
| `src/app/feedback.ts` | `Feedback`: the one place for "are you sure?" (`confirm({title, verb, destructive, typeName})`, a spartan alert dialog whose title names the target and consequence; `typeName` makes the button wait for the exact name, as Restore does) and for toasts (`ok`: brief; `failed`: sticky with the hub's message) for the outcome of this browser's own requests only, never for live events. A button disables with a `hlm-spinner` while its request is in flight; form errors (console, chat, lookup) stay inline. No `window.confirm`. |
| `src/app/units.ts` | `formatDuration` and `formatBytes`, as Discord's (the hub's `units.ts` isn't importable here). |
| `src/app/audit.ts` | The audit log page (`/audit`, always there): a table (cards on a phone), newest first, filtered by `?server=` and `?actor=` (the server page links with the first), "Load older" pages back with `before`, skeletons and an empty state. |
| `src/app/host/` | The host page: stat tiles (CPU, load, memory, a disk each) from its latest sample, replaced by each live `sample` event, with a bar amber/red past a threshold (CPU 80/95% used, memory 85/95%, a disk under 20/10% free; load has none), skeletons while loading; graphs of the chosen period (1 h, 24 h, 7 d, 90 d; `GET /api/host/samples?hours=`, averaged by the hub past 25 hours), each live `sample` appended. |
| `src/app/services/` | The Services page (`services.ts`; titled "Checks", with only standalone checks, when systemd is off): a row per unit (id, unit, state as `Status`) with its checks as chips ("grafana ✓ 42 ms", "api ✗ timeout"; each replaced by its live `checked` result), then a "Standalone checks" section for checks no listed service shows; each source is fetched only with its integration on, services and server cards again on service and card events. Start (primary) when stopped, Restart (outline) when active, ⋯ with Stop and View logs (a `sheet` on the right, full screen on a phone: monospace lines and Refresh). A service that runs a server (found through the server cards) shows "runs Creative →" and the server's own `ServerActions` (`full`) instead, so the two views never disagree. `actions.ts`: `ServiceControl` (one start/stop/restart request at a time; Stop and Restart ask through `Feedback.confirm`; used by the page, `ServerActions` and the attention strip). |
| `src/app/attention.ts` | `Attention`: what needs a human now (#60's rules), built from the server cards, services and checks it fetches once logged in (each only with its integration on) and keeps current from the live stream; items can't be dismissed, they leave when the condition clears. `AttentionStrip`: one amber line per item with its fix (Start/Restart through `ServiceControl`, Cancel a restart), and a line while a backup or restore started here runs (`BackupProgress`). `count(page)` feeds the sidebar badges. |
| `src/app/servers/` | The Minecraft integration's pages: one row per server (`cards.ts`, skeletons while loading; `row.ts`: state dot and word, amber while `lagging`, TPS, player count, 24 h uptime, and the actions its state allows: Restart (5-minute countdown, no dialog) and Console with a ⋯ menu of Stop and Restart now online, Start offline, the countdown and Cancel while a restart is pending; a linked server's Start and Stop go through `ServiceControl`; tapping the row outside its buttons opens the page; live TPS from `tps` events, cards re-fetched on lifecycle, join/leave, restart and lag notices and on a linked service's `state` events; nothing polls) and a server page: a shell (`server.ts`: header with name, state, the linked service's line and `actions.ts`'s `ServerActions` (also the row's; `full` adds "Restart in…" and "Audit log for this server" to its ⋯ menu), then tabs from `SECTIONS` the server has; its `detail` is fetched again, debounced, on the events that change a card and on backup notices, or on `refresh()`) over lazy child routes, one per section (`overview.ts`: who's online, 24 h TPS and players sparklines linking to History, a pending restart with Cancel; `chat.ts` and `console.ts` (full-height logs that stick to the bottom, `log.ts`'s `StickBottom`; console output is shown from the stream only); `players.ts` (`/stats` redirects): the lookup as a card, top players per period as tables (side by side, or a Day / Week / All toggle-group on a phone); `player.ts`: `PlayerCard`, and `PlayerCards`/`appPlayer` that open any player name's card in a dialog; `backups.ts` (only with a backup folder): four stat tiles (Free amber under the minimum), Start backup (no dialog), the list with a ⋯ Restore per row (typed-name confirm, disabled with a reason unless the linked service is stopped); `backup-progress.ts`: `BackupProgress`, what is backing up or restoring (ends on the live feed's finished/failed notice or the restore's answer; only ones started from this browser), shown in the tab and the attention strip, no reply text; `history.ts`: TPS, player and uptime graphs extended by live events newer than the history's `asOf`; `/servers/<id>/chat` links deep), which `inject(ServerPage)` for the detail. A new section is a child route plus a `SECTIONS` row (whose `has` reads the detail). |
| `src/test-setup.ts` | Vitest setup: stubs for what jsdom lacks (canvas, `ResizeObserver`), so pages with graphs render in tests. |
| `src/app/testing.ts` | `fakeEvents()`: a fake `/api/events` for the `FETCH` token (each push reaches every open stream); `dialog()`, `dialogButton()` and `toasts()` read the confirmation and toasts, which live outside the component under test. |

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

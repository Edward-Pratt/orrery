# hub (orrery-hub)

Node 24+ (tested on 24.21 and 26.9) + TypeScript + discord.js 14. Node runs `.ts` directly (type stripping) — there is no build step.

```bash
npm test            # node --test "test/*.test.ts"
npm run typecheck   # tsc, noEmit
npm run check-config   # validates ./config.json (or -- <path>) offline; same rules as startup
npm start           # node src/index.ts; reads ./config.json (or argv[2]), env DISCORD_TOKEN (only with integrations.discord)
                    # and DISCORD_CLIENT_SECRET (only with integrations.web)
```

## TypeScript constraints (type stripping)

- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Relative imports include the `.ts` extension; type-only imports use `import type` / `type X`.

## Modules

| File | Job |
|---|---|
| `src/protocol.ts` | Wire types + `parseModLine` validation. The contract with the mod. |
| `src/servers.ts` | `ServerHub`: TCP server, per-server state, liveness (crash/stop/hung), `say`, `runCommand`, `audit` (entries go to the `HubOptions.audit` sink: the database), `event` emitter (game, lifecycle and hub-core `notice` events, plus `say` for chat sent in game and `console` for command output, late output included), `publish` (hub-core modules put typed notices — kind, severity, details — on it). The API frontends use. |
| `src/config.ts` | Config shape: `dbPath`, `healthcheckUrl`, `servers[]`, and `integrations.minecraft` (port, tokens) / `integrations.discord` (guild, admin role, channels) keyed by server id, `integrations.web` (port, public URL, OAuth client id, guild and admin role — each defaulting to `discord`'s — session days). `validateConfig` (every error at once, offline; the pre-2.0 shape gets a list of keys to move) and `loadConfig`, which returns `ServerSettings` per server with every default applied (lag 15 TPS/2 min, quests `batched`, 10 GB free, 7-day web sessions, web's guild and admin role from `discord`) and the Backup folder derived (`backupDir`, else `<dir>/backups`). The only place per-server defaults live. Used by startup and `check-config`. Hub core. |
| `src/check-config.ts` | `npm run check-config` entry point. |
| `src/db.ts` | SQLite (`node:sqlite`): up/down/unknown log (`recordLifecycle` maps hub lifecycle events to up/down) and uptime math; player sessions, daily peaks and stats queries; dashboard login sessions (stored hashed); the audit log (`audit`, `auditLog`: newest first, all servers or one; never pruned); `maintain` (nightly: prune TPS > 90 days and expired sessions, 7 dated copies). Writes never throw. |
| `src/daily.ts` | `everyDay(time, leadMs, fn(target))`: DST-safe daily timers (used by restarts and the summary). Hub core. |
| `src/units.ts` | `formatDuration`, `formatBytes`, `localDay` (local calendar, not UTC). Hub core. |
| `src/playtime.ts` | `PlaytimeTracker`: syncs sessions with each server's live player list every 10 s. Hub core. |
| `src/stats.ts` | `Stats`: frontends' read questions as plain data (`status`, `tps`, `playtime`, `top`, `backups` with growth, `crashLogs`, `summary`, `linkedPlayer`, `audit`), owning the time windows, `/top` periods and each server's folders. Hub core. |
| `src/summary.ts` | `Summary` type, `yesterday` (the local day before the summary's scheduled time; `Stats.summary` builds it) and `scheduleSummaries` (announces each server's summary at its `dailySummary` time). Hub core. |
| `src/backups.ts` | `listBackups`, `freeBytes`, `growthPerDay`, `backupStats`, `BackupWatcher` (missing-backup and low-disk watchdog; turns the mod's backup events into finished/failed notices). Hub core. |
| `src/health.ts` | `startPinger`: the `healthcheckUrl` liveness ping, sent every minute from the hub's own timer (so it stops when the hub dies or hangs), whatever Discord is doing. Hub core. |
| `src/lag.ts` | `LagMonitor`: 1/min TPS samples into the `tps` table, lag and recovery notices; `sparkline`. Hub core. |
| `src/quests.ts` | `QuestAnnouncer`: main quests at once, others per mode (`batched` rolls up every 10 min); announces `questBatch` events. Hub core. |
| `src/links.ts` | `Links`: link codes (6 chars, 10 min, guess cap), answers the mod's `link`/`unlink`, announces `linked` events. Hub core. |
| `src/restarts.ts` | `RestartScheduler`: countdown restarts (in-game `say` warnings, then `stop`) and daily restarts; its notices are `publish`ed hub events; scheduling and cancelling are audited, the daily restart as `hub:daily`. Hub core. |
| `src/crashlogs.ts` | `findCrashLogs`: newest crash report / `hs_err_pid*.log` in a server folder. Hub core. |
| `src/live.ts` | `LiveFeed`: numbers every hub event (ids start at the clock, so they keep rising across hub restarts), re-emits it, and keeps the last 500 per server in memory for replay (`since(lastId)`). Hub core. |
| `src/api.ts` | The HTTP API's request/response types, one per endpoint (`Integrations`, `ServerCard`, `ServerDetail`, `AuditLog`, `LiveEvent`, …), for the dashboard to import type-only. Type-only: imports nothing at runtime; `web.ts` checks each payload against it with `satisfies`. |
| `src/format.ts` | Pure Discord output: `Post` = plain text or embeds; `md`, `format*`, `topicDue`. Unit-tested. |
| `src/discord.ts` | Discord frontend: webhook chat, alerts (+ crash-log uploads), presence, topics, notices as embeds, `/status` `/list` `/tps` `/playtime` `/top` `/link` `/unlink` `/cmd` `/restart` `/backup`; late `/cmd` output as follow-ups. |
| `src/web.ts` | Web integration: the Hono HTTP API under `/api` (`webApi`), Discord OAuth login for admin-role members (`OAuth`, real `discordOAuth`), sessions in SQLite, `GET /api/me`, `POST /api/logout`, reads (`/api/integrations`; `/api/servers` cards; `/api/servers/:id` status, TPS, top per period, backups; `/api/servers/:id/players/:name`, 404 if never seen; `/api/audit[?server=]`, newest 200; unknown server ids 404; chat/TPS/quest features, and TPS, only for a server with a mod token), `GET /api/events` (SSE: `LiveFeed`'s buffer after `Last-Event-ID`, then live events; keep-alive comments); every other route needs a session. `serveWebApi` serves it on 127.0.0.1. |
| `src/start.ts` | `startHub(config, { startFrontend, get, oauth })`: wires and starts a whole hub, switching on each integration whose config section is present (Minecraft: `listen`; Discord: `startFrontend`; web: the HTTP API, with the injected `oauth`); its handle has the `LiveFeed`, and its `close` stops everything in order (open event streams included). The seam for whole-hub tests. |
| `src/index.ts` | Entry point: reads config and env, starts the hub with the real Discord frontend, HTTP get and Discord OAuth, wires signals. |

The web API (`src/web.ts`, for the separate dashboard app) calls `ServerHub`, `RestartScheduler`, `Stats` (the audit log too) and `LiveFeed` (and `Db` only for its own sessions) — never the mod sockets.
Hub-core modules (`servers`, `restarts`, `stats`, `crashlogs`, `db`) must not import `discord.js` or `format.ts`.
New hub-core output should be a typed `Notice` on the event stream (`ServerHub.publish`), worded and coloured in
`format.ts` — not a text callback. Quest batches, new links and the daily summary go on it too (`ServerHub.announce`).

## Dependencies

Runtime: `discord.js`, and `hono` with its Node adapter `@hono/node-server` (web integration). Prefer Node built-ins (`node:net`, `node:readline`, `node:sqlite`,
`node:test`, `node:crypto`) over adding packages.

## Trust boundaries (do not weaken)

- Mod input: every line goes through `parseModLine` (checks `Object.hasOwn` on the type and field types).
  Tokens ≥16 chars, compared with `timingSafeEqual`. Hub binds `127.0.0.1`.
- Discord → MC: `ServerHub.say` cleans text with `mcText` (strips `§` codes/control chars, caps 256).
- MC → Discord: `md()` escapes markdown incl. headings/masked links; the Client uses
  `allowedMentions: { parse: [] }` so nothing the bot posts can ping.
- `/cmd`: admin role check + `deferReply`. Every action on a server (commands via `runCommand`, restarts scheduled
  or cancelled) goes to the `audit` table with its actor: `discord:<username> (<id>)`, or `hub:<why>`
  (`hub:daily`, `hub:restart`) for the hub's own. Web actions will use `web:<username> (<id>)`.
- Web: binds `127.0.0.1` (Caddy adds TLS in front). Login is Discord OAuth with a single-use `state` cookie; only
  members with the admin role get a session. Session ids are random, sent only in an httpOnly, Secure, SameSite=Lax
  cookie, stored hashed, and expire server-side. Every `/api` route but login/callback needs one. The OAuth client
  secret comes from `DISCORD_CLIENT_SECRET`, never config.

## Tests

`test/servers.test.ts` drives a real socket with a fake mod (`fakeMod`, `online`, `until` helpers in `test/fake-mod.ts`) — use it
for any hub behaviour change. `test/start.test.ts` starts a whole hub via `startHub` with a stub frontend and a fake Discord OAuth, driving the web API through `app.request` (no port). Keep timing-sensitive tests on small `HubOptions` timeouts, not sleeps of seconds.

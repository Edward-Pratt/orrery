# hub

Node 24+ (tested on 24.21 and 26.9) + TypeScript + discord.js 14. Node runs `.ts` directly (type stripping) — there is no build step.

```bash
npm test            # node --test "test/*.test.ts"
npm run typecheck   # tsc, noEmit
npm run check-config   # validates ./config.json (or -- <path>) offline; same rules as startup
npm start           # node src/index.ts; reads ./config.json (or argv[2]) and env DISCORD_TOKEN
```

## TypeScript constraints (type stripping)

- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Relative imports include the `.ts` extension; type-only imports use `import type` / `type X`.

## Modules

| File | Job |
|---|---|
| `src/protocol.ts` | Wire types + `parseModLine` validation. The contract with the mod. |
| `src/servers.ts` | `ServerHub`: TCP server, per-server state, liveness (crash/stop/hung), `say`, `runCommand`, `event` emitter (game, lifecycle and hub-core `notice` events), `publish` (hub-core modules put typed notices — kind, severity, details — on it). The API frontends use. |
| `src/config.ts` | `validateConfig` (every error at once, offline) and `loadConfig`, which returns `ServerSettings` per server with every default applied (lag 15 TPS/2 min, quests `batched`, 10 GB free) and the Backup folder derived (`backupDir`, else `<dir>/backups`). The only place per-server defaults live. Used by startup and `check-config`. Hub core. |
| `src/check-config.ts` | `npm run check-config` entry point. |
| `src/db.ts` | SQLite (`node:sqlite`): up/down/unknown log (`recordLifecycle` maps hub lifecycle events to up/down) and uptime math; player sessions, daily peaks and stats queries; `maintain` (nightly: prune TPS > 90 days, 7 dated copies). Writes never throw. |
| `src/daily.ts` | `everyDay(time, leadMs, fn(target))`: DST-safe daily timers (used by restarts and the summary). Hub core. |
| `src/units.ts` | `formatDuration`, `formatBytes`, `localDay` (local calendar, not UTC). Hub core. |
| `src/playtime.ts` | `PlaytimeTracker`: syncs sessions with each server's live player list every 10 s. Hub core. |
| `src/stats.ts` | `Stats`: frontends' read questions as plain data (`status`, `tps`), owning the time windows. Hub core. |
| `src/summary.ts` | `buildSummary`: yesterday's stats, from the scheduled time. Hub core. |
| `src/backups.ts` | `listBackups`, `freeBytes`, `growthPerDay`, `backupStats`, `BackupWatcher` (missing-backup and low-disk watchdog; turns the mod's backup events into finished/failed notices). Hub core. |
| `src/health.ts` | `startPinger`: the `healthcheckUrl` liveness ping, sent only while Discord is connected. Hub core. |
| `src/lag.ts` | `LagMonitor`: 1/min TPS samples into the `tps` table, lag and recovery notices; `sparkline`. Hub core. |
| `src/quests.ts` | `QuestAnnouncer`: main quests at once, others per mode (`batched` rolls up every 10 min); announces `questBatch` events. Hub core. |
| `src/links.ts` | `Links`: link codes (6 chars, 10 min, guess cap), answers the mod's `link`/`unlink`, announces `linked` events. Hub core. |
| `src/restarts.ts` | `RestartScheduler`: countdown restarts (in-game `say` warnings, then `stop`) and daily restarts; its notices are `publish`ed hub events. Hub core. |
| `src/crashlogs.ts` | `findCrashLogs`: newest crash report / `hs_err_pid*.log` in a server folder. Hub core. |
| `src/format.ts` | Pure Discord output: `Post` = plain text or embeds; `md`, `format*`, `topicDue`. Unit-tested. |
| `src/discord.ts` | Discord frontend: webhook chat, alerts (+ crash-log uploads), presence, topics, notices as embeds, `/status` `/list` `/tps` `/playtime` `/top` `/link` `/unlink` `/cmd` `/restart` `/backup`; late `/cmd` output as follow-ups. |
| `src/index.ts` | Wiring only (config via `config.ts`). |

A future web dashboard goes in `src/web/` and calls `ServerHub`, `RestartScheduler` and `Stats` — never the mod sockets.
Hub-core modules (`servers`, `restarts`, `stats`, `crashlogs`, `db`) must not import `discord.js` or `format.ts`.
New hub-core output should be a typed `Notice` on the event stream (`ServerHub.publish`), worded and coloured in
`format.ts` — not a text callback. Quest batches and new links go on it too (`ServerHub.announce`). (The daily summary still uses a callback: #15.)

## Dependencies

Runtime: `discord.js` only. Prefer Node built-ins (`node:net`, `node:readline`, `node:sqlite`,
`node:test`, `node:crypto`) over adding packages.

## Trust boundaries (do not weaken)

- Mod input: every line goes through `parseModLine` (checks `Object.hasOwn` on the type and field types).
  Tokens ≥16 chars, compared with `timingSafeEqual`. Hub binds `127.0.0.1`.
- Discord → MC: `ServerHub.say` cleans text with `mcText` (strips `§` codes/control chars, caps 256).
- MC → Discord: `md()` escapes markdown incl. headings/masked links; the Client uses
  `allowedMentions: { parse: [] }` so nothing the bot posts can ping.
- `/cmd`: admin role check + `deferReply`; `runCommand` logs who ran it.

## Tests

`test/servers.test.ts` drives a real socket with a fake mod (`fakeMod`, `online`, `until` helpers) — use it
for any hub behaviour change. Keep timing-sensitive tests on small `HubOptions` timeouts, not sleeps of seconds.

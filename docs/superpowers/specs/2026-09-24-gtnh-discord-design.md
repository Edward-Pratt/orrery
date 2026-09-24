# GTNH Discord — Design

Date: 2026-09-24 · Status: approved in chat, pending spec review

## Goal

Interact with one or more GT: New Horizons (MC 1.7.10) servers from Discord:
two-way chat relay, remote console commands, status/player list, and
start/stop/crash alerts. Built so a web dashboard (including server
management) can be added later without reworking the core.

## Architecture

```
[GTNH server A] ─mod─┐
[GTNH server B] ─mod─┼─ TCP 127.0.0.1:25580, newline-delimited JSON ─> [hub (Node/TypeScript)]
                     ┘                                                    ├─ Discord frontend (discord.js)
                                                                          ├─ SQLite uptime log (node:sqlite)
                                                                          └─ (later) HTTP API + web dashboard
```

- **Hub is the brain.** It owns server connections, state, and history.
  Frontends (Discord now, web later) only talk to the hub, never to mods.
- **Mod is a thin adapter.** It forwards game events and executes what the hub
  asks. No Discord knowledge, no business logic.
- **Mods connect out to the hub.** Adding a server = install mod + add a
  config entry. The hub learns liveness from the connection itself.
- Monorepo: `mod/` (Forge mod), `hub/` (Node app), `docs/`.
- v1 runs everything on one machine; the hub listens on `127.0.0.1` only.

## Protocol (v1)

Transport: TCP, UTF-8, one JSON object per line (`\n`-terminated). Every
message has a `type`. The hub closes the connection on malformed JSON or an
unknown `type` before handshake.

### Handshake

First message from mod:

```json
{"type":"hello","protocol":1,"serverId":"gtnh","token":"<shared secret>","modVersion":"1.0.0"}
```

Hub replies `{"type":"welcome"}` or `{"type":"reject","reason":"..."}` then
closes. Token is per server (from hub config). A second connection for an
already-connected `serverId` replaces the old one.

### Mod → hub

| type | fields | when |
|---|---|---|
| `started` | — | `FMLServerStartedEvent` only (sent once the connection is up) |
| `stopping` | — | `FMLServerStoppingEvent` |
| `heartbeat` | `tps`, `players` (string[]) | every 5 s |
| `chat` | `player`, `message` | `ServerChatEvent` |
| `join` / `leave` | `player` | FML `PlayerLoggedIn/OutEvent` |
| `death` | `player`, `message` (vanilla death text) | `LivingDeathEvent` for players |
| `achievement` | `player`, `achievement` | `AchievementEvent` (only first unlock) |
| `cmdResult` | `id`, `output` (string[]) | after a `cmd` runs |

### Hub → mod

| type | fields | effect |
|---|---|---|
| `say` | `author`, `message` | broadcast `[Discord] <author> message` in MC chat |
| `cmd` | `id`, `command` | run as console-level sender, reply with `cmdResult` |

Status is served from the latest `heartbeat`; no request/response needed.

### Liveness and uptime

| Hub observes | Meaning | Discord alert |
|---|---|---|
| `hello` accepted | online (no alert — may be a reconnect after hub restart) | — |
| `started` | server finished starting | "✅ Server started" |
| `stopping` then disconnect | clean stop | "🛑 Server stopped" |
| disconnect without `stopping` | crash / killed | "💥 Server went down unexpectedly" |
| socket open, no heartbeat for 30 s | hung | "⚠️ Server not responding"; next heartbeat posts "Server responding again" |

Each state transition is written to SQLite (`events(server_id, ts, kind)`),
from which uptime is computed. Time the hub itself was down counts as
unknown, not downtime.

## Mod (`mod/`)

- Created from the GTNewHorizons ExampleMod1.7.10 starter ZIP (not a clone).
  RetroFuturaGradle, Gradle 9.3.1, JDK 25 builds; `enableModernJavaSyntax =
  jabel` so the jar still runs on Java 8 servers.
- Server-side only: `@Mod(acceptableRemoteVersions = "*")`.
- No new dependencies: `java.net.Socket` + Gson (bundled with MC 1.7.10).
- **Connection thread**: daemon thread, connect → hello → read loop;
  reconnect with backoff (1 s doubling to 30 s). Outbound queue bounded
  (1000 messages, drop oldest) so a dead hub never grows server memory.
- **Thread safety**: incoming `say`/`cmd` go onto a `ConcurrentLinkedQueue`,
  drained on `TickEvent.ServerTickEvent` (main thread). 1.7.10 has no
  scheduled-task API.
- **Command output**: a custom `ICommandSender` (op-level) collects
  `addChatMessage` lines. Known limitation: commands that log instead of
  replying to the sender produce no captured output.
- **TPS**: from `MinecraftServer.tickTimeArray` (mean tick ms → min(20, 1000/ms)).
- **Config** (Forge config, `config/gtnhdiscord.cfg`): `hubHost`
  (default `127.0.0.1`), `hubPort` (25580), `serverId`, `token`.

## Hub (`hub/`)

- Node 26, TypeScript, discord.js v14. Built-ins where possible:
  `node:net` (socket server), `node:sqlite` (uptime), `node:events`.
- Modules, each with one job:
  - `protocol.ts` — message types (the contract; future dashboard reuses them).
  - `servers.ts` — TCP server + registry of connected servers. Public API:
    `list()`, `get(id)`, `say(id, author, msg)`, `runCommand(id, cmd): Promise<string[]>`
    (10 s timeout), and an `EventEmitter` for game/lifecycle events.
    **This API is what the web dashboard will call later.**
  - `db.ts` — SQLite event log + uptime query.
  - `discord.ts` — Discord frontend: subscribes to `servers` events, relays
    chat, registers slash commands.
  - `index.ts` — load config, wire modules together.
- **Config**: `hub/config.json` (git-ignored; `config.example.json` committed):
  `listenPort`, `guildId`, `adminRoleId`, and `servers: [{id, token, channelId, name}]`.
  Discord bot token from env `DISCORD_TOKEN`.
- **Slash commands** (guild-scoped, act on the server mapped to the channel):
  - `/status` — online/offline, TPS, player count, uptime (24 h / 7 d).
  - `/list` — online players.
  - `/cmd <command>` — admin role only; replies with captured output
    (truncated to Discord's 2000-char limit).
- **Relay rules (trust boundaries)**:
  - MC → Discord: `allowedMentions: { parse: [] }` so game chat can't ping
    `@everyone`/roles/users.
  - Discord → MC: strip `§` formatting codes; ignore bots; ignore empty
    messages; attachments sent as their URL.
  - Requires the **Message Content** privileged intent (Developer Portal +
    `GatewayIntentBits.MessageContent`). Documented in README setup.
  - Busy chat is rate-limited by Discord; discord.js queues. Known ceiling;
    batching/webhooks later if needed.

## Error handling

- Mod never throws into the game loop: event handlers only enqueue; socket
  errors are caught in the connection thread and trigger reconnect.
- Hub: a bad message from one mod closes that connection only; Discord
  errors are logged, never crash the TCP server.
- `/cmd` on an offline server or after timeout replies with a clear error.

## Testing

- Hub: `node:test` suite that starts the TCP server on a random port, speaks
  the protocol as a fake mod, and asserts: handshake accept/reject, event
  emission, `runCommand` round-trip and timeout, crash vs clean-stop vs hung
  detection.
- Mod: `./gradlew build` must pass; manual smoke test on a real GTNH server
  (chat both ways, `/cmd list`, stop/start alerts).

## Out of scope for v1 (planned later)

- Web dashboard + HTTP API (hub gains routes that call `servers.ts`).
- Server process management (start/stop/restart, auto-restart on crash).
- TLS / non-localhost hubs (needed once servers run on other machines).
- Account linking, webhooks-per-player avatars, message batching.

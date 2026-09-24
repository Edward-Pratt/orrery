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


## Repository layout

Two independent projects in one repo. Each has its own toolchain and is
built and tested from its own directory; nothing at the root builds anything.

```
gtnh-discord/
├── README.md                 # what it is + setup (Discord app, intents, configs, running)
├── .gitignore                # root ignores for both projects
├── docs/superpowers/         # specs/ and plans/
├── mod/                      # Forge 1.7.10 mod — a self-contained Gradle project
│   ├── build.gradle.kts, settings.gradle.kts, gradle.properties,
│   │   dependencies.gradle, repositories.gradle, gradlew, gradle/, gtnhShared/
│   └── src/
│       ├── main/java/io/github/edwardpratt/gtnhdiscord/
│       │   ├── GtnhDiscord.java   # @Mod entry: config + lifecycle
│       │   ├── HubClient.java     # socket thread, reconnect, outbox/inbox (no MC classes)
│       │   └── GameEvents.java    # Forge/FML event handlers, tick drain, heartbeat, /cmd runner
│       ├── main/resources/mcmod.info
│       └── test/java/io/github/edwardpratt/gtnhdiscord/HubClientTest.java
└── hub/                      # Node/TypeScript app — a self-contained npm project
    ├── package.json, package-lock.json, tsconfig.json, config.example.json
    ├── src/
    │   ├── protocol.ts       # wire types + validation (the contract)
    │   ├── servers.ts        # ServerHub: TCP server, registry, public API
    │   ├── db.ts             # SQLite event log + uptime
    │   ├── discord.ts        # Discord frontend
    │   └── index.ts          # config + wiring
    └── test/*.test.ts
```

- The template's `.github/`, `jitpack.yml`, `CODEOWNERS`, template README and
  LICENSE files are dropped: CI for a subdirectory project would have to live
  in a root `.github/` anyway (added later if wanted).
- The web dashboard later lands as `hub/src/web/` (HTTP routes calling
  `ServerHub`) plus a frontend directory; nothing in v1 needs to move.

## Protocol (v1)

Transport: TCP, UTF-8, one JSON object per line (`\n`-terminated). Every
message has a string `type`; every field is type-checked by the receiver.
Before the handshake the hub closes the connection on anything but a valid
`hello`, and on no `hello` within 5 s. After the handshake, malformed lines
and unknown types are logged and ignored (forward compatible).

### Handshake

First message from mod:

```json
{"type":"hello","protocol":1,"serverId":"gtnh","token":"<shared secret>","modVersion":"1.0.0"}
```

Hub replies `{"type":"welcome"}` or `{"type":"reject","reason":"..."}` then
closes. Tokens are per server (hub config), at least 16 characters, compared
in constant time. A second connection for an already-connected `serverId`
replaces the old one; the old connection's close is then ignored (no alert).

### Mod → hub

| type | fields | when |
|---|---|---|
| `started` | — | `FMLServerStartedEvent` |
| `stopping` | — | `FMLServerStoppingEvent` (only fires on a normal stop — verified in FML's `MinecraftServer` patch: a crash skips it) |
| `heartbeat` | `tps` (number), `players` (string[]) | from the server tick, ≥5 s wall-clock apart |
| `chat` | `player`, `message` | `ServerChatEvent` |
| `join` / `leave` | `player` | FML `PlayerLoggedIn/OutEvent` |
| `death` | `player`, `message` (vanilla death text) | `LivingDeathEvent` for players |
| `achievement` | `player`, `achievement` | `AchievementEvent`, first real unlock only |
| `cmdResult` | `id`, `output` (string[]) | after a `cmd` runs |

While disconnected the mod drops everything except `started`/`stopping`, so
a hub outage never replays stale chat into Discord.

### Hub → mod

| type | fields | effect |
|---|---|---|
| `say` | `author`, `message` | broadcast `[Discord] <author> message` in MC chat |
| `cmd` | `id`, `command` | run as console-level sender, reply with `cmdResult` |

Status is served from the latest `heartbeat`; no request/response needed.
A `cmdResult` with an unknown or late `id` is ignored.

### Liveness and uptime

| Hub observes | Meaning | Discord alert |
|---|---|---|
| `hello` accepted | online (no alert — may be a reconnect after hub restart) | — |
| `started` | server finished starting | "✅ Server started" |
| `stopping` then disconnect | clean stop | "🛑 Server stopped" |
| disconnect without `stopping` | crash / killed | "💥 Server went down unexpectedly" |
| no heartbeat for 30 s, after at least one heartbeat on this connection and before `stopping` | hung | "⚠️ Server not responding"; next heartbeat posts "✅ Server responding again" |

Hung detection is armed by the first heartbeat (not by `started`) so it also
works after a hub restart, and it stays quiet through GTNH's multi-minute
world load (no ticks yet) and shutdown save (after `stopping`).

State transitions go to SQLite as `events(server_id, ts, state, reason)`
with `state` ∈ `up` / `down` / `unknown`. Uptime = up time ÷ known time over
the window. Hub downtime counts as `unknown`: the hub stamps a `last_alive`
time every minute, and on startup writes `unknown` rows at that time and at
now (accurate to ~1 minute even if the hub crashed).

## Mod (`mod/`)

- Created from the GTNewHorizons ExampleMod1.7.10 starter ZIP (not a clone).
  RetroFuturaGradle, Gradle 9.3.1, **JDK 25** (full JDK, not just the JRE)
  builds; `enableModernJavaSyntax = jabel` so the jar runs on Java 8+.
  Jabel is syntax-only: no Java 9+ APIs (`List.of`, `isBlank`, …). The
  bundled Gson is 2.2.4: `new JsonParser().parse(...)`, `JsonArray.add(JsonElement)`.
- Server-side only: `@Mod(acceptableRemoteVersions = "*")`; does nothing
  unless `MinecraftServer.isDedicatedServer()`.
- No new dependencies: `java.net.Socket` + Gson.
- **Lifecycle**: client starts at `FMLServerStartingEvent`. At
  `FMLServerStoppingEvent` it queues `stopping`, then `stop()` flushes the
  outbox (up to 2 s) and closes — so the clean-stop message can't be lost to
  JVM exit. `FMLServerStoppedEvent` also calls `stop()` (idempotent) so a
  crashed-then-hanging JVM still reports the crash immediately.
- **HubClient** (no Minecraft classes, unit-testable): daemon thread,
  connect → hello → welcome, then a reader thread fills the inbox while the
  connection thread writes the outbox. Reconnect with backoff 1 s → 30 s; a
  `reject` logs the reason and waits 30 s. Outbox bounded at 1000 lines,
  drop-oldest.
- **Event buses** (a handler on the wrong bus silently never fires):
  - `MinecraftForge.EVENT_BUS`: `ServerChatEvent`, `LivingDeathEvent`,
    `AchievementEvent` — `@SubscribeEvent(priority = LOWEST)`, canceled events
    not received, so muted chat / prevented deaths aren't relayed.
  - `FMLCommonHandler.instance().bus()`: `PlayerLoggedIn/OutEvent`, `TickEvent.ServerTickEvent`.
  - `@Mod.EventHandler`: `FMLServerStarting/Started/Stopping/StoppedEvent`.
- **Main thread**: inbound `say`/`cmd` are drained in `ServerTickEvent`
  (phase END), which also emits the heartbeat (≥5 s wall-clock apart,
  never tick-counted). Every handler catches its own exceptions; nothing
  throws into the game loop.
- **Death text**: `player.func_110142_aN().func_151521_b()` (combat tracker's
  death message — the tracker is still populated when the event fires).
- **Achievement filter**: skip if the player's `func_147099_x()` stats file
  `hasAchievementUnlocked` it or `!canUnlockAchievement` it (event fires on
  every trigger).
- **Chat broadcast**: `getConfigurationManager().sendChatMsg(new ChatComponentText(...))`.
- **Commands**: run through `getCommandManager().executeCommand` with an
  anonymous `RConConsoleSource` subclass (vanilla op-level console sender
  with a real world and coordinates) whose `addChatMessage` collects lines
  and whose name is `Discord`. Known limitation: commands that log instead
  of replying to the sender produce no captured output.
- **TPS**: `tickTimeArray` is nanoseconds: mean / 1e6 = ms per tick;
  TPS = min(20, 1000 / ms).
- **Config** (`config/gtnhdiscord.cfg`): `hubHost` (default `127.0.0.1`),
  `hubPort` (25580), `serverId`, `token`. Empty token = bridge disabled with
  a log warning.

## Hub (`hub/`)

- Node 26, TypeScript run directly by Node (type stripping — no build step;
  `tsc` only typechecks), discord.js v14. Built-ins: `node:net`,
  `node:readline`, `node:sqlite`, `node:events`, `node:test`.
- `ServerHub` (`servers.ts`) owns every configured server's state, whether
  connected or not. Public API — what Discord uses now and the dashboard
  later:
  - `list(): ServerState[]`, `get(id): ServerState | undefined`
  - `say(id, author, message): boolean`
  - `runCommand(id, command, by): Promise<string[]>` — logs `by` (audit
    trail), 10 s timeout, rejects immediately if the connection drops.
  - `on('event', (e: HubEvent) => …)` — every event carries `serverId`.
- Discord-only settings (`channelId`, `guildId`, `adminRoleId`) live in
  `discord.ts`; the hub core never sees Discord concepts.
- **Config**: `hub/config.json` (git-ignored; `config.example.json` committed):
  `listenPort`, `dbPath`, `guildId`, `adminRoleId`,
  `servers: [{id, name, token, channelId}]`. Bot token from env `DISCORD_TOKEN`.
- **Slash commands** (guild-scoped, act on the server mapped to the channel):
  - `/status` — online/offline/not responding, TPS, player count, uptime (24 h / 7 d).
  - `/list` — online players.
  - `/cmd <command>` — admin role only; `deferReply()` then `editReply` with
    the output in a code block (`§` codes stripped, truncated to fit 2000 chars).
- **Relay rules (trust boundaries)**:
  - The Client is created with `allowedMentions: { parse: [] }` so nothing
    the bot posts (chat, death text, command output) can ping anyone.
  - MC → Discord: player names and message text go through `escapeMarkdown`
    (no masked links, headings, or broken formatting).
  - Discord → MC: use `message.cleanContent` (mentions shown as names);
    strip `§` and control characters and collapse newlines in both author
    and message; cap at 256 chars; attachments appended as URLs; ignore bots,
    webhooks, and empty results.
  - Requires the **Message Content** privileged intent (Developer Portal +
    `GatewayIntentBits.MessageContent`). Documented in README setup.
  - Busy chat is rate-limited by Discord; discord.js queues. Known ceiling;
    batching/webhooks later if needed.

## Error handling

- Mod never throws into the game loop (see Main thread above); socket
  errors are caught in the connection thread and trigger reconnect.
- Hub: a bad connection affects only itself; Discord API errors are logged,
  never crash the TCP server.
- `/cmd` on an offline server, on disconnect, or after timeout replies with a clear error.

## Testing

- Hub: `node:test` suites — protocol validation; `ServerHub` over a real
  socket on a random port with a fake mod (handshake accept/reject/timeout,
  event emission, `runCommand` round-trip/timeout/disconnect, crash vs
  clean stop, hung arming rules, connection replacement); uptime math;
  Discord text formatting/sanitizing (pure functions).
- Mod: JUnit `HubClientTest` against a fake hub `ServerSocket` (handshake,
  send/receive, reconnect, drop-oldest, disconnected dropping). `./gradlew
  build` must pass. Manual smoke test on a real GTNH server: chat both ways,
  `/cmd list`, stop → "stopped", `kill -9` → "went down unexpectedly".

## Out of scope for v1 (planned later)

- Web dashboard + HTTP API (`hub/src/web/`, calling `ServerHub`).
- Server process management (start/stop/restart, auto-restart on crash).
- TLS / non-localhost hubs (needed once servers run on other machines).
- Max line length on the hub socket (localhost + token for now).
- Account linking, per-player webhook avatars, message batching.

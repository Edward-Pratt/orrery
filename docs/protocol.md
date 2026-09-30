# Wire protocol (v1)

The contract between the hub and a mod. Living document: change it together with `hub/src/protocol.ts` and the
mod (see `CLAUDE.md`). History: the v1 spec, plus additions from v1.2b and v1.3, in `docs/archive/specs/`.

Transport: TCP, UTF-8, one JSON object per line (`\n`-terminated). Every
message has a string `type`; every field is type-checked by the receiver.
Before the handshake the hub closes the connection on anything but a valid
`hello`, and on no `hello` within 5 s. After the handshake, malformed lines
and unknown types are logged and ignored (forward compatible).

From v1.3 the hub accepts a range of protocol versions, `MIN_PROTOCOL..PROTOCOL_VERSION` (the current and the
previous), so servers can update their mods one at a time (`docs/adr/0001`).

Extra fields and unknown message types are ignored by both sides, so adding messages or optional fields
doesn't need a version bump. Anything else does (see `CLAUDE.md`, "Changing the wire protocol").

## Handshake

First message from mod:

```json
{"type":"hello","protocol":1,"serverId":"gtnh","token":"<shared secret>","modVersion":"1.0.0"}
```

Hub replies `{"type":"welcome"}` or `{"type":"reject","reason":"..."}` then
closes. Tokens are per server (hub config), at least 16 characters, compared
in constant time. A second connection for an already-connected `serverId`
replaces the old one; the old connection's close is then ignored (no alert).

## Mod → hub

| type | fields | when |
|---|---|---|
| `started` | — | `FMLServerStartedEvent` |
| `stopping` | — | `FMLServerStoppingEvent` (a crash skips it — verified in FML's `MinecraftServer` patch), and a JVM shutdown hook for SIGTERM/`systemctl stop`, where vanilla's own hook calls `stopServer()` directly and the FML event never fires |
| `heartbeat` | `tps` (number), `players` (string[]), optional `dims` (up to 5 of `{ id: number, name, ms: number }`, slowest first) | from the server tick, ≥5 s wall-clock apart |
| `chat` | `player`, `message` | `ServerChatEvent` |
| `join` / `leave` | `player` | FML `PlayerLoggedIn/OutEvent` |
| `death` | `player`, `message` (vanilla death text) | `LivingDeathEvent` for players |
| `achievement` | `player`, `achievement` | `AchievementEvent`, first real unlock only |
| `cmdResult` | `id`, `output` (string[]) | after a `cmd` runs |
| `cmdLate` | `id`, `output` (string[]) | lines a command prints after its `cmdResult` (e.g. spark's result link), batched once quiet for 1.5 s, for up to 5 min |
| `quest` | `player`, `quests` (1–50 of `{ name, main: boolean }`) | BetterQuesting completion, if installed |
| `link` | `player`, `uuid`, `code` | in-game `/discord link <code>` |
| `unlink` | `player` | in-game `/discord unlink` |
| `backup` | `ok` (boolean), `detail` | ServerUtilities logs "Backup done in …" or "Error while backing up" |

While disconnected the mod drops everything except `started`/`stopping`, so
a hub outage never replays stale chat into Discord.

## Hub → mod

| type | fields | effect |
|---|---|---|
| `say` | `author`, `message`, `source` (optional: `discord` or `dashboard`, where the line was typed) | broadcast `[Dashboard] <author> message` (gold) for `dashboard`, else `[Discord] <author> message` (blue), in MC chat. `source` was added without a protocol bump: an older mod ignores it and prints `[Discord]` |
| `cmd` | `id`, `command` | run as console-level sender, reply with `cmdResult` |
| `linkResult` | `player`, `ok` (boolean), `message` | answer to `link`/`unlink`, shown to that player |

Status is served from the latest `heartbeat`; no request/response needed.
A `cmdResult` with an unknown or late `id` is ignored.

## Liveness and uptime

| Hub observes | Meaning | Discord alert |
|---|---|---|
| `hello` accepted | online (no alert — may be a reconnect after hub restart) | — |
| `started` | server finished starting | "✅ Server started" |
| `stopping` then disconnect | clean stop | "🛑 Server stopped" |
| disconnect without `stopping` | crash / killed | "💥 Server went down unexpectedly" |
| no heartbeat for 30 s, after at least one heartbeat on this connection and before `stopping` | hung | "⚠️ Server not responding"; next heartbeat posts "✅ Server responding again" |
| not connected 60 s after hub start | offline (recorded as `down` for uptime) | — |

Hung detection is armed by the first heartbeat (not by `started`) so it also
works after a hub restart, and it stays quiet through GTNH's multi-minute
world load (no ticks yet) and shutdown save (after `stopping`).

State transitions go to SQLite as `events(server_id, ts, state, reason)`
with `state` ∈ `up` / `down` / `unknown`. Uptime = up time ÷ known time over
the window. Hub downtime counts as `unknown`: the hub stamps a `last_alive`
time every minute and on every recorded event, and on startup writes `unknown` rows at that time and at
now (accurate to ~1 minute even if the hub crashed).

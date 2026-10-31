# Wire protocol (v1)

The contract between the hub and a mod, and between the hub and an Agent (see "Agent connection"). Living document:
change it together with `hub/src/protocol.ts`, `hub/src/types.ts` and the mod (see `CLAUDE.md`). History: the v1
spec, plus additions from v1.2b and v1.3, in `docs/archive/specs/`.

Transport: TCP, UTF-8, one JSON object per line (`\n`-terminated). Every
message has a string `type`; every field is type-checked by the receiver.
Before the handshake the hub closes the connection on anything but a valid
`hello`, and on no `hello` within 5 s. After the handshake, malformed lines
and unknown types are logged and ignored (forward compatible).

From v1.3 the hub accepts a range of protocol versions, `MIN_PROTOCOL..PROTOCOL_VERSION` (the current and the
previous), so servers can update their mods one at a time (`docs/adr/0001`).

Extra fields and unknown message types are ignored by both sides, so adding messages or optional fields
doesn't need a version bump. Anything else does (see `CLAUDE.md`, "Changing the wire protocol"). The hub drops
extra fields: what it parses holds only the fields listed here, nested objects included (a `reply`'s `data` is
checked against its request's shape before it is read).

## Field limits

The hub enforces these on the Mod port and the Agent port alike (`LIMITS` in `hub/src/protocol.ts`). A message with
a field over its limit is invalid as a whole: before the handshake that closes the connection, after it the line is
ignored. Lengths count characters (UTF-16 code units).

| field | limit |
|---|---|
| player names (`player`, `players[]`, a milestone's `force`) | 64 characters |
| chat and death `message`, a milestone's `text` | 1 KiB (1024 characters) |
| `players[]` | 200 entries |
| `output[]` (`cmdResult`, `cmdLate`) | 500 lines of 1 KiB |
| `detail` (`backup`, `updateStep`), a `reply`'s `error` | 2 KiB |
| `deployResult.log` | 16 KiB |
| `reply.data` | 256 KiB as serialised JSON |
| `lines[]` of a `log` or `journal` reply | 1000 lines of 1 KiB |
| `saves[]`, `mods[]` | 500 entries each |
| `dims[]` | 5 entries |
| `quests[]` | 1 to 50 entries |
| `sample.load[]` | 3 entries |
| `sample.disks[]`, a `logs` reply's `files[]` | 32 entries each |
| every other string (ids, tokens, versions, unit names, tags, file names) | 256 characters |

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

An Agent's game connection for a Factorio server sends the same messages (no `achievement`, `quest` or `cmdLate`),
plus these:

| type | fields | when |
|---|---|---|
| `heartbeat` | adds optional `paused` (boolean) | after each `/orrery-status` RCON round trip (5 s); `paused` while auto-paused with nobody on, or `tick_paused`, or a stalled tick with players on. The hub ignores `tps` while paused |
| `milestone` | `kind` (`research`, `rocket`, `platform` or `landing`), `text`, optional `player`, optional `force` | a research finished (not by script), or a force's first rocket, first space platform, or first landing on each planet |
| `link` | `uuid` is `""` | in-game `/orrery-link <code>`: Factorio has no player UUIDs |
| `backup` | `ok`, `detail` | the save a `save` asked for is written (its size stable for 5 s), or failed |

While disconnected the mod drops everything except `started`/`stopping`, so
a hub outage never replays stale chat into Discord.

## Hub → mod

| type | fields | effect |
|---|---|---|
| `say` | `author`, `message`, `source` (optional: `discord` or `dashboard`, where the line was typed) | broadcast `[Dashboard] <author> message` (gold) for `dashboard`, else `[Discord] <author> message` (blue), in MC chat. `source` was added without a protocol bump: an older mod ignores it and prints `[Discord]` |
| `cmd` | `id`, `command` | run as console-level sender, reply with `cmdResult` |
| `linkResult` | `player`, `ok` (boolean), `message` | answer to `link`/`unlink`, shown to that player |
| `notice` | `message` | Factorio only (the Agent's game connection): a system line in game, such as a countdown. A Mod gets `cmd` `say …` instead |
| `save` | — | Factorio only: the Agent makes a named save (`orrery-<time>`), then sends `backup` |

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
| a factorio server's Agent sends `bye`, or is lost (see "Agent connection") | `lost`: its game connection is dropped, players and rate cleared (recorded as `unknown`) | — (a lost Agent is one host notice instead) |

Hung detection is armed by the first heartbeat (not by `started`) so it also
works after a hub restart, and it stays quiet through GTNH's multi-minute
world load (no ticks yet) and shutdown save (after `stopping`).

State transitions go to SQLite as `events(server_id, ts, state, reason)`
with `state` ∈ `up` / `down` / `unknown`. Uptime = up time ÷ known time over
the window. Hub downtime counts as `unknown`: the hub stamps a `last_alive`
time every minute and on every recorded event, and on startup writes `unknown` rows at that time and at
now (accurate to ~1 minute even if the hub crashed).

## Agent connection

An Agent is a small service on another Host that runs one Factorio server there (`agent/`). It dials out to the
hub's Agent port, `integrations.agents.listen` (for example the hub's tailnet address, port 25584), never the Mod
port. The same transport and handshake rules apply, with these on top: the peer's address must be the Agent's
configured `address`, checked before any byte is read (else the socket is destroyed silently, for either first
line); a line over 64 KiB, or 10 s over the rate limit, closes the connection; every field has its limit (above).

An Agent opens two connections:

- the **Agent connection**, for as long as it runs: host samples, its service's state, saves, requests and updates.
  It stays up while Factorio is down, so the hub can start it.
- a **game connection** for its server, only while Factorio answers RCON. From the `hello` on it is a game connection
  like a Mod's: its messages are the ones in "Mod → hub" and "Hub → mod" above.

`agentHello.protocol` shares `PROTOCOL_VERSION` and `MIN_PROTOCOL` with the Mod's hello.

### Handshake

The first line on the Agent port is one of:

| first line | accepted when | reply |
|---|---|---|
| `agentHello` `{ protocol, agentId, token, agentVersion }` | `agentId` is in config, `token` is its token (at least 32 characters, compared in constant time), `protocol` is in range. A second connection replaces the first | `welcome` / `reject` |
| `hello` `{ protocol, serverId, token, modVersion }` | `token` is that Agent's token, `serverId` is its `server`, and its Agent connection is up. `modVersion` is the Factorio mod's (`orrery`) version | `welcome` / `reject` |

```json
{"type":"agentHello","protocol":1,"agentId":"factorio-vm","token":"<at least 32 characters>","agentVersion":"agent-v1.0.0"}
```

### Agent → hub

| type | fields | when |
|---|---|---|
| `ping` | — | every 10 s |
| `bye` | — | before a planned exit (a deploy, SIGTERM) |
| `hostSample` | `sample` (`{ ts, cpu, load: number[], memory: { used, total }, disks: { mount, free, total }[] }`, as the hub's own Host samples) | every 60 s |
| `serviceState` | `unit`, `active` (ActiveState), `sub` (SubState), `since` (epoch ms of the last change), `result` (Result) | on connect, and on each change |
| `saves` | `saves` (`{ name, size, mtime (epoch ms), kind: named, auto or world, current: boolean }[]`), `free` (bytes free for saves) | on connect, and after each change |
| `installed` | `factorio` (version), `mods` (`{ name, version }[]`, every enabled mod) | on connect, and after an update |
| `updateStep` | `id`, `step` (`prepare`, `backup`, `stop`, `swap`, `gate` or `rollback`), `state` (`waiting`, `running`, `done` or `failed`), `detail` | during an update; `id` is the `update` request's |
| `updateDone` | `id`, `outcome` (`ok`, `rolled back`, `failed in staging`, `failed before swap`, `failed` or `cancelled`), `from`, `to`, optional `backup` (the pre-update save) | at the end of an update |
| `deployResult` | `tag`, `outcome` (`ok`, `failed` or `rolled back`), `log` | after reconnecting from its own deploy, from `deploy-status.json` |
| `reply` | `id`, `ok` (boolean), optional `error`, optional `data` | the answer to a request |

The Agent never sends a URL query string in `detail`, `error` or `log`.

### Hub → Agent

Every request carries a fresh `id` and is answered by a `reply` with that `id`, within 30 s.

| type | fields | effect | `reply.data` |
|---|---|---|---|
| `serviceAct` | `id`, `action` (`start`, `stop` or `restart`) | `systemctl <action> --no-block` on its own unit only | — |
| `journal` | `id`, `unit` | the last 200 lines of that unit's log file (the server's unit: `factorio-current.log`; the Agent's own: `agent.log`) | `{ lines }` |
| `logs` | `id` | lists the log files it serves (`factorio-current.log`, `factorio-previous.log`, `agent.log`) | `{ files: { name, size, modified }[] }` |
| `log` | `id`, `name` | the last 1000 lines of a listed file; any other name is an error | `{ lines }` |
| `restore` | `id`, `name` | copies a listed save as the newest file (`restored-<time>-<name>`), only while the unit is inactive; the next start loads it | — |
| `update` | `id`, `factorio` (`{ version, url, sha256 }`), `mods` (`{ name, version, sha1, url }[]`) | validates it, checks every hash itself, then starts the update: `reply` means accepted; its steps follow as `updateStep` with this `id` | — |
| `updateResume` | `id` | the update running continues after the hub's stop (the unit is inactive) | — |
| `updateCancel` | `id` | the update running is cancelled, only before the swap | — |
| `deploy` | `id`, `tag` (`agent-vX.Y.Z`) | starts its own deploy unit for that release: `reply` means started | — |

The Agent treats every request as untrusted: it never runs a path or argv it was sent, checks names against its
own listings, and refuses an `update` whose versions, names or URLs fail its checks (see `agent/CLAUDE.md`).

### Liveness

- With no line for 20 s on the Agent connection, or a close without `bye`, the hub marks the Agent lost: it drops
  the game connection, records the server `lost`, and posts one `agentLost` host notice; `agentBack` follows on
  reconnect. After `bye` the server is `lost` too, but nothing is posted.
- A game connection that closes without `stopping` while the Agent connection is up waits up to 5 s for the Agent
  connection to close too (then the Agent is lost); otherwise the server crashed.
- Hung detection is the Mod's (30 s without a heartbeat), and stays on while paused, since the Agent's heartbeats
  follow each RCON round trip, paused or not. It is off only while the Agent is lost.

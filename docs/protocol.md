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
ignored. Two fields are cut to their limits instead: `output[]` (its first 500 lines, each cut to 1 KiB) and a
`backup`'s `detail`, since Mods already deployed send up to 2000 lines of any length, and an exception's text as is.
Lengths count characters (UTF-16 code units).

| field | limit |
|---|---|
| player names (`player`, `players[]`, a milestone's `force`) | 64 characters |
| chat and death `message`, a milestone's `text` | 1 KiB (1024 characters) |
| `players[]` | 200 entries |
| `output[]` (`cmdResult`, `cmdLate`) | 500 lines of 1 KiB (cut) |
| `detail` (`backup`, cut; `updateStep`), a `reply`'s `error` | 2 KiB |
| `deployResult.log` | 16 KiB |
| `reply.data` | 256 KiB as serialised JSON |
| `lines[]` of a `log` or `journal` reply | 1000 lines of 1 KiB |
| `saves[]`, `mods[]` | 500 entries each |
| `dims[]` | 5 entries |
| `quests[]` | 1 to 50 entries |
| `sample.load[]` | 3 entries |
| `sample.disks[]`, a `logs` reply's `files[]` | 32 entries each |
| an `update`'s `url`s (`factorio.url`, `mods[].url`: a mod's signed link is long) | 2 KiB (2048 characters) |
| every other string (ids, tokens, versions, unit names, tags, file names) | 256 characters |
| one line on the Agent port (`LIMITS.lineBytes`, its newline not counted), before and after the handshake | 1 MiB (1,048,576 bytes) |

## Handshake

First message from mod:

```json
{"type":"hello","protocol":1,"serverId":"gtnh","token":"<shared secret>","modVersion":"1.0.0"}
```

Hub replies `{"type":"welcome"}` or `{"type":"reject","reason":"..."}` then
closes. Tokens are per server (hub config), 16 to 256 characters, compared
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

An Agent's game connection for a Factorio server sends the same messages (no `achievement`, `quest` or `cmdLate`:
the hub drops them from it), plus these:

| type | fields | when |
|---|---|---|
| `heartbeat` | adds optional `paused` (boolean) | after each `/orrery-status` RCON round trip (5 s); `paused` while auto-paused with nobody on, or `tick_paused`, or a stalled tick with players on. The hub ignores `tps` while paused |
| `milestone` | `kind` (`research`, `rocket`, `platform` or `landing`), `text`, optional `player`, optional `force` | a research finished (not by script), or a force's first rocket, first space platform, or first landing on each planet |
| `link` | `uuid` is `""` | in-game `/orrery-link <code>`: Factorio has no player UUIDs |
| `backup` | `ok`, `detail` | a named save is written (its size stable for 5 s), or failed: one a `save` asked for, or the Agent's own every 6 h after play |

While disconnected the mod drops everything except `started`/`stopping`, so
a hub outage never replays stale chat into Discord.

## Hub → mod

| type | fields | effect |
|---|---|---|
| `say` | `author`, `message`, `source` (optional: `discord` or `dashboard`, where the line was typed) | broadcast `[Dashboard] <author> message` (gold) for `dashboard`, else `[Discord] <author> message` (blue), in MC chat. `source` was added without a protocol bump: an older mod ignores it and prints `[Discord]` |
| `cmd` | `id`, `command` | run as console-level sender, reply with `cmdResult`. For a Mod the hub strips a leading `/`; a factorio server's `command` is as typed in its console (`/players`), the leading `/` kept, and 1 to 256 characters: the hub refuses a longer one before sending it, and the Agent refuses one too |
| `linkResult` | `player`, `ok` (boolean), `message` | answer to `link`/`unlink`, shown to that player |
| `notice` | `message` | Factorio only (the Agent's game connection): a system line in game, such as a countdown. A Mod gets `cmd` `say …` instead |
| `save` | — | Factorio only: the Agent makes a named save (`orrery-<time>`), then sends `backup` |

Status is served from the latest `heartbeat`; no request/response needed.
A `cmdResult` with an unknown or late `id` is ignored.

## Liveness and uptime

| Hub observes | Meaning | Discord alert |
|---|---|---|
| `hello` accepted | online (no alert — may be a reconnect after hub restart) | — |
| `started` | server finished starting (one per connection: a repeat on it is ignored) | "✅ Server started" |
| `stopping` then disconnect | clean stop | "🛑 Server stopped" |
| disconnect without `stopping` | crash / killed | "💥 Server went down unexpectedly" |
| no heartbeat for 30 s, after at least one heartbeat on this connection and before `stopping` | hung | "⚠️ Server not responding"; next heartbeat posts "✅ Server responding again" |
| not connected 60 s after hub start | offline (recorded as `down` for uptime); a factorio server whose Agent isn't connected stays `unknown` | — |
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
line); a line over its cap (see "Field limits"), or 10 s over the line budget (see "Rate rules"), closes the
connection; every field has its limit (above).

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
| `agentHello` `{ protocol, agentId, token, agentVersion }` | `agentId` is in config, `token` is its token (32 to 256 characters, compared in constant time), `protocol` is in range. A second connection replaces the first | `welcome` / `reject` |
| `hello` `{ protocol, serverId, token, modVersion }` | `token` is that Agent's token, `serverId` is its `server`, and its Agent connection is up (else `reject` with `its agent is not connected`). `modVersion` is the Factorio mod's (`orrery`) version | `welcome` / `reject` |

Either is refused (`reject` with `reconnecting too fast`) under 5 s after the last one of its kind for that Agent was
welcomed; the connection that one opened stays.

```json
{"type":"agentHello","protocol":1,"agentId":"factorio-vm","token":"<32 to 256 characters>","agentVersion":"agent-v1.0.0"}
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
| `deployResult` | `tag`, `outcome` (`ok`, `failed` or `rolled back`), `log` | once per deploy (`ok` too), when its own deploy's unit is over (after the restart, on whichever release came back), from `deploy-status.json` |
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

The hub sends `update`, `updateResume` and `updateCancel` for game updates, and `deploy` for the Agent's own
deploys (both below). Release 1's Agent has no handler for these requests: it answers each with a `reply`
`ok: false` (the hub ends that update `failed in staging`, or that deploy `failed`, with its error), and sends no
`installed`, so the hub never offers it an update.

The Agent treats every request as untrusted: it never runs a path or argv it was sent, checks names against its
own listings, and refuses an `update` whose versions, names or URLs fail its checks (see `agent/CLAUDE.md`).

### Game updates

The hub resolves the update (the Factorio version, and the portal mods with their dependencies) and decides; the
Agent carries it out. In order:

1. The hub sends `update` with a fresh `id`, U: `factorio` (`url`: `https://www.factorio.com/get-download/<version>/headless/linux-arm64`,
   `sha256` from factorio.com's list) and `mods`, every portal mod the server is to have (the game's own, like
   `base`, come with its version; a mod left out is removed), each with its portal `sha1` and a signed link on
   `https://dl-mod.factorio.com` whose only query key is `secure`, resolved right before. No credential is ever in
   it. The `reply` says whether the Agent took it; then every `updateStep` and the `updateDone` carry U.
2. The Agent prepares (`prepare`) and saves (`backup`; a stopped server: none, and it names the newest save), then
   sends `updateStep` `stop` `waiting` and waits. Its `stop` step is only ever `waiting`: the stop is the hub's.
3. The hub stops the unit (`serviceAct` `stop`, after the usual 5-minute countdown in game while players are on;
   not at all when it is already inactive or failed) and, once the pushed `serviceState` is inactive or failed,
   sends `updateResume`.
4. The Agent swaps (`swap`), starts the unit and gates it (`gate`), rolls back if that fails (`rollback`), sends
   `installed`, then `updateDone` (`backup`: the pre-update save).

While a step runs, the Agent sends its `updateStep` again at least every 60 s, the same one when nothing changed (and
a step at most once a second unless its state changes).

`updateDone`'s `from` and `to` name the two sides as the hub's history row does (the hub labels its row itself):
`<X.Y.Z> · <N> mods`, with a space, `·` (U+00B7) and a space between, and `1 mod` for one. N counts every enabled mod,
the game's own (`base`, `elevated-rails`, `quality`, `recycler`, `space-age`) included. `from`: the version and the
number of `mods` in the Agent's latest `installed` before the update. `to`: the update's `factorio.version`, and the
game's own mods enabled in that `installed` plus every mod in the update's `mods`. Factorio 2.1.24 with `base`,
`elevated-rails`, `quality`, `space-age` and `orrery` enabled is `2.1.24 · 5 mods`.

`updateResume` and `updateCancel` carry fresh request ids of their own and act on the update running, the one
update an Agent runs at a time. `updateCancel` is taken only before the swap (else `ok: false`); it never starts or
stops the unit, and the Agent ends the update with `updateDone` `cancelled`. The hub sends it when Cancel is pressed
while the Agent prepares, when the countdown is cancelled, when it gives up before the swap (it stopped the server:
it starts it again), and, on the Agent's next `agentHello`, for an update the hub closed before its swap while the
Agent was away or the hub restarted. An Agent with no update running answers it `ok: false`. The hub gives up an
update 15 minutes after the Agent's latest `updateStep` with U, or its own latest request for it (while the hub itself
stops the server, it doesn't count). An `updateDone` with U that comes after the hub closed the update is still
recorded on it. After a hub restart the hub no longer knows U: it takes the `id` of the first `updateStep` the Agent
sends (on connecting, before it reads anything from the hub, the Agent sends a running update's latest step again),
else that of the next `updateDone`. When the Agent answers the reconnect's `updateCancel` `ok: false` without such a
step first, nothing runs there and no later `updateDone` is recorded on that row. The Agent takes an `update` only
once the last one's `updateDone` is sent, so a new update ends the wait for the last one's.

### Agent deploys

The Agent deploys itself; the hub picks the release and records the outcome. In order:

1. The hub sends `deploy` with a release GitHub lists, `tag` `agent-vX.Y.Z` (never one below `agent-v1.0.0`), only
   while the Agent is connected and no game update, restore or countdown runs on its server. The Agent checks the
   tag again and starts `orrery-agent-deploy@<tag>.service`: the `reply` means started.
2. The deploy restarts the Agent: it sends `bye` first, so its server is `lost` with nothing posted.
3. The new release's `agentHello` names the tag as `agentVersion` (as every `agentHello` names the Agent's own
   release, `agent-vX.Y.Z`): the hub records the deploy `ok`. An `agentHello` naming another release (the old one,
   after a rollback) doesn't end it.
4. Once its deploy unit has left activating, active, reloading and deactivating, the Agent sends `deployResult`
   from `deploy-status.json`, whichever release runs: also when the deploy failed before the restart (a failed
   download), and also after the hub recorded it `ok` on the tag's `agentHello` (the unit's gate runs after that
   hello). The hub records its `outcome` and `log` on that deploy of the `tag`, once (`rolled back`: the old release
   came back; an `ok` while the Agent's `agentHello` named another release is recorded as `failed`). A `rolled back`
   or `failed` after the `ok` corrects the row and is announced too.

Until that `deployResult` the deploy runs, for the hub, even once recorded `ok`: its unit holds the Agent's deploy
lock, so the hub starts no other deploy (of any part; a second `deploy` would find the lock taken and report
nothing), and no game update or restore on its server. The hub gives a deploy up as `failed` when neither the tag's
`agentHello` nor its `deployResult` comes within 10 minutes, stops waiting for the result of one recorded `ok` 10
minutes after that hello, and closes one a hub restart interrupted as `failed`. A `deployResult` for no deploy
running, of another tag, a second one, or one after the hub gave the deploy up or restarted, is ignored.

### Liveness

- With no line for 20 s on the Agent connection, or a close without `bye`, the hub marks the Agent lost: it drops
  the game connection, records the server `lost`, and posts one `agentLost` host notice; `agentBack` follows on
  reconnect. After `bye` the server is `lost` too, but nothing is posted.
- A game connection that closes without `stopping` while the Agent connection is up waits up to 5 s for the Agent
  connection to close too (then the Agent is lost); otherwise the server crashed.
- Hung detection is the Mod's (30 s without a heartbeat), and stays on while paused, since the Agent's heartbeats
  follow each RCON round trip, paused or not. It is off only while the Agent is lost.

### Rate rules

The hub's budgets on the Agent port are its safety net against a token holder. What goes over is dropped (the hub
logs it at most once a minute, with a count), never answered. An Agent stays under them, except for game events: it
forwards up to 5 a second (see below) but the hub takes 2, so a busy server's game events over 2 a second are dropped
at the hub, without the Agent knowing.

- **Connections**: at most 4 at once from one address (an Agent connection, a game connection and two spare),
  handshaken or not; a fifth is destroyed before any byte is read. Agents sharing an address share the 4. A refused
  first line gets its `reject`, then the hub closes the connection within 2 s, whatever the peer does.
- **Lines**: each connection (the Agent connection and the game connection, each its own) 20 lines a second, in bursts
  of up to 100. A line over it is dropped; a connection still dropping lines 10 s on is closed. A connection's budgets
  are kept across reconnects: one that replaces another, or comes after it closed, goes on with what that one left,
  so reconnecting never starts a fresh burst. A first line, before the handshake says whose it is, takes from its
  address's own budget, the same size.
- **Handshakes**: an Agent connection, and a game connection for its server, each welcomed at most once per 5 s (see
  "Handshake").
- **Message types**, each within its own connection: a message over its budget is dropped and the connection stays.

| type | budget |
|---|---|
| `chat`, `join`, `leave`, `death`, `milestone`, together | 2 a second, bursts of 30 |
| `link`, `unlink`, together | 1 a second, bursts of 5 |
| `updateStep` | 5 a second, bursts of 20 |
| `serviceState`, `saves`, `installed`, each | dropped when identical to the last one of its type the hub took on that connection (so the first after a reconnect is always taken); else 1 a second, bursts of 10 |
| `hostSample` | one per 10 s per Agent, its connections and reconnects together; stored with the hub's clock as its `ts`, never the Agent's |
| `heartbeat` | 1 a second, bursts of 5. Its names not on its server's player list yet (none are while the server is offline, so after a reconnect all are) at most 1 per 10 s, bursts of 200 (a full `players`): a name over it is left out of that heartbeat and comes with a later one |
| `backup` | 1 per 10 s, bursts of 3 |
| any other | the line budget only (`updateDone` and `deployResult` are taken once each, the one its update or deploy waits for; the rest are ignored) |

What an Agent's pushes can post is bounded too: its Host's disk notices cover only the first 32 mounts its samples
name, each mount's change told at most once per 10 min (a change meanwhile is told after the wait, if it still holds),
and its service's failure is a notice at most once per 10 min (every state still goes on the stream).

An Agent forwards its server's game events at most 5 a second (bursts of 30, every type together, the rest dropped),
so a player flooding chat never gets the game connection closed; of those the hub takes 2 a second (above). It sends
an `updateStep` for the same step at most once a second unless its `state` changes.

# agent (orrery-agent)

A Node service on a remote Host. It dials out to the hub with its token and runs that Host's Factorio server: RCON,
the Factorio mod's events, the server's unit, saves, host samples and updates. Node 24+ + TypeScript, run directly
(type stripping, no build step) like the hub. No runtime dependencies: Node built-ins only.

```bash
npm test            # node --test "test/*.test.ts"
npm run typecheck   # tsc, noEmit; also type-checks the hub types src/ imports
node src/index.ts           # the agent (orrery-agent.service)
node src/index.ts check     # the first-boot check: a report on stdout, exit 0 when it passed
```

On the Host it reads `/etc/orrery-agent/config.json` (written by `deploy/setup-agent-host.sh`) and the environment
`ORRERY_AGENT_TOKEN` and `RCON_PASSWORD` (root-only env files read by systemd). For tests and the local dev loop only,
`ORRERY_AGENT_CONFIG` moves the config file and `ORRERY_AGENT_ROOT` the agent's folder (`/srv/orrery-agent`).

## Wire contract

`docs/protocol.md` ("Agent connection") is authoritative. The message types come from `hub/src/types.ts`, through
`import type` only: a release tarball is `agent/` alone, so no runtime import may leave `agent/`. `src/wire.ts` holds
the agent's copies of `PROTOCOL_VERSION` and `LIMITS`; `test/wire.test.ts` checks them against
`hub/src/protocol.ts`, so change them together. One line on the Agent port is at most 1 MiB (`LIMITS.lineBytes`,
the owner's decision of 2026-10-31), its `\n` included, both ways.

The release is `agent-v` + `package.json`'s `version`, which stays `0.0.0` in the repo (like `factorio/info.json`):
the hello's `agentVersion` and the `connected` file carry it, and an agent deploy is `ok` when it matches the tag.

## TypeScript constraints (type stripping)

- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Relative imports include the `.ts` extension; type-only imports use `import type` / `type X`.

## Modules

| File | Job |
|---|---|
| `src/index.ts` | The entry point. `node src/index.ts` loads the config and wires the rest: the unit's state (to `HubClient` and `GameEvents`), RCON's answers (to `HubClient`, and to `GameEvents` for its hello), the Factorio mod's game events and a host sample every 60 s go to `HubClient`; the hub's `say`, `notice` and `linkResult` run as the mod's commands (`toGame`) on an `RconSession` of their own, which also carries `/orrery-hello`. With no hub reachable it keeps running (the hub client retries, and logs once per change). SIGTERM or SIGINT: `HubClient.stop` (`bye`, both connections closed), then exit 0. `node src/index.ts check` runs `check.ts`; a bad config exits 1. The version is `agent-v` + `package.json`'s. |
| `src/config.ts` | `loadConfig(path, env, root)`: `/etc/orrery-agent/config.json` (`{ id, hub: { host, port }, server: { id, unit, install, data, rconPort, factorioUdpPort, agentUdpPort }, mounts }`) and the secrets from the environment, checked strictly (every problem listed, no secret printed; unknown keys ignored, since setup can be newer than the agent): the hub's Agent id rule, an IPv4 hub, ports, a `.service` unit name, absolute normalised folders outside the agent's own (`/srv/orrery-agent`, which also holds `state/`) and not holding it, 1 to 32 mounts, `ORRERY_AGENT_TOKEN` 32 to 256 characters, `RCON_PASSWORD` set. |
| `src/wire.ts` | The agent's side of the wire: `PROTOCOL_VERSION` and `LIMITS` (copies of the hub's, the line cap 1 MiB); `LineReader`, which splits a socket's bytes into lines and throws `LineTooLong` once a line (its `\n` included) passes the cap, before its end arrives; `encode`, a message as one line within the cap, dropping a command output's or a reply's oldest `lines` to fit and refusing (null) anything else too big, never cutting JSON; `readAgentLine` and `readGameLine`, which check what the hub sends against the documented fields and limits and copy only those fields, or say why not with the request's `id` when it had a usable one. The game connection reads `welcome`, `reject` and `ToGame`: `say` (`source` `discord` when left out, as docs/protocol.md allows), `notice` and `linkResult`; `cmd` and `save` read as unknown so far. |
| `src/hub.ts` | `HubClient`, the two connections to the hub's Agent port. The Agent connection sends `agentHello` and nothing else before `welcome`; then a `ping` every 10 s, `serviceState` on connect and on each change, `hostSample` when given (never queued), and a `reply` by id to every request: a `Handlers` entry's result, or `ok: false` for one that is invalid, of an unknown type or has no handler yet. Any close reconnects after `backoff` (1 s doubling to 60 s, jittered into the upper half, reset by a welcome); state changes are logged once each. After each welcome it writes `<root>/connected`, `{"version":"agent-vX.Y.Z","time":<epoch ms>}`, atomically (temp file and rename). The game connection opens only while the Agent connection is up and RCON answers (`status`): `hello` with the agent's token and the orrery mod's version, then a `heartbeat { tps: UPS, players, paused }` per answer once there is a rate, and each game event given to `event` (dropped while the game connection isn't up, as a Mod drops them while disconnected); the hub's `say`, `notice` and `linkResult` on it go to the `toGame` option. It closes with the Agent connection or when RCON is gone (`down`); a stall (`stalled`) only stops the heartbeats, so the hub's hung detection reports a frozen server as hung, not crashed. A line from the hub over the cap destroys that connection (then a reconnect). `stop`: `bye`, then once it is written the game connection and the Agent connection end, 2 s at most. |
| `src/status.ts` | `StatusPoller`: `/orrery-status` over one kept RCON connection every 5 s; `status` after each successful round trip only (heartbeats follow RCON, never a timer); `stalled` once when RCON takes the connection but times out (an `RconTimeout`: a blocking save, or frozen) or answers without a status; `down` once when it is gone (refused, reset or closed by the server). `players` is the latest online list (emptied once RCON is gone). `parseStatus` reads the mod's reply as untrusted: anything off is no status; players `{}` is nobody; names over 64 characters dropped, at most 200; versions must be `X.Y.Z`; the orrery mod's from `mods.orrery`. `reading`: UPS = Δtick / Δwall time (null on the first answer or a tick that went back); paused when `tick_paused`, or nobody on with `auto_pause`, or Δtick at most 1 with players on. `readAutoPause` reads `server-settings.json` (container-writable) with `O_NOFOLLOW` and `O_NONBLOCK`, only a regular file up to 1 MiB, `auto_pause === true`, else false. |
| `src/events.ts` | The Factorio mod's game events, both ways (factorio/CLAUDE.md). `GameEvents`: a UDP listener on 127.0.0.1:`agentUdpPort` (retried every 10 s while the port is taken) that takes datagrams only from 127.0.0.1:`factorioUdpPort`, only while the unit is `active`, and after each start (it became active, or its change time moved while active: a restart between two readings) only once `factorio-current.log` (opened `O_NOFOLLOW`/`O_NONBLOCK`, a regular file, its first 1 MiB, whole lines) has Factorio's engine line `Opening socket at (IP ADDR:({127.0.0.1:<port>}))`, so no other local process bound that port first. A log not written since the agent saw the unit stopped (inactive, failed or activating), or for an unseen restart since the second after it became active, is the previous run's and is read again (every 1 s) until Factorio replaces it. `Opening Lua UDP Socket failed` first, or neither line within 60 s: events are off until the next start, logged once (no hub message exists for it yet). Over 4 KiB, not the mod's shape (`parseDatagram`: `t`, `seq` a safe integer, each field checked against the hub's limits and copied; `message` and `text` cut to 1 KiB), or a `link`/`unlink` for a name not in `StatusPoller.players`: dropped, each kind logged once per start. `seq` gaps (and going back) are logged; the baseline is the mod's `hello` datagram, asked for with `/orrery-hello` once per start after the gate opens and RCON answers (`rconUp`); one that doesn't come within 5 s is logged. Emits `chat`, `join`, `leave` (no `reason` on the wire), `death` (`deathMessage`: "Alice was killed by Bob", "… by a medium biter", "Alice died"), `milestone` and `link` (`uuid` `""`), `unlink`. `toCommand`: `say`, `notice`, `linkResult` as `/orrery-say {author, message, source}`, `/orrery-notice {message}`, `/orrery-reply {player, ok, message}`, the argument `commandJson` (`JSON.stringify`, plus `\u` escapes for DEL, the C1 controls and U+2028/9): one line, never Lua. `toGame` runs one and logs a failure or a reply that is not `{"ok":true, …}`. |
| `src/service.ts` | `ServiceWatch`: `systemctl show --timestamp=unix --property=ActiveState,SubState,Result,StateChangeTimestamp -- <unit>` every 5 s, through `execFile` (no shell); `change` with `{ unit, active, sub, since, result }` on the first reading and each change (`since` in epoch ms, 0 if the unit never changed state). A failed read keeps the last state, logged once. State push only: no `serviceAct` yet. |
| `src/host.ts` | `HostSampler`: the hub's `HostSample` from this machine: CPU use between two `/proc/stat` readings (the first call only takes the baseline), `/proc/loadavg`, memory used and total from `/proc/meminfo` (`MemTotal` less `MemAvailable`) and `statfs` free and total on each configured mount (one that can't be read is left out, logged). The readers (`HostReaders`) are injectable for tests. |
| `src/check.ts` | `check`, the first-boot report: the config and secrets, a host sample, `/orrery-status` over RCON (retried for up to 5 minutes, factorio.service's start timeout, since Factorio may still be loading the map; the game's version and every loaded mod), and a TCP connect to the hub (a warning only, for setup's `--no-hub`). True when all but the hub passed. |
| `src/rcon.ts` | `Rcon`: a Source RCON client for Factorio's RCON, one connection. `Rcon.connect(host, port, password, timeoutMs)` authenticates (a refused password, id -1, rejects); `exec(command, timeoutMs)` resolves with the reply, one command in flight at a time. Factorio answers each command with exactly one packet of any size carrying its id, so the reply is that packet's body with one trailing `\n` stripped; packets with any other id (or type) are dropped. No packet with an empty body is ever sent (Factorio never answers one), so an empty command is refused. Ids are non-zero and rising; a packet over `MAX_PACKET` (16 MiB) or malformed ends the connection, refused as soon as its length field is in. A timeout ends it too, rejecting with `RconTimeout` (a server that took the connection but didn't answer, not one that is gone); once authenticated, an end other than `close()` emits `close` once, so the caller reconnects with a new `Rcon`. `RconSession`: commands on one kept connection of their own, opened on the first and again on the next one after it ends (refused, timed out, closed), in order; apart from `StatusPoller`'s, so a command that times out never reads as Factorio gone. `encode`/`decode` are the framing. |

## Trust boundaries (do not weaken)

- The agent never runs a path or argv it received from the hub. Every request maps to a fixed operation on its own
  configured unit, folders and file names, and a name is checked against the agent's own listing.
- What the hub sends is checked like the hub checks what it gets: documented fields only, each within its limit,
  and a line over 1 MiB closes the connection. Every line the agent sends fits the hub's limits too.
- RCON output is untrusted, and so is every file under the server's `data` folder (the container writes it): they
  drive display and alerting only, never a path or a security decision. Such files are opened without following
  symlinks or blocking, and read only if they are small regular files.
- Game events come over UDP only from Factorio's own Lua UDP port, only while the unit is active, and only once
  Factorio's log (this run's, not the previous one) shows Factorio bound that port; a `link` or `unlink` only for a
  player online at the latest `/orrery-status`. Every field is checked against the hub's limits before it is sent.
- RCON commands the agent builds are the mod's own commands with one line of JSON as the argument: never Lua, never
  `/c` or `/sc`, which would flag the save for good.
- The agent's own state lives under `/srv/orrery-agent`, which the container never mounts; the config refuses server
  folders that overlap it.

## Tests

`test/rcon.test.ts` drives a real socket with a fake RCON server (`fakeRcon` in `test/fake-rcon.ts`, shaped like
Factorio 2.1 as checked on a real 2.1.24 server: one auth reply, -1 for a wrong password (else the request's id);
one reply packet per command, every printed line ending in `\n`; a packet with an empty body never answered;
commands answered in order; `writeSize` cuts each reply packet into small writes; `port` brings a closed one back). `test/fake-hub.ts` is a fake
Agent port: a TCP server that parses every line with the hub's own `parseAgentLine` / `parseModLine` (a line the
real hub would refuse lands in `invalid`, which tests assert empty) and answers each first line with a welcome, a
reject, a reset or nothing; `eventually` polls a condition.

- `test/hub.test.ts`: `HubClient` against the fake hub: nothing before a welcome, pings, `serviceState`, the
  `connected` file; reconnect with backoff (and its reset); the game connection only while RCON answers, kept through a
  stall and closed when RCON is gone (with `StatusPoller` and fake RCON); heartbeats; `bye` and both closes on `stop`; a line over 1 MiB closes cleanly and
  reconnects; invalid, unknown and unsupported requests answered `ok: false` by id.
- `test/events.test.ts`: `GameEvents` with UDP injected from Factorio's port and from a stranger's: wrong source port,
  oversize and closed-gate datagrams dropped; the log check (no line or a forged chat or `log()` line: off at the
  deadline, logged once; the failure line: off at once; the next start: on; a previous run's log not read); `link`
  for an offline name dropped, `link` with `uuid ""`; `seq` gaps and the hello baseline; `/orrery-hello` once per
  start; `parseDatagram` against the hub's `parseModLine`; RCON strings escaped (`toCommand`); end to end with the fake
  hub and fake RCON, the hub's `say`, `notice` and `linkResult` as commands in order, and a link datagram reaching
  the hub.
- `test/index.test.ts`: `src/index.ts` as a child process, with a temp config, a fake `systemctl` first on `PATH`,
  the fake hub and fake RCON: both connections, then `bye` on SIGTERM and exit 0; offline with no hub, then
  connecting when it listens; `check`.
- `test/status.test.ts` (UPS, paused from players, `tick_paused` and Δtick, untrusted replies, `auto_pause` from
  symlinks and FIFOs, the poller's `status`, `stalled` and `down`), `test/service.test.ts`, `test/host.test.ts` (a real sample the hub accepts),
  `test/config.test.ts`, `test/wire.test.ts` (the constants against the hub's); `test/rcon.test.ts` also covers
  `RconSession` (one connection, in order, a new one after a timeout or a closed server).

Keep timing-sensitive tests on small timeouts, not sleeps of seconds; stop every poller and client in `t.after`.

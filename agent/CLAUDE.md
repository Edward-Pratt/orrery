# agent (orrery-agent)

A Node service on a remote Host. It dials out to the hub with its token and runs that Host's Factorio server: RCON,
the Factorio mod's events, the server's unit, saves and host samples. Game updates and its own deploys are release 2
(`docs/ROADMAP.md`) and not built: it parses the hub's `update`, `updateResume`, `updateCancel` and `deploy` requests,
has no handler for them and answers `ok: false`. Node 24+ + TypeScript, run directly (type stripping, no build step)
like the hub. No runtime dependencies: Node built-ins only.

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
set on 2026-10-31 while the owner was away: `docs/adr/0004`), its `\n` included, both ways.

The release is `agent-v` + `package.json`'s `version`, which stays `0.0.0` in the repo (like `factorio/info.json`):
the hello's `agentVersion` and the `connected` file carry it, and an agent deploy (release 2; `deploy/deploy-agent.sh` is built, nothing in the agent or the hub starts it yet) will be `ok` when it
matches the tag.

## TypeScript constraints (type stripping)

- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Relative imports include the `.ts` extension; type-only imports use `import type` / `type X`.

## Modules

| File | Job |
|---|---|
| `src/index.ts` | The entry point. `node src/index.ts` loads the config, sends everything it logs through `logs.ts` (to the journal and `<root>/agent.log`, URL query strings stripped) and wires the rest: the unit's state (to `HubClient` and `GameEvents`) and the agent's own stops (`ServiceWatch`'s `stopping`, to `HubClient.stopping`); RCON's answers (to `HubClient`, to `GameEvents` for its hello, and to `Saves.played`); the Factorio mod's game events, the saves list and each save's `backup`, and a host sample every 60 s go to `HubClient`. The hub's requests: `serviceAct` (`ServiceWatch.act`), `logs`, `log` and `journal` (`Logs`), `restore` (`Saves`); on the game connection `say`, `notice` and `linkResult` run as the mod's commands (`toGame`), a console `cmd` as typed (its reply cut by `outputLines`) and `save` as `Saves.save`. Every RCON command runs on one `RconSession` of its own, apart from the status poll's. With no hub reachable it keeps running (the hub client retries, and logs once per change). SIGTERM or SIGINT: `HubClient.stop` (`bye`, both connections closed), then exit 0. `node src/index.ts check` runs `check.ts`; a bad config exits 1. The version is `agent-v` + `package.json`'s. |
| `src/config.ts` | `loadConfig(path, env, root)`: `/etc/orrery-agent/config.json` (`{ id, hub: { host, port }, server: { id, unit, install, data, rconPort, factorioUdpPort, agentUdpPort }, mounts }`) and the secrets from the environment, checked strictly (every problem listed, no secret printed; unknown keys ignored, since setup can be newer than the agent): the hub's Agent id rule, an IPv4 hub, ports, a `.service` unit name, absolute normalised folders outside the agent's own (`/srv/orrery-agent`, which also holds `state/`) and not holding it, 1 to 32 mounts, `ORRERY_AGENT_TOKEN` 32 to 256 characters, `RCON_PASSWORD` set. |
| `src/wire.ts` | The agent's side of the wire: `PROTOCOL_VERSION` and `LIMITS` (copies of the hub's, the line cap 1 MiB); `LineReader`, which splits a socket's bytes into lines and throws `LineTooLong` once a line (its `\n` included) passes the cap, before its end arrives; `encode`, a message as one line within the cap, dropping a command output's or a reply's oldest `lines` to fit and refusing (null) anything else too big, never cutting JSON; `readAgentLine` and `readGameLine`, which check what the hub sends against the documented fields and limits and copy only those fields, or say why not with the request's `id` when it had a usable one. The game connection reads `welcome`, `reject`, `ToGame` (`say`, its `source` `discord` when left out, as docs/protocol.md allows; `notice`; `linkResult`), `cmd` (a `command` of one line, 1 to 256 characters: the hub strips control characters) and `save`. Cutting to the hub's limits before sending: `cut` (surrogate-safe), `outputLines` (an RCON reply as `cmdResult` output: the first 500 lines, each 1 KiB) and `replyLines` (a `log` or `journal` reply's last lines, each 1 KiB, the oldest dropped until `{ lines }` fits the hub's 256 KiB for a reply's `data`), both `printable` line by line: `printable` makes every control character but a tab (C0, DEL, C1) and U+2028/9 `?`, for anything RCON or a container-written file puts in a line the agent logs or reports (tabs stay: Lua tracebacks use them). |
| `src/hub.ts` | `HubClient`, the two connections to the hub's Agent port. The Agent connection sends `agentHello` and nothing else before `welcome`; then a `ping` every 10 s, `serviceState` and `saves` on connect and on each change, `hostSample` when given (never queued), and a `reply` by id to every request: a `Handlers` entry's result, or `ok: false` for one that is invalid, of an unknown type or has no handler yet. Any close reconnects after `backoff` (1 s doubling to 60 s, jittered into the upper half, reset by a welcome); state changes are logged once each. After each welcome it writes `<root>/connected`, `{"version":"agent-vX.Y.Z","time":<epoch ms>}`, atomically (temp file and rename). The game connection opens only while the Agent connection is up, RCON answers (`status`) and the unit, if its state is known, is active: `hello` with the agent's token and the orrery mod's version, `started` once per run of the unit (its change time, kept in `<state>/started.json`, so a restarted agent doesn't announce a run again), then a `heartbeat { tps: UPS, players, paused }` per answer once there is a rate, each game event given to `event` and each `backup` (dropped while the game connection isn't up, as a Mod drops them while disconnected); the hub's `say`, `notice` and `linkResult` on it go to `toGame`, a `cmd` to `command` (answered by `cmdResult`, also with a `refused` line for one that isn't valid, so the hub never waits), `save` to `save`. The stopping rule: for a stop the agent started (`stopping`, from `serviceAct` stop or restart) it sends `stopping` and closes at once; any other end of a run is `RunWatch`'s, at the unit's final state: `stopping` then the close for `stopped`, the close alone for `crashed`. A stall (`stalled`), or RCON gone (`down`) while the unit is still active, only stops the heartbeats, so the hub's hung detection reports a frozen server as hung; with no unit state known, `down` closes it. After a run ended no game connection opens until the unit's next run (active with another change time). It also closes with the Agent connection. A line from the hub over the cap destroys that connection (then a reconnect). `stop`: `bye`, then once it is written the game connection and the Agent connection end, 2 s at most. |
| `src/status.ts` | `StatusPoller`: `/orrery-status` over one kept RCON connection every 5 s; `status` after each successful round trip only (heartbeats follow RCON, never a timer); `stalled` once when RCON takes the connection but times out (an `RconTimeout`: a blocking save, or frozen) or answers without a status; `down` once when it is gone (refused, reset or closed by the server). `players` is the latest online list (emptied once RCON is gone). `parseStatus` reads the mod's reply as untrusted: anything off is no status; players `{}` is nobody; names over 64 characters or with a control character dropped, at most 200; versions must be `X.Y.Z`; the orrery mod's from `mods.orrery`. `reading`: UPS = Δtick / Δwall time (null on the first answer or a tick that went back); paused when `tick_paused`, or nobody on with `auto_pause`, or Δtick at most 1 with players on. `readAutoPause` reads `server-settings.json` (container-writable) with `O_NOFOLLOW` and `O_NONBLOCK`, only a regular file up to 1 MiB, `auto_pause === true`, else false. |
| `src/events.ts` | The Factorio mod's game events, both ways (factorio/CLAUDE.md). `GameEvents`: a UDP listener on 127.0.0.1:`agentUdpPort` (retried every 10 s while the port is taken) that takes datagrams only from 127.0.0.1:`factorioUdpPort`, only while the unit is `active`, and after each start (it became active, or its change time moved while active: a restart between two readings) only once `factorio-current.log` (opened `O_NOFOLLOW`/`O_NONBLOCK`, a regular file, its first 1 MiB, whole lines) has Factorio's engine line `Opening socket at (IP ADDR:({127.0.0.1:<port>}))`, so no other local process bound that port first. A log not written since the agent saw the unit stopped (inactive, failed or activating), or for an unseen restart since the second after it became active, is the previous run's and is read again (every 1 s) until Factorio replaces it. `Opening Lua UDP Socket failed` first, or neither line within 60 s: events are off until the next start, logged once (no hub message exists for it yet). Over 4 KiB, not the mod's shape (`parseDatagram`: `t`, `seq` a safe integer, each field checked against the hub's limits and copied; `message` and `text` cut to 1 KiB), or a `link`/`unlink` for a name not in `StatusPoller.players`: dropped, each kind logged once per start. `seq` gaps (and going back) are logged; the baseline is the mod's `hello` datagram, asked for with `/orrery-hello` once per start after the gate opens and RCON answers (`rconUp`); one that doesn't come within 5 s is logged. Emits `chat`, `join`, `leave` (no `reason` on the wire), `death` (`deathMessage`: "Alice was killed by Bob", "… by a medium biter", "Alice died"), `milestone` and `link` (`uuid` `""`), `unlink`, within `EventBudget`: 5 a second sustained and 30 at once, all kinds together (a cell-rate check on a monotonic clock), so a chat flood can never push the game connection past the hub's 20 lines a second, which it closes after 10 s; only events count, not the hello or a dropped datagram. One over the budget is dropped (its `seq` still taken, so no gap is logged) and counted: the first drop starts a minute, at whose end one line logs the count (`stop` logs what is counted). `toCommand`: `say`, `notice`, `linkResult` as `/orrery-say {author, message, source}`, `/orrery-notice {message}`, `/orrery-reply {player, ok, message}`, the argument `commandJson` (`JSON.stringify`, plus `\u` escapes for DEL, the C1 controls and U+2028/9): one line, never Lua. `toGame` runs one and logs a failure or a reply that is not `{"ok":true, …}`. |
| `src/service.ts` | The server's unit. `ServiceWatch`: `systemctl show --timestamp=unix --property=ActiveState,SubState,Result,StateChangeTimestamp -- <unit>` every 5 s, through `execFile` (no shell); `change` with `{ unit, active, sub, since, result }` on the first reading and each change (`since` in epoch ms, 0 if the unit never changed state); a failed read keeps the last state, logged once; `read` for a fresh reading (a restore's check). `act(verb)`: `systemctl <start\|stop\|restart> --no-block -- <unit>` on its own configured unit only (`actArgs`; nothing from the request but the verb), then `stopping` for a stop or restart systemctl took; a refusal (polkit) rejects with its message. `RunWatch`, the stopping rule for changes the agent didn't start: a run (active since one change time) ends at `inactive`, `failed` or `activating` with an `auto-restart*` SubState, `Result` `success` meaning stopped and anything else crashed; `deactivating` alone decides nothing (a Quadlet unit passes `deactivating (stop-post)` on a crash too); a change time that moved while active (a restart between two readings) ends the run with the `Result` read then (a crash can't: its auto-restart waits 10 s in `activating`). |
| `src/logs.ts` | `Logs`, the logs the hub may read, by fixed name only (a name from the hub is looked up in the list, never joined into a path): `list` (`logs`: each of `factorio-current.log` and `factorio-previous.log` in the server's data folder and `agent.log` in the agent's, `{ name, size, modified }`, if there as a regular file); `log(name)` (its last 1000 lines); `journal(unit)` (the last 200 lines of the unit's own log file: `factorio-current.log` for the server's unit, `agent.log` for `orrery-agent.service`; any other unit refused, since the agent's user may not read the system journal). Read through `files.ts`, cut by `replyLines`. `redact` strips every URL's query string (and fragment). `AgentLog`, `<root>/agent.log`: a line per entry with its time, redacted, renamed to `agent.log.1` past 4 MiB; `logTo` sends `console.log`/`info`/`warn`/`error` through `redact` to the journal and it. |
| `src/saves.ts` | `Saves`, Factorio's `saves/` as Backups. Every operation goes through the folder opened once (`O_DIRECTORY`, `O_NOFOLLOW`) as `/proc/self/fd/<fd>/<name>`, since the container could swap `saves/` for a symlink; a file counts only if `lstat` finds a regular file on that folder's filesystem. `list`: every `*.zip` but a name with a control character (not `printable`: a newline in one would forge a log line), newest first, 500 at most, its `kind` (`kindOf`: `orrery-<time>.zip` and `orrery-pre-update-<X.Y.Z>-<time>.zip` `named`, `_autosave*` `auto`, the rest `world`) and `current` on the file whose path the last `Loading map <path>: <n> bytes.` engine line in `factorio-current.log` (its first 1 MiB) names (`loadedMap`: a mod's `log()` line can't match), with the bytes free there; `refresh` (every 10 s, and after its own changes) emits `saves` when the list changed. `save`: `/orrery-save orrery-<UTC time>` (`stamp`, `20261031T120000Z`), then waits until the file is a regular file whose size and time held 5 s, 5 minutes at most (an `RconTimeout` from a big map's save still waits for the file), and emits `backup { ok, detail }`; one at a time (a second does nothing). `played` (each RCON answer) makes one 6 h after the last named save (the newest there, or the agent's start) once anyone played since. `prune` (after each save and restore): the newest 20 named and 3 world files stay, never the current world nor a name `hold` keeps for a running update (`release`; for release 2, nothing calls them yet); autosaves are Factorio's. `restore(name)`: only a listed name, only while a fresh `systemctl show` says inactive or failed; copies from the source opened `O_NOFOLLOW`/`O_NONBLOCK` to a new `restored-<time>-<name>` (`O_CREAT`/`O_EXCL`: never over a file), its time 2 s past every other file's (or now if later), so `--start-server-load-latest` loads it next. The constants (6 h, 20, 3, 5 s, 5 minutes) are not settings. |
| `src/files.ts` | Files the container writes: `openPlain` (`O_NOFOLLOW`, `O_NONBLOCK`; only a regular file on its folder's device, read from the handle), `head` (its first bytes) and `tail` (its last lines, read back from the end, 4 MiB at most). |
| `src/host.ts` | `HostSampler`: the hub's `HostSample` from this machine: CPU use between two `/proc/stat` readings (the first call only takes the baseline), `/proc/loadavg`, memory used and total from `/proc/meminfo` (`MemTotal` less `MemAvailable`) and `statfs` free and total on each configured mount (one that can't be read is left out, logged). The readers (`HostReaders`) are injectable for tests. |
| `src/check.ts` | `check`, the first-boot report: the config and secrets, a host sample, `/orrery-status` over RCON (retried for up to 5 minutes, factorio.service's start timeout, since Factorio may still be loading the map; the game's version and every loaded mod, its name `printable`, since setup prints the report on a root terminal), and a TCP connect to the hub (a warning only, for setup's `--no-hub`). True when all but the hub passed. |
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
- `serviceAct` acts on the agent's own configured unit only: the verb is all it takes from the request, and systemctl
  runs through `execFile` with `--no-block --` before the unit, never a shell.
- What the agent deletes or writes in `saves/` (pruning, a restored copy) goes through that folder opened once without
  following a symlink, so a `saves/` the container swapped for a link can't point it elsewhere. A restore copies from
  the open handle of a listed regular file, only while the unit is stopped, and never overwrites a file.
- Everything the agent logs, to the journal and `agent.log`, has URL query strings stripped (`redact`): a signed
  download link's credentials never reach a log.
- Whatever RCON or a container-written file puts in a line the agent logs or reports (a reply, a save or mod name, a
  log line) is `printable` first, and a save or player name that isn't is dropped: it can neither forge a line of
  `agent.log` nor drive the terminal that shows the first-boot report.

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
  stall and, with no unit state known, closed when RCON is gone (with `StatusPoller` and fake RCON); heartbeats; `bye` and both closes on `stop`; a line over 1 MiB closes cleanly and
  reconnects; invalid, unknown and unsupported requests answered `ok: false` by id.
- `test/events.test.ts`: `GameEvents` with UDP injected from Factorio's port and from a stranger's: wrong source port,
  oversize and closed-gate datagrams dropped; the log check (no line or a forged chat or `log()` line: off at the
  deadline, logged once; the failure line: off at once; the next start: on; a previous run's log not read); `link`
  for an offline name dropped, `link` with `uuid ""`; `seq` gaps and the hello baseline; `/orrery-hello` once per
  start; the event budget (200 chat events in 1 s: 30 at once, then 5 a second, the rest in one log line a minute with
  the count; one event a second all forwarded; with a fake clock and mock timers) and a flood through `GameEvents` (a
  frozen clock: 200 datagrams give 30, a second later 10 give 5, no seq gap logged, the count at `stop`);
  `parseDatagram` against the hub's `parseModLine`; RCON strings escaped (`toCommand`); end to end with the fake
  hub and fake RCON, the hub's `say`, `notice` and `linkResult` as commands in order, and a link datagram reaching
  the hub.
- `test/index.test.ts`: `src/index.ts` as a child process, with a temp config, a fake `systemctl` first on `PATH`,
  the fake hub and fake RCON: both connections, the saves pushed, `started`, a `serviceAct` restart as
  `restart --no-block -- factorio.service` with `stopping` first, `agent.log` written, then `bye` on SIGTERM and exit
  0; offline with no hub, then connecting when it listens; `check` (a mod name's escape sequences printed as `?`).
- `test/service.test.ts`: with `fakeSystemctl` (`test/fake-systemctl.ts`: first on `PATH`; `show` prints the state a
  test sets, other calls are recorded, or refused like polkit), a real `ServiceWatch` and `HubClient` against the fake
  hub: `serviceAct` argv exactly `[verb, '--no-block', '--', 'factorio.service']` whatever else the request carries,
  a refusal answered `ok: false`; `stopping` only for a stop the agent started (and no new game connection while the old
  Factorio still answers), another stop waiting for the final state (`deactivating` decides nothing), a crash through
  `deactivating (stop-post)` to `auto-restart`, and `failed`, closed with no `stopping`; `RunWatch`'s sequences;
  `parseShow` and the watch itself.
- `test/hub.test.ts` also: `started` once per run, kept across a new agent on the same run, again after a restart
  between readings (with `stopping` for the old run); no game connection while the unit isn't active; a console `cmd`
  answered by `cmdResult` (also when refused or when RCON fails); the saves list on each connect and change; `save`
  and `backup` on the game connection.
- `test/logs.test.ts`: the three names listed only as regular files (a symlink or a FIFO in their place is neither
  listed nor read); names outside the list refused; the last 1000 and 200 lines, long lines cut and the oldest dropped
  to fit the hub's reply limits (checked with its `parseReplyData`); `agent.log` with times, query strings stripped
  (in the journal too), rotated.
- `test/saves.test.ts`: names, kinds and `loadedMap` (a mod's `log()` line can't name the map); the list with kinds,
  newest first, the current world, symlinks and folders left out, a swapped `saves/` refused; a name with a control
  character (a forged log line) never listed, pruned or restored; `saves` pushed on change
  only; the 6 h save only after play (a fake clock); pruning keeps 20 named and 3 world files, the current world and a
  held save; restore refused while active (the fake systemctl on `PATH`), for a symlinked or unlisted save, copying
  without overwriting and stamped newest (2 s past a file ahead of the clock or one under 2 s behind it, else now); a save that never appears (or keeps growing) fails after the bounded wait;
  one save at a time, an RCON timeout still waiting for the file.
- `test/status.test.ts` (UPS, paused from players, `tick_paused` and Δtick, untrusted replies (a name with a control character dropped), `auto_pause` from
  symlinks and FIFOs, the poller's `status`, `stalled` and `down`), `test/host.test.ts` (a real sample the hub accepts),
  `test/config.test.ts`, `test/wire.test.ts` (the constants against the hub's; `printable`, also in command output and log lines); `test/rcon.test.ts` also covers
  `RconSession` (one connection, in order, a new one after a timeout or a closed server).

Keep timing-sensitive tests on small timeouts, not sleeps of seconds; stop every poller and client in `t.after`.
Times are relative to `Date.now()` (or a fake clock), never a fixed date, so no test turns red on a later day. A
test never races a timer of the code's: it waits for what the code shows (a message, a log line), gives a timer it
must not see fire a wide margin, and asserts only lower bounds on how long a timer took (a busy machine makes timers
late, never early).

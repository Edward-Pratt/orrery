# Factorio facts checked on a local x64 server (2026-10-31)

Local note, not committed. Facts the agent design depends on, checked by experiment on Factorio 2.1.24 x64.
Paths under /tmp below are from the session that ran it and are gone now.


# Factorio 2.1 headless smoke test (orrery)

- **Version tested:** Factorio 2.1.24 (build 87808, linux64, headless). `--version` prints `Version: 2.1.24 (build 87808, linux64, headless)`. The server banner says `Factorio 2.1.24 (build 87808, linux64, headless, space-age)`.
- **Download:**
  - `https://factorio.com/api/latest-releases` gave stable headless = 2.1.24.
  - `https://www.factorio.com/get-download/2.1.24/headless/linux64` redirected to `factorio-headless_linux_2.1.24.tar.xz` (58.4 MB). No credentials were needed.
  - Its sha256 is `c49b66cff90aceff87b30f2973af0df7f51712cb2ee3153e0169d9bed46a964f`. That matches the line in `https://www.factorio.com/download/sha256sums/`.
  - The x64 file name uses `linux`, not `linux64`. The binary is `factorio/bin/x64/factorio`.
- **Platform:** Arch Linux x86_64 with glibc, on a Ryzen 9800X3D. **ARM64 behaviour is not covered.**
- **Scope:** the server ran with 0 players all through the tests. No game client joined, so nothing a player sees in-game was tested.
- **Ports:**
  - Game UDP 41197 (`--bind 127.0.0.1`).
  - RCON TCP `127.0.0.1:41198`.
  - `--enable-lua-udp 41199`.
  - Node UDP listener on 41200.
- **Cleanup:** every server was stopped by PID at the end. `pgrep` shows no factorio, supervisor or listener process left.

## Files

All files are under /tmp/claude-1000/-home-edward-ClaudeCode-orrery/4d26516d-04ff-497c-82e8-414b01aec369/scratchpad/smoke/:

- `game/x/factorio/`: the extracted tarball, unchanged.
- `scripts/rcon.mjs`: a Source RCON client.
  - It reads each packet by its int32 size field, so it handles bodies split over many TCP reads.
  - It matches packets to commands by id.
  - `--full` prints whole bodies.
- `scripts/udp.mjs`: a UDP listener that logs each datagram as a JSON line.
- `scripts/supervisor.mjs`: starts factorio and handles its I/O.
  - Logs stdout and stderr together to `run/<tag>.out`.
  - Forwards the FIFO `run/<tag>.stdin` to the server's stdin.
  - Writes `run/<tag>.pid` and `run/<tag>.exit` (`{code, signal}`).
- `scripts/start.sh <tag>`: loads the latest save with `auto_pause: true` and Lua UDP on.
- `scripts/start2.sh <tag> <settings> <args>`: generic launcher; the caller passes the load and UDP flags.
- `run/config/config.ini`: sets `write-data` to `run/data`, so saves go to `run/data/saves`.
- `run/mods/orrerytest/{info.json,control.lua}`: the test mod (`factorio_version` "2.1", depends on `base`). It loaded fine: `Checksum for script __orrerytest__/control.lua`.
- `run/server-settings.json`: `auto_pause: true`, `visibility` public and lan false, `require_user_verification` false.
- `run/server-settings-nopause.json`: the same with `auto_pause: false`.
- `run/s1.out` .. `run/s12.out`: full server output for each run.
- `run/s13.stdout` and `run/s13.stderr`: one server run with the streams split.

Server start command (from `scripts/start.sh`):

```
factorio --config run/config/config.ini --mod-directory run/mods --start-server-load-latest \
  --server-settings run/server-settings.json --port 41197 --bind 127.0.0.1 \
  --rcon-bind 127.0.0.1:41198 --rcon-password <random> --enable-lua-udp 41199
```

The map was created with `factorio --config ... --mod-directory run/mods --create run/data/saves/smoke1.zip`. It took 0.7 s, exited 0, and `on_init` ran.

**General output facts (VERIFIED):**
- **All output goes to stdout.** stderr was empty in a `--create` run and in a whole server run (`s13`: 69 stdout lines, 0 stderr lines). That run covered startup, RCON, chat, `/sc` and a SIGINT shutdown.
- Lua `print("X")` appears raw on stdout.
- `log("X")` appears on stdout as `   7.943 Script @__orrerytest__/control.lua:1: X`, and also in `factorio-current.log`.
- Chat-style lines carry a wall-clock stamp and a tag: `2026-10-31 00:09:57 [CHAT] <server>: ...`.
- Engine lines carry seconds since start: `   0.210 Info RemoteCommandProcessor.cpp:119: Starting RCON interface at IP ADDR:({127.0.0.1:41198})`.
- Each RCON connection logs `Info RemoteCommandProcessor.cpp:236: New RCON connection from IP ADDR:({127.0.0.1:37794})`.
- A wrong RCON password gets an auth reply (type 2) with id -1.

---

## 1. RCON while auto-paused with 0 players

| Question | Verdict |
|---|---|
| RCON connects and answers a mod command | **VERIFIED-TRUE** |
| `game.tick` advances with wall-clock time | **VERIFIED-FALSE**: it advances by exactly 1 per RCON command, not with time |
| `game.tick_paused` is set | **VERIFIED-FALSE**: it stays `false` |

Evidence (run `s1`, `auto_pause: true`, 0 players):

```
00:09:12  /orrery-ping -> "tick":10,"ticks_played":10
00:09:17  /orrery-ping -> "tick":11,"ticks_played":11
3 pings in one connection -> tick 12, 13, 14
{"player_index":"nil","tick":1,"ticks_played":1,"tick_paused":false,"console_command_used":false,"players":0,"speed":1}
```

- The server runs one game tick to process each incoming command, then stays paused. `ticks_played` behaves the same way.
- Every reply arrived; none was dropped while paused.
- With `auto_pause: false` (run `s8`), tick went from 59 to 422 in about 6 s, so about 60 UPS. The `on_nth_tick(60)` UDP heartbeat arrived once a second (`tick 360`, `tick 420`).

## 2. Mod command over RCON

| Question | Verdict |
|---|---|
| `e.player_index` is nil for an RCON-issued `commands.add_command` command | **VERIFIED-TRUE** |
| `rcon.print` returns the text to the RCON client | **VERIFIED-TRUE** |
| Mod commands flag the save (`game.console_command_used`) | **VERIFIED-FALSE**: it stayed `false` after about 40 mod commands over several runs |
| Mod commands log a warning | **VERIFIED-FALSE**: none |
| `/silent-command` flags the save | **VERIFIED-TRUE** |

Evidence:
- The handler logged `ORRERYTEST ping player_index=nil tick=0`.
- `on_console_command` **also fires for mod commands**: `on_console_command pi=nil cmd=orrery-ping param=`.
- **`/silent-command` on an unflagged save** (run `s9`, the throwaway save):
  - The **first** attempt does not run. The RCON reply is empty, and stdout shows:
    ```
    2026-10-31 00:13:50 [WARNING] Player <server> tried using the command "rcon.print(game.tick)".
    2026-10-31 00:13:50 [WARNING] Using Lua console commands will disable achievements. Please repeat the command to proceed.
    ```
  - The repeated command runs and replies `1039`.
  - After that, `game.console_command_used` = `true`. Both `/orrery-ping` and `/sc rcon.print(game.console_command_used)` show it.
- `/c` logs `[COMMAND] <server> (command): rcon.print('c-cmd')`. A confirmed `/silent-command` logs nothing.
- On a save that was already flagged (run `s12`), `/sc` printed no warning lines.
- A runtime error inside `/sc` does not crash the server. The reply is `Cannot execute command. Error: ...`, and the error is not written to stdout.

**Critical finding: an uncaught Lua error in a mod command handler crashes the server.** VERIFIED-TRUE (run `s8`):

```
15.004 Error MainLoop.cpp:1505: Exception at tick 929: Error while running command "orrery-lab": LuaTechnology doesn't contain key research_trigger.
15.004 Error ServerMultiplayerManager.cpp:85: MultiplayerManager failed: "Error while running command "orrery-lab": ...
15.021 Quitting: multiplayer error.
```

- The exit code was **255** and **no save** was written.
- The RCON client got no reply, and later connections were refused.
- In 2.1 the research trigger is on `tech.prototype.research_trigger`; `LuaTechnology.research_trigger` does not exist.

## 3. Reply size

**VERIFIED-TRUE:** the client received a whole 100 KB reply, and also whole 1 MB and 5 MB replies.

```
/orrery-big 100000   -> packets [{id:101,type:0,len:100009}]   BEGIN...END\n
/orrery-big 1000000  -> packets [{id:102,type:0,len:1000009}]
/orrery-big 5000000  -> packets [{id:103,type:0,len:5000009}]
```

- **Factorio sends one RCON packet per command, whatever its size.** The int32 size field holds the full length; there is no Source-style split at 4096 bytes. The packet spans many TCP reads.
- Several `rcon.print` calls in one command arrive as one packet, joined by `\n`: `"line1\nline2\nline3\n"`.
- Every reply ends with `\n`.
- A command that prints nothing still gets one empty type-0 reply with its id. Examples: plain chat, `/shout`, an unconfirmed `/sc`.
- An empty type-0 "sentinel" packet sent to Factorio gets no answer; the client timed out after 15 s.

## 4. `helpers.send_udp` and `--enable-lua-udp`

| Question | Verdict |
|---|---|
| `helpers.send_udp(port, data, 0)` from a command arrives at a Node listener | **VERIFIED-TRUE** |
| Same from `on_nth_tick` | **VERIFIED-TRUE**, while the game is not paused |
| What `--enable-lua-udp <port>` means | **VERIFIED:** it is the local port Factorio binds for Lua UDP |
| Error when nothing listens on the target port | **VERIFIED-FALSE**: no Lua error and no log line |

- **The flag:** `--enable-lua-udp 41199` logs `Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({127.0.0.1:41199}))`. This is Factorio's own socket, bound on 127.0.0.1.
  - It is the source port of every `send_udp` datagram; the listener saw `"from":41199`.
  - It is also the port `recv_udp` reads from.
  - The destination is the `port` argument of `send_udp`.
- Sample datagrams from `run/udp.log`: `{"from":41199,"len":18,"data":"hello-from-command"}` and `{"from":41199,"len":8,"data":"tick 120"}`.
- **Edge cases.** All ran under `pcall`. None raised a Lua error; every call returned `send_udp ok=true err=nil`.
  - **No listener on the target port (41250):** nothing is logged and nothing is raised.
  - **60,000-byte payload:** arrived whole (`"len":60000`).
  - **70,000-byte payload:** not sent. The log shows `Warning UDPSocket.cpp:435: Sendto failed: Message too long, Message size: 70000` and `Warning LuaHelpersObject.cpp:218: helpers.send_udp error: Sendto failed: Message too long`.
  - **Port 0:** logs `Warning UDPSocket.cpp:425: Sendto failed: Invalid argument`.
  - **Without `--enable-lua-udp`** (run `s10`): `send_udp` and `recv_udp` silently do nothing. There is no error, no log line and no datagram, and the heartbeat stops too.
  - **Lua UDP port already in use** (run `s11`): the log shows `Warning Game.cpp:73: Opening Lua UDP Socket failed: Binding IPv4 socket failed: Address already in use`.
    - The server **keeps running**, and `send_udp` then silently does nothing.
    - The crash seen in 2.0.60 does not happen in 2.1.24.
- **Inbound** (run `s8`): Node sent `inbound-hello` to 127.0.0.1:41199, then `/orrery-recv` called `helpers.recv_udp()`. That raised `on_udp_packet_received payload=inbound-hello source_port=39731 player_index=0`. `source_port` is the sender's ephemeral port.
- `storage.udp_port`, set in one run, persisted in the save, and the heartbeat resumed after a reload.

## 5. `on_console_chat`

| Question | Verdict |
|---|---|
| `game.print` from an RCON command raises `on_console_chat` | **VERIFIED-FALSE** |
| Plain non-slash text over RCON raises `on_console_chat` | **VERIFIED-TRUE**, with `player_index` = nil |

Evidence (run `s1`):

```
/orrery-say hi from game.print   -> reply "printed"; no on_console_chat; NO stdout line at all for game.print
plain text over rcon             -> 2026-10-31 00:09:57 [CHAT] <server>: plain text over rcon
                                    on_console_chat {"player_index":"nil","message":"plain text over rcon","tick":26}
/shout shouted                   -> 2026-10-31 00:09:57 [SHOUT] <server> (shout): shouted   (on_console_command only)
```

- `game.print` text is not written to the server's stdout. The `<server>` label is verified only on the server's stdout. What a joined client sees was not tested.

## 6. Saving

| Question | Verdict |
|---|---|
| `game.server_save('name')` from an RCON command writes `saves/name.zip` | **VERIFIED-TRUE**, for a name with no dot: Factorio replaces whatever follows the last `.` with `.zip` (`e2etest-x.y` gives `e2etest-x.zip`; found by the release-2 e2e loop, 2026-11-01, fixed in `b083aad`) |
| `/server-save <name>` is valid in 2.1 | **VERIFIED-TRUE** |

Evidence (run `s1`, a 630 KB map):

```
132.943 ... cmd=orrery-save param=fromlua
132.960 Info AppManager.cpp:424: Saving game as .../run/data/saves/fromlua
132.993 Info AppManagerStates.cpp:2131: Saving finished
/server-save fromcmd -> reply "Saving the map"; "Saving game as .../saves/fromcmd" ... "Saving finished"
/server-save         -> saves over the currently loaded save (smoke1.zip)
```

- **Timing:** `Saving game as` comes about 17 ms after the command's log line, and `Saving finished` about 33 ms later. The save is synchronous within the command's tick on this map. The RCON reply's arrival time was not logged, and large maps will take longer.
- **No argument:** `game.server_save()` overwrites the currently loaded save (`smoke1.zip`, run `s2`).
- **Explicit `nil`:** `game.server_save(nil)` raises `bad argument #2 of 2 to '?' (string expected, got nil)`.
- **Autosave names:** `game.server_save('_autosave9')` was **accepted** and wrote `_autosave9.zip`.

## 7. Signals

| Signal | Saves? | Exit code | Time |
|---|---|---|---|
| SIGINT | **VERIFIED-TRUE**, to the loaded save file | **0** | about 0.5 s |
| SIGTERM | **VERIFIED-TRUE**, same | **0** | about 0.5 s |
| SIGKILL | no | Node parent sees `{"code":null,"signal":"SIGKILL"}`; bash `wait` gives **137** | immediate |
| Lua error in a mod command (extra) | no | **255** | |

SIGINT log. SIGTERM gives the same lines, except the first reads `Received SIGTERM, shutting down`.

```
149.969 Received SIGINT, shutting down
149.969 Quitting: signal.
149.969 Info MainLoop.cpp:447: Saving map as .../run/data/saves/smoke1.zip
149.978 Info MainLoop.cpp:458: Saving progress: 0.250000%
149.979 Info MainLoop.cpp:458: Saving progress: 100.000000%
149.985 Info ServerMultiplayerManager.cpp:120: Disconnecting multiplayer connection.
...
150.051 Info ServerMultiplayerManager.cpp:147: Quitting multiplayer connection.
150.436 Goodbye
```

- The shutdown save goes to the file that was loaded. For example, a server loaded from `_autosave9.zip` logged `Saving map as _autosave9.zip`.

## 8. `--start-server-load-latest`

**VERIFIED-TRUE: the save with the newest mtime in `saves/` loads, autosaves included.**

- `touch fromlua.zip`, then restart: `Loading map .../saves/fromlua.zip: 637539 bytes.`
- `touch _autosave9.zip` (2 s later), then restart: `Loading map .../saves/_autosave9.zip: 637945 bytes.`
- `touch fromcmd.zip`, then restart: `Loading map .../saves/fromcmd.zip: 637551 bytes.`
- **INCONCLUSIVE:** one attempt with less than 1 s between the two mtimes loaded the other file. Near-ties may resolve at 1 s granularity.
- The line to parse is `Loading map <absolute path>: <bytes> bytes.`

## 9. Research event and status API

| Question | Verdict |
|---|---|
| `on_research_finished` fires for scripted research | **VERIFIED-TRUE** |
| `by_script` for `tech.researched = true` | **VERIFIED:** `true` |
| `by_script` for real lab research | **VERIFIED:** `false` |

- `tech.researched = true` gave `on_research_finished automation by_script=true`.
- `tech.research_recursive()` on `logistics-2` fired **once per newly researched technology**: 6 events, all `by_script=true`. They were electronics, steam-power, automation-science-pack, logistic-science-pack, logistics and logistics-2.
- Real lab research gave `on_research_finished electric-mining-drill by_script=false`.
  - Setup: `auto_pause: false`, a script-built lab, an electric-energy-interface and a pole, then `force.add_research`.

Status API names that work in 2.1.24 (reply of `/orrery-status`, all VERIFIED):

```
{"active_mods":{"base":"2.1.24","orrerytest":"0.0.1"},"base_version":"2.1.24","tick":2,"tick_paused":false,"speed":1,
 "players_online":{},"player_count":0,"surfaces":[{"name":"nauvis","index":1,"planet":"nauvis"}],
 "planets":[{"name":"nauvis","generated":true}],"rockets":0,"evolution":0,"console_command_used":false}
```

- **Game version:** `helpers.game_version` gives `"2.1.24"`. `script.active_mods.base` gives the same.
- **Mods:** `script.active_mods`, a table from mod name to version. `game.active_mods` does not exist (`pcall` returns false).
- **Players:** `game.connected_players` is an array of players online. `#game.players` gives the total.
- **Surfaces:** `#game.surfaces` returns `1`.
  - Iterate with `pairs(game.surfaces)` and read `s.name`, `s.index`, `s.planet` (a LuaPlanet or nil; use `.name`) and `s.platform`.
- **Planets:** `table_size(game.planets)` **errors**: `bad argument #2 of 2 to 'table_size' (table expected, got userdata)`.
  - Iterate with `pairs(game.planets)` instead. `p.surface ~= nil` means the planet is generated.
  - Without Space Age, only `nauvis` exists.
- **Also working:** `game.tick`, `game.ticks_played`, `game.tick_paused`, `game.speed`, `game.forces.player.rockets_launched`, `game.forces.enemy.get_evolution_factor("nauvis")`, `game.forces.player.current_research`, `game.console_command_used` and `helpers.table_to_json`.
- `table_to_json` serializes an empty Lua table as `{}`, not `[]` (`"players_online":{}`).

## 10. Server console (stdin)

**VERIFIED-TRUE:** text typed on stdin raises `on_console_chat` with `player_index` = nil.

```
echo 'typed on stdin console' > run/s2.stdin
2026-10-31 00:10:52 [CHAT] <server>: typed on stdin console
ORRERYTEST on_console_chat {"player_index":"nil","message":"typed on stdin console","tick":38}
```

- Slash commands on stdin also run with `player_index` = nil; `/orrery-ping` from stdin ran.
- `rcon.print` output from a stdin command goes nowhere.

## Not tested

- **INCONCLUSIVE:** whether join and leave lines are prepended to replies with packet id 0. This needs a real player. The client used ids 1 and 101 and up.
- **INCONCLUSIVE:** what joined players see for `<server>` chat and for `game.print`, and whether clients auto-download the mod. No client was used.
- **INCONCLUSIVE:** whether `on_player_changed_surface` fires on remote view, and anything specific to Space Age. Space Age was disabled in `mod-list.json`.
- **Not covered:** ARM64 and glibc 2.38 behaviour. Only x86_64 was tested.
- **Not measured:** RCON round-trip latency. The `ms` values include the client's 400 ms idle wait. Server timestamps show each command running within about 15 ms of `New RCON connection`.

## Implications for the design

1. **Wrap every mod command handler and event handler in `pcall`.** One uncaught error kills the server with exit 255 and **no save**, so all progress since the last save is lost. Report the error as JSON through `rcon.print` instead.
2. **RCON works while paused.** The agent can poll `/orrery-status` with 0 players.
   - Each poll advances the map one tick. That is harmless, but `game.tick` cannot measure UPS while paused.
   - Compute UPS only when `#game.connected_players > 0`, or when `auto_pause` is false.
   - Report "paused (0 players)" from the player count, because `tick_paused` stays false under auto-pause.
   - Do not expect `on_tick` or `on_nth_tick` heartbeats while paused.
3. **Mod commands are the right RCON surface.**
   - `player_index` is nil for RCON and stdin, so the guard `if e.player_index ~= nil then return end` works.
   - Mod commands do not set `console_command_used`.
   - **The agent must never use `/sc` or `/c`.** On an unflagged save the first one is refused with an empty reply and the "Please repeat the command" warning. The repeat runs and flags the save permanently.
4. **RCON client.**
   - Expect one reply packet per command, of any size (tested up to 5 MB).
   - Read the int32 size field and buffer across TCP reads. Do not cap packets at 4096 bytes.
   - Match each reply to its request by id.
   - Do not send empty type-0 sentinels; Factorio ignores them.
   - Strip the trailing `\n`.
   - Treat a socket that closes with no reply as "server crashed or stopped".
5. **Discord-to-game chat: use a mod command that calls `game.print`** with `skip = never`.
   - It does not raise `on_console_chat`, so a message cannot echo back to Discord.
   - It also writes nothing to the server's stdout. If the hub needs a record, the mod should send one over UDP too.
   - Plain RCON text and stdin text both raise `on_console_chat` with nil `player_index`. Drop chat events with nil `player_index` in the mod.
6. **Mod-to-agent channel: `send_udp` works, but its failures are silent.**
   - A missing flag, a port clash or no listener all produce no Lua error. Only the clash and the oversize cases log a `Warning`.
   - At startup, the agent should check stdout for `Opening Lua UDP Socket failed`.
   - The agent should expect a heartbeat while unpaused, and alarm when it stops.
   - Keep payloads well under 64 KB: 60,000 bytes worked and 70,000 bytes failed with only a log warning. About 1 KB per event is a sensible target.
   - The datagram's source port is the `--enable-lua-udp` port, so the agent can filter senders by it.
   - A target port kept in `storage` stays in the save.
7. **Backups.**
   - Send `/orrery-save <name>` (which calls `game.server_save(name)`) or `/server-save <name>`.
   - Wait for `Saving finished` on stdout, then copy `saves/<name>.zip`.
   - Avoid names that start with `_autosave`, even though Lua accepts them.
   - `game.server_save()` with no argument overwrites the loaded save. Passing `nil` explicitly raises an error.
8. **systemd.**
   - SIGTERM (the systemd default) and SIGINT both save to the loaded file and exit 0, in about 0.5 s on a small map. So `KillSignal=SIGINT` is optional.
   - Keep a generous `TimeoutStopSec` for large maps.
   - Exit codes:
     - 0: clean stop.
     - 255: Lua or multiplayer error, no save. Treat it as a crash and alert.
     - 137 (SIGKILL): killed, no save.
   - `Restart=on-failure` covers the crash case.
9. **Which save loads.** `--start-server-load-latest` picks the newest mtime, **including `_autosaveN` files**.
   - Any copy, restore or `touch` in `saves/` changes what loads next.
   - A restore must make the restored file's mtime newest by at least 1 s, or start with `--start-server <file>`.
   - The loaded file is in the log line `Loading map <path>: <bytes> bytes.`.
10. **Status command API.**
    - Use `helpers.game_version`, `script.active_mods` and `game.connected_players`.
    - Use `pairs(game.surfaces)` with `.planet` and `.platform`.
    - Use `pairs(game.planets)` with `.surface`; `table_size` fails on this userdata.
    - Also use `game.tick`, `game.ticks_played`, `game.speed`, `force.rockets_launched` and `enemy.get_evolution_factor(surface)`.
    - Empty tables serialize as `{}`.
    - The 2.1 trigger-tech check is `tech.prototype.research_trigger`.
11. **Research announcements:** skip events with `by_script == true`.
    - `research_recursive` fires one event for each technology it completes.
    - Real lab research gives `by_script=false`.
12. **Stdout parsing.** All output is on stdout, including Lua `print` and `log`.
    - Chat lines look like `YYYY-MM-DD HH:MM:SS [CHAT] <name>: msg`. The tags `[SHOUT]`, `[COMMAND]` and `[WARNING]` were also seen.
    - Engine lines use seconds since start.
    - Prefer the UDP channel to parsing these lines.

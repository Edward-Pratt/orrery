# factorio (orrery)

The Factorio mod `orrery`: control-only Lua that connects a Factorio 2.1 server to orrery, through the agent on the
server's Host. It is published on the Factorio mod portal as `orrery`. The design is the Factorio agent note; this
file is the contract between the mod and the agent.

| File | Job |
|---|---|
| `info.json` | `name` `orrery`, `factorio_version` `2.1`, `dependencies` `base` and `? space-age` (optional, only for load order). |
| `control.lua` | The commands, the event handlers and `storage`. |
| `locale/en/orrery.cfg` | The mod's name and description, the command help texts, the two lines a player sees from `/orrery-link`. |
| `changelog.txt` | The portal's strict format: a line of 99 `-`, `Version: X.Y.Z`, two-space categories, four-space `- ` entries. |

## Releases

- `info.json` keeps `version` at `0.0.0`. The release writes the real one into the zip's copy, from the
  `factorio-vX.Y.Z` tag (`.github/factorio-zip.sh`; CI zips the newest `factorio-v*` tag's version).
- `changelog.txt` is not rewritten: before cutting a tag, make its top section's `Version:` the version the tag will
  get (`release.sh` prints it), and add a section per release.
- The zip is `orrery_<version>.zip` with the single top folder `orrery_<version>/`, the portal's layout. This
  `CLAUDE.md` is left out of it; everything else in this folder ships, so keep test files and notes elsewhere.
  `bash .github/test-release.sh` tests the script.
- Cut a release with `.github/release.sh factorio <major|minor|patch>`; `release.yml` attaches the zip to the
  GitHub release, then `.github/factorio-publish.sh` puts it on the mod portal as `orrery` with the
  `FACTORIO_API_KEY` repo secret (the first `factorio-v*` tag claims the name). A failed upload leaves the GitHub
  release in place: fix forward with the next patch.
- Every player who joins a server with the mod must download that exact version from the portal, so release
  rarely: batch changes rather than shipping each one.
- A release reaches the server by hand until game updates exist (release 2): `deploy/setup-agent-host.sh` installs the
  newest `factorio-v*` release's zip only when `/srv/factorio/mods` has no `orrery_*.zip`, and keeps one that is there.
  To put a new release on the server, replace the zip in that folder and restart `factorio.service`.

## Rules (do not weaken)

- **Every command and event handler runs in `pcall`.** An uncaught Lua error in a handler ends the server with exit
  255 and no save. A command answers its error as JSON; an event handler `log()`s it and drops the event.
- Commands are registered in the main chunk. `on_init` and `on_configuration_changed` set up and seed `storage`;
  `on_load` does nothing (storage and the game are read-only there).
- The six agent commands refuse a player (`player_index ~= nil`) silently. The two player commands refuse RCON and
  take the name from `game.get_player(player_index).name`, never from the command's text.
- Text from outside (`author`, `message` of `say`, `notice` and `reply`) has its control characters (`\n`, `\r`,
  tab, and the rest of 0x00 to 0x1F and 0x7F) turned into spaces, so it prints as one line and cannot fake a second
  relayed line, then gets U+200B after every `[`, so it never renders as rich text (`[color=…]`, `[img=…]`, `[gps=…]`).
- Chat with no `player_index` (plain text typed on the server console or over RCON) is never sent.
- The mod never uses `/sc` or `/c`, and neither does the agent: on an unflagged save the repeat flags it for good.
- Only use APIs of the 2.1 runtime (https://lua-api.factorio.com/latest/). Factorio's Lua is 5.2: no `utf8`
  library, no integer division operator.

## Mod to agent: UDP

`helpers.send_udp(34199, helpers.table_to_json(evt), 0)`: sent by the server only, to `127.0.0.1:34199`, from
Factorio's `--enable-lua-udp` port (34198 in production). One event per datagram, at most 4096 bytes of JSON. Every
event has `seq`, one more than the last (kept in `storage.seq`, so it is saved with the map and rewinds with it after
a crash or a restore). So after each start the agent sends `/orrery-hello` and takes its `seq` as the baseline.
`table_to_json` writes non-ASCII as raw UTF-8 and control characters as `\u00XX`.

| `t` | fields | when |
|---|---|---|
| `chat` | `player`, `message` | `on_console_chat` with a `player_index` |
| `join` | `player` | `on_player_joined_game` |
| `leave` | `player`, `reason` | `on_player_left_game`; `reason` is the `defines.disconnect_reason` name: `quit`, `dropped`, `reconnect`, `wrong_input`, `desync_limit_reached`, `cannot_keep_up`, `afk`, `kicked`, `kicked_and_deleted`, `banned`, `switching_servers` |
| `death` | `player`, optional `cause`, optional `killer` | `on_player_died`. `cause` is the killing entity's internal name (`medium-biter`, `gun-turret`, `character`, `locomotive`); `killer` is the player of a killing character. Both are left out when unknown. The agent composes the hub's death `message` |
| `milestone` | `kind`, `text`, optional `player`, optional `force` | see below |
| `link` | `player`, `code` | `/orrery-link CODE` by that player; `code` is 1 to 16 letters or digits, as typed |
| `unlink` | `player` | `/orrery-unlink` by that player |
| `hello` | `seq` only | `/orrery-hello` over RCON. Not an event: `seq` is the last event's (0 on a fresh map) and is not used up, so the next event is `seq + 1`. Never counted or gap-checked |

Field caps, in bytes and on a UTF-8 character boundary: `player`, `killer`, `cause` and `force` 64; `message` 1000
(the hub's 1 KiB); `text` 200. If the JSON is still over 4096 bytes (control characters escape to 6 bytes each), the
free-text field (`message` or `text`) is halved until it fits.

`milestone` kinds. `text` is the subject only; the hub writes the sentence. `force` is set only when the force is not
`player`.

| `kind` | when | `text` | `player` |
|---|---|---|---|
| `research` | every `on_research_finished` with `by_script == false` (labs; scripted unlocks, `research_recursive` and console cheats are skipped) | the prettified name, and for a levelled technology the level it finished: `Electric mining drill`, `Logistics 2`, `Mining productivity 5` | no |
| `rocket` | the force's first `on_cargo_pod_finished_ascending` with `launched_by_rocket` | the planet it left, `Nauvis` (empty if unknown) | no |
| `platform` | the force's first `on_space_platform_changed_state` leaving `starter_pack_on_the_way` | the platform's name, as its owner typed it | no |
| `landing` | the force's first player physically on a planet, from `on_cargo_pod_finished_descending` with a `player_index` or `on_player_changed_surface` | the prettified planet, `Vulcanus` | yes |

Prettified names: `-` and `_` become spaces and the first letter is upper case (`mining-productivity` is `Mining
productivity`). A levelled technology is named for its first level (`mining-productivity-3`), so that suffix is
replaced by the finished level; when the event fires, `level` already reads the next level unless the technology is
now `researched` (verified on 2.1.24).

Landings use `player.physical_surface.planet`, so remote view never counts (it changes `player.surface`, not the
physical one), and a platform surface has no planet.

`storage.firsts[force name]` is `{rocket = true, platform = true, landing = {[planet name] = true}}`. Seeding (in
`on_init` and `on_configuration_changed`) only ever adds: `rocket` if `force.rockets_launched > 0`, `platform` if
`next(force.platforms) ~= nil` (`platforms` is keyed by platform index, which counts across forces, so `#` may read
0), `landing.nauvis` for every force, and the planet every player physically stands on. So adding
the mod to an existing save posts no stale firsts.

## Agent to mod: RCON commands

Each answers with one JSON line through `rcon.print` (the RCON reply ends in `\n`). An error is
`{"ok":false,"error":"…"}` and the server keeps running. `table_to_json` writes an empty table as `{}`, so `players`
is `{}`, not `[]`, when nobody is online.

| command | argument | reply |
|---|---|---|
| `/orrery-say {json}` | `{author, message, source}`; `source` `dashboard` prints `[Dashboard] <author> message` in gold, anything else `[Discord] <author> message` in blue, `game.print` with `skip = never` (it raises no `on_console_chat`, so no echo) | `{"ok":true}` |
| `/orrery-notice {json}` | `{message}`, printed to everyone in yellow | `{"ok":true}` |
| `/orrery-reply {json}` | `{player, ok, message}`, printed to that player only as `[Discord] message`, green if `ok` is `true`, else red | `{"ok":true}`; `not online: <player>` if they are not connected |
| `/orrery-status` | none | `{"ok":true, tick, tick_paused, players, version, mods, loaded}`: `game.tick`, `game.tick_paused`, the online players' names, `helpers.game_version`, `script.active_mods` (name to version), and `loaded`, `true` once the mod's `storage` is set up in the loaded map |
| `/orrery-hello` | none | sends the `hello` datagram, then `{"ok":true,"seq":N}` with the same `seq`. Writes nothing to `storage` |
| `/orrery-save <name>` | a plain name: a letter or digit, then letters, digits, `.`, `_`, `-`, at most 100 (so never `_autosave…`); `game.server_save(name)` writes `saves/<name>` with whatever follows its last `.` made `zip` (`a` and `a.zip` → `a.zip`, but `a.b` → `a.zip`, seen on 2.1.24), so the agent sends `<name>.zip` | `{"ok":true,"name":"<name>"}` |

Player commands: `/orrery-link <CODE>` (sends `link`, tells the player "Linking…") and `/orrery-unlink` (sends
`unlink`). Over RCON they answer `{"ok":false,"error":"/orrery-link is for players"}`.

## Testing locally

There is no automated test. `luac -p factorio/control.lua` checks the syntax. Then run a real headless server:

1. Download `https://www.factorio.com/get-download/<version>/headless/linux64` (no credentials) into an empty
   folder, check it against `https://www.factorio.com/download/sha256sums/`, and extract it elsewhere.
2. Make a run folder with `config.ini` (`[path]`, `read-data=<game>/data`, `write-data=<run>/data`), a `mods/`
   folder holding a copy of this folder as `mods/orrery` (without `CLAUDE.md`) and a `mod-list.json` enabling
   `base`, `elevated-rails`, `quality`, `recycler`, `space-age` and `orrery` (the headless server needs no licence
   for Space Age), and a `server-settings.json` from the game's example with `auto_pause` true, `visibility`
   public and lan false, `require_user_verification` false.
3. `factorio --config <run>/config.ini --mod-directory <run>/mods --create <run>/data/saves/world.zip`, then
   `factorio --config … --mod-directory … --start-server-load-latest --server-settings … --port <p> --bind 127.0.0.1
   --rcon-bind 127.0.0.1:<r> --rcon-password <random> --enable-lua-udp <u>`, with a UDP listener on
   `127.0.0.1:34199` (each datagram's source port is `<u>`).
4. Talk RCON with a client that reads one reply packet per command, matched by id, and never sends an empty
   sentinel (Factorio does not answer one). All output, `log()` included, is on stdout; `game.print` text is not.
5. Events need ticks: a server with `auto_pause` on and nobody online runs one tick per RCON command. To try research,
   rockets or platforms by script, use a throwaway copy of the save with `auto_pause` false (`/sc` flags a save for
   good), and expect scripted research to post nothing. Chat, join, leave, death, landings and linking need a
   player client.
6. Stop the server with SIGINT: it saves into the loaded file and exits 0.

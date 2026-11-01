# Factorio: game settings, new worlds and save uploads

Status: design, not built. Date: 2026-11-01. Based on `main` at `48f5a05` (production: `hub-v2.15.0`, `web-v0.13.0`,
`agent-v1.1.1`). Built in two stages, each released on its own: **stage A** (game settings) is complete and buildable
without stage B; **stage B** (new worlds and save uploads) builds on it.

The owner asked for three things on the factorio server an Agent runs:

1. Change its game settings from the dashboard: name, description, max players, game password, user verification,
   autosaves, the idle kick, pausing, Lua commands and the admins. It stays unlisted.
2. Create a new world from map settings (a preset, the seed, resources, terrain, enemies, expansion, peaceful mode,
   the Space Age planets), keeping the current world as a save, and load it.
3. Upload a save (`.zip`) from the dashboard and load it.

Players with a family-shared copy of the game have no factorio.com account, so turning user verification off must be
possible, and the dashboard must say what that costs.

Contents: [Verified for this note](#verified-for-this-note), [Decisions](#decisions),
[Stage A: game settings](#stage-a-game-settings), [Stage B: new worlds and save uploads](#stage-b-new-worlds-and-save-uploads),
[Docs to update with the code](#docs-to-update-with-the-code), [Out of scope](#out-of-scope).

---

## Verified for this note

All on the real Factorio 2.1.24 headless build (x64, Space Age, quality, elevated rails, recycler), RCON on loopback,
nobody on. The research ran in scratch folders that are not kept. The last group was checked on 2026-11-01 while
writing this note.

**server-settings.json**

- The keys are the ones in `data/server-settings.example.json`. Admins aren't in it: they live in
  `--server-adminlist`, and an `admins` key in the settings file is ignored. An unknown key is ignored too.
- Parsing is strict. A bad file makes the server refuse to host, with exit code 1. `factorio.service` has
  `Restart=on-failure` and `RestartSec=10`, so systemd's start limit never trips and a bad file loops forever. Examples:
  - a missing `name`, `description` or `visibility` gives `Key "visibility" not found in property tree at ROOT`;
  - a string where an int belongs gives `Failed to fully parse string to int: 'abc'`;
  - `max_players` -1 gives `Value (-1) outside of range`;
  - `auto_pause` `"yes"` gives `Value must be a bool`;
  - `allow_commands` `"maybe"` gives `Invalid value "maybe" of AllowedCommands`;
  - truncated JSON gives `Unexpected end of file`;
  - `visibility.public` true with `require_user_verification` false gives `require_user_verification must be enabled for public games.`
- `game_password` `""` means no password. `autosave_interval` 0 turns autosave off. `max_players` 0 means no limit.
- `/config set <option> <value>` over RCON is a built-in command, not Lua. Each of these was set and read back with
  `/config get`: name (with UTF-8, quotes and spaces), description (with spaces), tags, max-players (`0` gives `Player
  limit removed.`), password (a bare `/config set password` gives `Server password removed.`, and no password change is
  logged anywhere), require-user-verification, allow-commands (`true`, `false`, `admins-only`), autosave-interval (`0`
  gives `Autosave is now disabled.`), afk-auto-kick (the file's `afk_autokick_interval`; `afk-autokick` gives
  `Unknown config`), only-admins-can-pause and auto-pause-when-players-connect.
- `visibility-public true` is refused while verification is off. The `visibility-lan` and `visibility-public` toggles
  answer oddly (`Unknown key: "true"`, yet `get` then said true). Visibility is not touched live.
- These keys have no `/config` option and take effect only at a restart: `auto_pause` (`Unknown config: auto-pause`),
  `autosave_slots`, `non_blocking_saving`, `minimum_latency_in_ticks`, `max_heartbeats_per_second`, the segment sizes,
  and `username`/`token`.
- **Live changes don't persist.** `/config set` never writes `server-settings.json`. Name, verification and max
  players set live came back as the file's values after a restart. So the file is the source of truth.
- `/promote Bob` and `/demote Alice` over RCON work for names never seen on the server. Factorio at once rewrites
  `server-adminlist.json` (to `["bob"]`, lowercased) and logs `[PROMOTE] Bob was added to the admin list by <server>
  and will be promoted upon joining the game.` The RCON reply is empty. `/admins` over RCON is empty too.
- **New (2026-11-01):** a test mod's command read `game.console_command_used` before and after `/config set name`,
  `description`, `password`, `max-players`, `allow-commands`, `require-user-verification`, `/promote` and `/demote`.
  It was `false` both times, so none of these flag the save the way `/c` does.
- Not checked: `/config` with players online; a password holding a space (`/config set password pass word` answered
  `Server password changed.`, but no read-back shows whether the space survived); `/config set description` with no
  value.

**Map generation**

- `--create FILE` takes `--map-gen-settings FILE`, `--map-settings FILE`, `--map-gen-seed SEED` and `--preset NAME`.
  The presets in 2.1.24 are default, rich-resources, marathon, death-world, death-world-marathon, rail-world,
  ribbon-world, lakes and island. `--preset nope` gives `Preset "nope" doesn't exist.` and exit 1.
- `--preset rich-resources` with a partial map-gen file `{"seed":42,"peaceful_mode":true}` applies the preset first,
  then the given keys. A partial map-gen file is also fine on its own.
- A map-settings file must be complete: one with only `enemy_expansion` gives `Key "pollution" not found`, exit 1.
- Ranges are a crash hazard. `iron-ore` frequency 0 made `--create` abort (`double value not in range for fixed point
  number: -inf`, exit 1, 1.67 GB peak, no file). Frequency, size and richness from 1/6 to 6 worked, and so did size 0,
  which means none (the game's own GUI meaning). An unknown control name fails `--create` (`"bogus-control" is not a
  valid autoplace control name.`, exit 1).
- With Space Age there are 28 autoplace controls. Nauvis's surface holds its own 12; planet controls in the same file
  (`tungsten_ore`, `vulcanus_coal`, `gleba_enemy_base`…) apply when that planet's surface is made later. Peaceful mode
  carried over to Gleba. `vulcanus_coal` frequency 0 broke `create_surface` (`SpotNoise::region_size must be >= 0`).
- `--create` took about 1.05 s and 450 MiB RSS on the x64 test machine, for a save of about 0.8 MB. ARM wasn't measured.
- `--create` with the server's own `config.ini` fails at once on the write-data lock (`Couldn't acquire exclusive
  lock`). With its own `config.ini` (another write-data folder, the same `--mod-directory`) it succeeded while the
  server ran, and the server kept answering RCON. It rewrites `mods/mod-list.json` (same content, new mtime).
- **New (2026-11-01): `--preset` beats `--map-settings`, key by key.** `--create --preset death-world --map-settings F`,
  where F is the full example with `enemy_expansion.enabled` false and `enemy_evolution.time_factor` 0.000999, gave a
  world with expansion off (F's) but `time_factor` 2e-05 (death world's). Keys the preset sets win over the file, and
  other keys come from the file.
- **New: the example map-settings file is not the engine's defaults.** The same world got `min_expansion_cooldown`
  14400 from F, and a death world made without F has 36000. So merging choices "over the example file" would quietly
  change things nobody picked.
- **New:** `game.map_settings.enemy_expansion.enabled`, `enemy_evolution.enabled`, `pollution.enabled`,
  `game.difficulty_settings.technology_price_multiplier` and `spoil_time_modifier` can be written at run time and read
  back. A mod may do so without flagging the save.
- **New:** `prototypes.map_gen_preset` lists the 9 presets, each with partial `basic_settings` and
  `advanced_settings`. For example rail-world: `enemy_expansion = {enabled = false}`, `enemy_evolution = {time_factor
  = 2e-06}`, and resource frequency 1/3 and size 3. `prototypes.autoplace_control` lists the controls, each with its
  category and whether it has a richness.

**Saves**

- A save is a zip with one top folder. In it: `control.lua` (the scenario's Lua: freeplay's is one `require`),
  `description.json`, `info.json`, `level-init.dat`, `level.dat0` to `level.datN`, `level.datmetadata`, `script.dat`
  and `locale/*/freeplay.cfg`. `level.datN` entries are stored, but each one holds its own zlib stream. A 43 MB save
  had 141 entries.
- `level.dat0` inflates to a header. It starts with the version (four u16 LE: `02 00 01 00 18 00 01 00` is
  2.1.24-1). Further on is the mod count (one byte), then each mod as a length-prefixed name, three version parts
  (space-optimised u16) and a CRC u32. The first mod is always `base`, at the header's version. A reader that inflates
  at most 64 KiB of output and requires that `base` read the version and the mods right for every test save, in 41 ms.
- A save from a newer Factorio refuses to load (`Map version 2.1.99-1 cannot be loaded because it is higher than the
  game version (2.1.24-1).`, exit 1).
- **A save with mods the server lacks loads silently, and loses their data.** A test mod's save loaded without the
  mod, and the shutdown save rewrote the zip without it. A Space Age save on a base-only server loaded the same way,
  losing all Space Age content at the next save. A vanilla save on a Space Age server ran migrations and became Space Age.
- Factorio reads the zip in place and never unpacks it. Files at the zip root give `level.dat not found.`; a
  `../../x` entry gives `Path ../../evil-escape.txt outside of package`; a 1-byte junk zip gives `I/O error`. All exit 1,
  and nothing was written anywhere. A save re-zipped under another top folder name loads.
- `--start-server-load-latest` takes the newest `*.zip` by mtime, **dotfiles included** (`.sep-write.zip` was loaded).
  It ignores subfolders. A corrupt newest zip is fatal, with no fall back to an older one, and an empty `saves/` gives
  `No latest save file found`. Each of these exits 1, which loops forever like a bad settings file.

**Transport.** The research measured three ways to move a save from the hub to the Agent: base64 chunks on the Agent
connection, a separate HTTP port, and a raw connection on the Agent port. The raw connection won:

- At 40 ms RTT and 12.5 MB/s it reached 12.2 MB/s, against 9.1 MB/s for base64 chunks.
- The chunks also held hub requests up by 0.3 to 2 s behind them, and their acks would pass the Agent connection's
  20 lines/s budget on a fast tailnet. That closes the connection, which counts as the Agent being lost.
- Cutting a raw transfer at 10,032,196 bytes and fetching again from that offset gave a whole file whose sha256 matched.
- HTTP needs a second port opened on the hub host and in the friend's tailnet policy, and an HTTP parser facing a
  hostile peer.

---

## Decisions

| Question | Decision |
|---|---|
| Where in the dashboard | A new **Settings** tab for game settings (factorio servers only). New worlds and uploads go in the **Saves** tab, since both make a save and loading one is a Restore. No change to the Game tab, where the mod browser work goes on. |
| Source of truth | `server-settings.json`. The Agent writes it only from fields it validated, then applies the live subset with `/config set`. Keys with no live option show as "applies at the next restart". |
| Visibility | Always `{ public: false, lan: false }`, never shown. No factorio.com username or token is ever written. |
| Game password | Write-only. The dashboard shows only whether one is set. A new one is typed or generated in the browser, sent once, and never stored, logged or audited by the hub, nor logged or sent back by the Agent. |
| Verification off | Allowed, behind a warning that says what it costs. Turning it off also proposes Lua commands off, and needs a game password. |
| Admins | Live through `/promote` and `/demote` while the server runs; through `server-adminlist.json` while it is stopped. |
| A bad file | The Agent writes nothing Factorio would refuse. As a safety net, the first start after any write is watched, and a failed one brings back the last copy a start succeeded with. |
| Presets and map settings | `--preset` plus a partial map-gen file, both verified. **No map-settings file**: given the two new facts above, none can be written safely. Map settings (expansion, evolution, pollution, research cost, spoil time) are applied by the Factorio mod at the new world's first start. This needs a Factorio mod release: see [The Factorio mod release](#the-factorio-mod-release-a-decision-for-the-owner). |
| Raw JSON or exchange strings | Not offered. The Agent writes JSON only from fields it checked. |
| Generating a world | A one-shot `factorio-create` Quadlet unit next to the running server, with `Network=none`. The Agent starts it through polkit. |
| Loading a world | The existing Restore, extended: the hub can stop the server first (with the countdown) and start it after. The Agent keeps the current world as a **pre-restore save**, refuses a save whose mods the server lacks unless told to drop them, and rolls back a save that doesn't start. |
| Moving an upload to the Agent | A third first-line kind on the Agent port, `agentFetch`: raw bytes from an offset, so it can resume. |

---

## Stage A: game settings

### What can be changed

| Key | Label | Rule (hub and Agent alike) | Applies |
|---|---|---|---|
| `name` | Name | 1 to 100 characters, trimmed, no control characters | live: `name` |
| `description` | Description | 0 to 256 characters, no control characters (so one line) | live: `description` when not empty; an empty one at the next restart (unverified live) |
| `max_players` | Max players | integer 0 to 1000; 0 means no limit | live: `max-players` |
| `game_password` | Game password | write-only: left out keeps it, `null` removes it, else `^[\x21-\x7E]{1,64}$` (printable ASCII with no space, since a space's fate is unverified) | live: `password` (a bare `password` removes it) |
| `require_user_verification` | Check players' factorio.com accounts | boolean; false needs a game password (kept or new) | live: `require-user-verification` |
| `autosave_interval` | Autosave every (minutes) | integer 0 to 1440; 0 means off | live: `autosave-interval` |
| `autosave_slots` | Autosave slots | integer 1 to 100 | next restart |
| `afk_autokick_interval` | Kick idle players after (minutes) | integer 0 to 1440; 0 means never | live: `afk-auto-kick` |
| `auto_pause` | Pause while nobody is on | boolean | next restart |
| `auto_pause_when_players_connect` | Pause while a player joins | boolean | live: `auto-pause-when-players-connect` |
| `only_admins_can_pause_the_game` | Only admins can pause | boolean | live: `only-admins-can-pause` |
| `allow_commands` | Lua commands | `"true"`, `"false"` or `"admins-only"` (as the file's JSON: `true`, `false`, `"admins-only"`) | live: `allow-commands` |
| admins (`server-adminlist.json`) | Admins | at most 100 names, each `^[A-Za-z0-9_.-]{1,60}$`, each once ignoring case | live: `/promote`, `/demote`; stopped: the file |

The Agent writes these keys and no others. It also writes `visibility` `{ "public": false, "lan": false }`,
`non_blocking_saving` false (setup's value) and its own `_comment`. Other keys found in the file (tags, upload limits,
latency, `username`, `token`) are listed to the dashboard as `extra`: the next save drops them, and the dashboard says
so beforehand.

### UX: the Settings tab

A tab labelled **Settings**, after Game, shown for a server with `features.settings`, which is true for every server
an Agent runs (an older Agent's gets the deploy text below). One page, `max-w-3xl`, with cards:

- **Server**: Name, Description, Max players (number, with "0: no limit" under it), Game password.
- **Joining**: Check players' factorio.com accounts (a switch, with the warning below), Kick idle players after.
- **Pausing**: Pause while nobody is on, Pause while a player joins, Only admins can pause.
- **Saving**: Autosave every, Autosave slots. A muted line under them: "orrery's own saves (every 6 h after play,
  and before updates) are separate from Factorio's autosaves."
- **Lua commands**: a native select with three options: Off, Admins only, Everyone. Under it: "Commands can change
  anything in the game, and using one disables achievements for that save for good."
- **Admins**: the list as chips, each with a remove button (`aria-label="Remove <name> from the admins"`). An input
  and an Add button take one name at a time, checked as you type: "Names are 1 to 60 letters, digits, `_`, `.` or `-`."

Each field that applies at the next restart carries the badge "next restart". A field changed but not saved yet gets
a dot and its old value in a `title`.

**Footer** (sticky): it says what saving does before it does it, for example "Applies now: Name, Max players. At the
next restart: Pause while nobody is on." The **Save** button is disabled until a field changed and every field is
valid, and shows a spinner while the request runs. With extra keys in the file, the footer adds: "Saving rewrites
`server-settings.json` without: tags, max_upload_slots."

**After a save**: a toast, "Saved." or "Saved. 1 change applies at the next restart.". A banner stays at the top while
anything is pending: "Waiting for a restart: Pause while nobody is on, Autosave slots." It has a **Restart…** button,
which opens the server header's existing restart dialog (countdown while players are on).

**States**

- Server stopped: a muted banner, "The server is stopped: changes are written now and apply when it starts."
- Starting or stopping: Save is disabled with "The server is starting or stopping: try again in a minute."
- The Agent isn't connected: the fields are read-only, showing the last report, with "The Agent isn't connected."
- The file can't be read (hand-edited, invalid): "server-settings.json can't be read (<reason>). Saving writes a new
  one from these fields." The fields show their defaults (setup's), and the password reads "not set" unless typed.
- Rolled back: a red banner, "The server didn't start with the settings saved <time>, so the Agent put back the ones
  it last started with: <detail>." It stays until the next save.
- An older Agent: "This server's Agent runs agent-v1.1.1, which can't change game settings. Deploy agent-v1.2.0 or
  later from the Host page (Releases)." Nothing is editable.
- An older hub (the dashboard runs ahead): its 404 shows "This hub has no game settings yet: deploy hub-v2.16.0 or later."

**Accessibility**: every control has a `<label>`. The switch is a `role="switch"` button with `aria-checked`. The
pending state and the badges are words, never colour alone. The warning is an `aria-live="polite"` region that
appears when the switch is turned off, before saving. Errors are tied to their field with `aria-describedby`.

### Verification off: the warning

Shown under the switch when it is off (saved or not), in the warning style, word for word:

> **Names are not checked.** Without this, players join with no factorio.com account check: anyone who has the game
> password can join under any name, an admin's included. As an admin they can run Lua commands, when commands are on
> for admins, and through those take over the game, post to Discord as anyone, and pass for a linked player. Bans by
> name stop no one. Turn it off only for players without a factorio.com account (such as a family-shared copy). Keep
> the game password secret, and change it here if it leaks.

Turning the switch off also does two things in the form, and the owner can change them before saving:

- **Lua commands** switches to **Off**, and a line under it says "Turned off with the account check: names can't be
  trusted." If the owner picks Admins only or Everyone again, the line turns red: "Anyone with the game password can
  run Lua as an admin."
- **Game password** becomes required. The hub and the Agent refuse verification off with no password (400:
  "Without the account check a game password is needed.").

Admin chips get the suffix "(name not checked)" while verification is off.

### Game password

- The Agent's report carries only `game_password_set` (a boolean). Nothing sends the password back: no reply, push,
  log line or audit entry carries it.
- The field is "Set" or "Not set", with **Change**. Change opens a `type="password"` input with a show/hide button and
  **Generate**, which fills it with 20 random letters and digits (`crypto.getRandomValues`, made in the browser) and
  shows it so the owner can copy it for the players. **Remove password** is disabled while verification is off.
- A note under it: "Players need the new password. `/srv/factorio/first-boot.txt` on the friend's VM still shows the
  first one."
- In the hub, the request body is checked and passed to the Agent, then dropped. It isn't kept in memory past the
  request, written to the database, or put in an error message. The audit entry says "game password changed" or
  "game password removed". `web.ts` logs no request bodies today. The hub's refusal texts name the field, never the value.
- In the Agent, the password goes into the file and into one RCON command, `/config set password <value>`. Today no
  Agent code path logs an RCON command's text or a request's fields: `rcon.ts`'s errors name only the timeout, and
  `readAgentLine`'s refusals name only the message type. A test pins this (see Tests). When the file is kept as is (no
  password in the request), the Agent takes the password from the current file. If that one fails the rule (a hand-set
  one with a space, say), the Agent refuses with "The file's game password can't be kept: set a new one."
- The Console tab audits commands as typed, so a `/config set password …` typed there is audited in full. The
  Settings tab is the way to change it. Masking it in the console's audit is out of scope (see Out of scope).

### How the Agent applies a change

New module `agent/src/settings.ts` (`GameSettings`):

1. **Read**. `config/server-settings.json` and `config/server-adminlist.json` are read through the config folder,
   opened once with `O_DIRECTORY` and `O_NOFOLLOW` as `saves.ts` does. Each file must be a regular file on that
   folder's filesystem, at most 1 MiB, read with `O_NOFOLLOW` and `O_NONBLOCK`. Both files are container-writable and
   untrusted:
   - each key is checked against the rules above, and one that fails is reported as unreadable;
   - admin names that fail the rule are left out of the report and never put in a command;
   - all of it drives display only.

   It reads them on connect, after each of its own writes, and when the unit becomes active.
2. **Check the request**. `settingsSet` must carry every key in the table (the password stays optional). It is refused
   with a reason (`ok: false`) when:
   - a rule fails;
   - verification is off with no password;
   - a game update, a deploy or (stage B) a world job runs;
   - the unit is activating or deactivating.
3. **Write**.
   - Build the JSON from the checked fields only (`JSON.stringify` of a new object, never text from the hub).
   - Write it to `.server-settings.json.<random>.partial` in the config folder through the folder handle (`O_CREAT`,
     `O_EXCL`, mode 600), `fsync` it, then rename it over `server-settings.json` (never through `/tmp`: the SELinux
     label).
   - Then arm the start gate.
4. **Apply live**, only when the unit is active and RCON answers:
   - one `/config set <option> <value>` per changed key with a live option;
   - then admins: the new list against the file's current one, ignoring case, as `/promote <name>` and
     `/demote <name>`.

   A `/config set` counts as applied when its reply is Factorio's change line for that option. `/promote` and
   `/demote` answer nothing, so they count as applied when the adminlist file, read again, has the change. Any other
   outcome leaves the key in `pending` (the file has it, so the next restart applies it).
   With the server stopped, the admins are written to `server-adminlist.json` the same way as step 3 (a JSON list of
   the names, lowercased), and nothing is applied live.
5. **Reply** `{ applied, pending }`, then push `settings`.

**Started with, and last good.** When the unit becomes active, the Agent stores the checked model it reads then as
`startedWith`, in `<state>/settings.json`. An Agent that starts while the unit is already active (after a deploy or a
restart of its own) has seen no such change: it reads the file then as `startedWith`, as `readAutoPause` reads it
today. **Every good start** (RCON answers within 300 s of the unit becoming active, gate armed or not) also makes
that model `lastGood`, when it was fully readable. That is the one rule for `lastGood`.

**Pending.** `pending` lists the restart-only keys (`auto_pause`, `autosave_slots`) whose file value
differs from `startedWith`, plus any live key that failed in step 4. A start empties it. `status.ts`'s
`readAutoPause` (UPS and paused) switches from reading the file to `startedWith.auto_pause`: the file can now hold a
value the running server doesn't have yet.

**Start gate** (new `agent/src/gate.ts`, `StartGate`; stage B uses it for restores too). Armed by each write, it watches
the next start:

- **Good**: RCON answers within 300 s of the unit becoming active (`TimeoutStartSec`). The gate disarms (and, as at
  every good start, the model just started with becomes `lastGood`).
- **Failed**: the unit is `failed`, or `activating` with an `auto-restart` SubState and a Result other than success,
  before RCON answered. The Agent writes `lastGood` back the same way as step 3, so the auto-restart 10 s later uses
  it. It then disarms and pushes `settings` with `rolledBack` (the time and Factorio's last error line from
  `factorio-current.log`, made `printable` and cut to 2 KiB).
- With no `lastGood` (the file was never readable), the failure is reported and nothing is written.
- One unrelated failed start (a broken save, say) also puts the settings back. That is harmless: they are the last
  ones a start succeeded with.

`<state>/settings.json` is the Agent's own file (`/srv/orrery-agent/state`, which the container never mounts). It holds
`lastGood` (password included, as the config file does), `startedWith` and the gate. It is written atomically and read
back shape-checked at start.

**Setup re-runs keep the Agent's file.** `setup-agent-host.sh`'s `config()` keeps any `server-settings.json` that
differs from its own previous default, printing "kept …: edited by hand". `game_password()` then reads the password
the file holds for `first-boot.txt`. The adminlist is kept the same way. `test-setup-agent-host.sh` gets a case: a
re-run over a file written as the Agent writes it (no `_comment` of setup's, new name, verification off) keeps it byte
for byte, and the report shows its password.

### Hub

New module `hub/src/game-settings.ts`, `GameSettings` (hub core, with agents and systemd), for a server an Agent runs
(`has`; others 404):

- `state(id)`: `GameSettingsState`. That is what the Agent last pushed, held in memory (null before), plus `blocked`
  (why Save is refused now, or null). An Agent below `SETTINGS_FLOOR` (`agent-v1.2.0`; the dev loop's `agent-v0.0.0`
  counts as newer, as for `beforeAgentFloor`) is blocked with the deploy text above, and so is one that isn't
  connected. So are: a game update, a restore or a deploy on that server, a countdown running, and the unit starting
  or stopping.
- `set(id, body, by)`: 400 for bad input (the rules above, each reason naming the field); 409 when `blocked`. Else it
  sends `settingsSet` and answers the Agent's `{ applied, pending }`, or 502 with the Agent's error.
- It audits the change and publishes `settings` on the server's live feed whenever a push or a save changes the state.

`hub/src/agents.ts` routes the `settings` push to `GameSettings`, as `installed` goes to `GameUpdates`.
`hub/src/web.ts` gets a new block `if (gameSettings)` (kept apart from the game update routes):

- `GET /api/servers/:id/settings` gives `GameSettingsState`;
- `PUT /api/servers/:id/settings` takes `GameSettingsRequest` and answers `GameSettingsAnswer`.

`Features` gains `settings` (`gameSettings?.has(id)`).

Types in `hub/src/api.ts` (a new section, apart from the game update types):

```ts
/** Who may run Lua commands: as server-settings.json's `allow_commands`. */
export type AllowCommands = 'true' | 'false' | 'admins-only';
/** A factorio server's game settings as its Agent read them (never the password: only whether one is set). */
export type GameSettingsValues = {
  name: string; description: string; max_players: number; game_password_set: boolean;
  require_user_verification: boolean; autosave_interval: number; autosave_slots: number;
  afk_autokick_interval: number; auto_pause: boolean; auto_pause_when_players_connect: boolean;
  only_admins_can_pause_the_game: boolean; allow_commands: AllowCommands;
};
/**
 * `GET /api/servers/:id/settings`. `settings` is null before the Agent's first report, or while the file can't be read
 * (`problem` says why). `pending`: keys saved but waiting for a restart. `extra`: keys in the file a save drops.
 * `rolledBack`: why the Agent last put back the previous settings, until the next save. `blocked`: why Save is refused now.
 */
export type GameSettingsState = {
  settings: GameSettingsValues | null; admins: string[]; problem: string | null; pending: string[];
  extra: string[]; rolledBack: string | null; blocked: string | null;
};
/**
 * `PUT /api/servers/:id/settings`: every value (the password aside: left out keeps it, null removes it) and the
 * admins. 400 bad input, 409 blocked, 502 the Agent refused.
 */
export type GameSettingsRequest = Omit<GameSettingsValues, 'game_password_set'> & { game_password?: string | null; admins: string[] };
/** What applied at once, and what waits for the next restart. */
export type GameSettingsAnswer = { applied: string[]; pending: string[] };
```

**Audit** (action `game settings`, target the server): the changed keys with old and new values, the password only as
"game password changed" or "game password removed", and admins as "+bob, -alice". For example: `name: "orrery Factorio"
→ "Our base"; max_players: 0 → 8; game password changed; admins: +bob`. A rollback is audited as `hub:agent` with its
detail.

**Discord** (the alerts channel, through the existing notice path):

- `verificationOff`: "User verification is now off on <server> (by <name>): player names aren't checked."
- `verificationOn`: when it is turned on again.
- `settingsRolledBack`: "<server> didn't start with its new settings: the Agent put back the previous ones."

Other changes post nothing.

### Wire additions (stage A)

Additive. No `PROTOCOL_VERSION` bump.

| Direction | Message | Fields | Notes |
|---|---|---|---|
| Agent → hub | `settings` | `settings` (`GameSettingsValues` or null), `admins` (string[], at most 100), `problem` (string or null, 2 KiB), `pending` (string[], at most 16), `extra` (string[], at most 32, each `^[a-z_]{1,64}$`), `rolledBack` (string or null, 2 KiB) | on connect, and after each change. Budget: as `installed` (dropped when identical to the last one taken on that connection, else 1 a second, bursts of 10) |
| hub → Agent | `settingsSet` | `id`, `settings` (every key of the table but the password), optional `game_password` (string or null), `admins` (string[]) | answered within 30 s; `reply.data` `{ applied: string[], pending: string[] }` |

Places that change together: `hub/src/types.ts` (`AgentMsg`, `AgentRequest`, `AgentReplyData`); `hub/src/protocol.ts`
(`AGENT` schemas, and the new limits: admins 100, pending 16, extra 32, name 100); `agent/src/wire.ts`
(`readAgentLine` for `settingsSet`, `LIMITS` copies) with `agent/test/wire.test.ts`; `docs/protocol.md` ("Agent →
hub", "Hub → Agent", "Field limits", "Rate rules").

Version skew, stated in `docs/protocol.md`:

- A hub older than this treats `settings` as an unknown type and ignores it. It still counts as a line, so the
  connection stays up.
- An Agent older than this never sends `settings`. The hub never sends it `settingsSet`, because `SETTINGS_FLOOR`
  blocks it first. If one were sent anyway, the Agent answers `ok: false` with `settingsSet is not supported by
  agent-v1.1.1` (`agent/src/hub.ts:423`), which the hub passes on as 502.

### Trust rule change (stage A): RCON built-ins

`agent/CLAUDE.md`'s rule is today: "RCON commands the agent builds are the mod's own commands with one line of JSON as
the argument (the first-boot check also sends Factorio's built-in `/help`…): never Lua, never `/c` or `/sc`, which would
flag the save for good." Live settings need Factorio's own `/config set`, `/promote` and `/demote`. This is a change to
that rule, said here so the owner decides it. The new text:

> RCON commands the agent builds are the mod's own commands with one line of JSON as the argument, and Factorio's
> built-ins `/config set <option> <value>` (the option from a fixed table in `settings.ts`, the value one it validated:
> one line, printable, within its field's limit), `/promote <name>` and `/demote <name>` (the name checked against
> `^[A-Za-z0-9_.-]{1,60}$`). These were checked on 2.1.24 not to flag the save. The first-boot check also sends the
> built-in `/help`. Never Lua, never `/c` or `/sc`, which would flag the save for good.

It is no weaker than today in effect. The Console tab already sends what the owner types to RCON as is, built-ins
included. The Agent builds these commands only from a fixed table and checked values, and the check that they don't
flag the save is recorded above. If the owner says no, live apply goes: every change is written to the file and
applies at the next restart, and admins can only change while the server is stopped.

The other trust rules stand. `server-settings.json` and the adminlist stay container-written, so they drive display
only. What the Agent writes comes from its checked fields. Its own state stays under `/srv/orrery-agent`.

### Tests (stage A)

`agent/test/settings.test.ts`:

- Every rule: boundaries (`max_players` 0, 1000 and 1001; `autosave_interval` 1440 and 1441; a 101-character name; a
  name with `\n`; a password with a space, and one of 65 characters; an admin `a b`, and a 61-character one; 101
  admins; the same admin twice in two cases).
- Verification off with no password is refused, and so is one where the request leaves the password out and the file
  has none.
- The JSON written has exactly the managed keys, `visibility` false and false, and no `username`, `token` or `admins`.
  The write goes through a `.partial` in the same folder and a rename. A config folder swapped for a symlink is
  refused. Extra keys are reported and then dropped.
- Live: with a fake RCON, the commands are exactly `/config set name Our base` and the like, one per changed live key,
  then `/promote` and `/demote` from the diff. A wrong reply leaves the key pending. Restart-only keys are always
  pending. With the unit stopped, no RCON is used and the adminlist file is written.
- The password: no captured console line, `agent.log` line, reply or push holds it. The test sets a recognisable
  password and greps everything the run produced.
- The gate: a failed start after a write puts `lastGood` back and reports `rolledBack`. A good start makes the new file
  `lastGood`. With no `lastGood`, nothing is written.
- `readAutoPause` follows `startedWith`.
- A malformed file: `settings` null with `problem`, and the next save writes a fresh file.

`agent/test/hub.test.ts` and `agent/test/index.test.ts`: the `settings` push on connect and after a save, and through
the fake hub's real `parseAgentLine` (nothing in `invalid`); `settingsSet` refused while an update or a deploy runs.

`hub/test/game-settings.test.ts`, the whole hub with `test/fake-agent.ts`:

- `GET` without a session is 401, a Minecraft server 404, and the state before and after a push. An Agent at
  `agent-v1.1.1` is blocked with the deploy text, and the request is never sent.
- `PUT` with every rule refused (400, with the field named), verification off with no password, and 409 while a game
  update or a countdown runs. A good one reaches the fake Agent unchanged, apart from the dropped extra fields.
- The audit entry has no password. The password appears in no hub log line (captured console).
- The `settings` budget: an identical push is dropped, and 20 in a second are cut to the burst.
- The live `settings` event, and the three Discord notices.

`web/src/app/servers/settings.spec.ts`:

- The fields render from a state. The footer says what applies now and what at the next restart.
- Save is disabled until a change is valid. The request body is checked, and the password is left out unless changed.
- Generate fills 20 characters. Remove password is disabled with verification off.
- Turning verification off shows the warning (in `aria-live`), sets Lua commands to Off and requires a password.
  Picking Admins only turns the line red.
- The pending banner and its Restart button, the rolled-back, stopped, older-Agent and older-hub (404) states, and the
  extra-keys line.

Dev loop, before stage A ships (the local hub, Agent and the real 2.1.24 headless):

- Every boundary value written by the real `settings.ts` loads in Factorio.
- Each live option applies.
- `pending` clears after a restart.
- A hand-broken file plus a write rolls back.
- Then, by hand: `/config set description` with no value. If it clears the description, it becomes live.

### Release (stage A)

The hub and dashboard releases are shared with the mod browser (`docs/notes/mod-browser.md`): both branches merge to
`main` before the cut.

1. Build on `fa/world-settings`. Verify as `CLAUDE.md` says, and run `deploy/test-setup-agent-host.sh`.
2. Release `hub-v2.16.0` and deploy it.
3. Release `web-v0.14.0` and deploy it. Against an Agent on `agent-v1.1.1`, the Settings tab shows the deploy text.
4. Release `agent-v1.2.0` and deploy it from the Host page (Releases). Deploys work from `agent-v1.1.0`, so the friend
   needs to do nothing.
5. Smoke on production:
   - Rename the server and set max players while it runs; both apply at once, with no restart.
   - Toggle `auto_pause` and see it pending until a restart.
   - Add an admin and remove one.
   - Change the password, and check that it appears nowhere in the audit or the hub's and the Agent's logs.
   - With the friend: turn verification off, have the family-shared player join, then decide whether it stays off.

---

## Stage B: new worlds and save uploads

Stage B changes restores, adds the world generator and adds uploads. All three leave a new `*.zip` in `saves/`, so
they share the rules in [Saves that never load by accident](#saves-that-never-load-by-accident).

### Saves that never load by accident

- **Stamped older.** `--start-server-load-latest` loads the newest `*.zip`, so a stored new world or upload would be
  loaded by the next crash restart or daily restart. Every file the Agent stores without being asked to load it gets
  an mtime 2 s older than the newest `*.zip` there, as `keep` already does for pre-update copies. Only a restore stamps
  a file newest.
- **No `.zip` until checked.** Transfers and copies are written as `.<name>.partial`. They are linked to their `.zip`
  name only once checked, since dotfiles ending `.zip` are loaded too.
- **Pre-restore save.** Before a restore stamps its copy newest, the Agent copies the current world, by `keep` and
  byte for byte, as `orrery-pre-restore-<time>.zip`. It is stamped 2 s older, so the old world survives the new one.
  `kindOf` counts it as `named`.
- **Pruning.** `prune` keeps pre-restore saves in a bucket of their own, the newest 10. Otherwise 20 named saves
  (every 6 h of play) would delete the old world within five days. Named saves keep 20 and world files 3, as now, and
  the current world and held saves are never pruned. New worlds (`new-<time>.zip`) and uploads
  (`uploaded-<time>-<name>.zip`) are world files: a fourth unloaded one prunes the oldest, and the dashboard says so
  where they are made.

### Restore, extended

The existing `restore` keeps working for an older hub. What changes:

- **Mods.** The Agent reads the save's header (`agent/src/save-header.ts`, below). It refuses (`ok: false`) a save made
  with a newer Factorio than the one installed: "made with Factorio 2.2.0, newer than this server's 2.1.24". It also
  refuses a save holding mods the server doesn't have enabled: "needs mods this server lacks: foo, bar". The second
  refusal is skipped when the request's new `dropMods` lists exactly those mods. Mods the server has but the save
  lacks are fine: they are added.
- **Pre-restore save.** As above, made after the checks and before the copy.
- **Gate.** The `StartGate` from stage A is armed for the restored copy:
  - **Good**: RCON answers within 300 s and `Loading map` names the copy. The Agent sends `restoreResult` with
    `outcome` `ok`.
  - **Failed**: the unit failed or auto-restarted before that. The Agent renames the copy to
    `.failed-<name>.restore` (no `.zip`, so the next start loads the newest left, which is the old world) and sends
    `restoreResult` with `outcome` `rolled back` and Factorio's last error line.
  - A new world's map settings are applied at a good gate (see New worlds).
- **Stop and start by the hub.** `RestoreRequest` gains optional `stop`, `start` and `dropMods`. With `stop` on a
  running server, the hub asks `saveInfo` first, so a mod refusal comes before anything stops. Then it stops the
  server with the usual countdown (5 minutes in game while players are on; `RestartScheduler` with `{ stop, fire }`,
  as game updates do). It waits for the pushed state to be inactive or failed (10 minutes at most), restores, and with
  `start` starts the unit. The answer is 202 for such a job. Its steps go to the live feed as `restoreStep` (`stop`,
  `restore`, `start`, `gate`, each `running`, `done` or `failed`), and the Saves tab shows them with the existing
  `UpdateSteps`.
- **A hub restart mid-job** loses the job, which lives in memory. The server is then left as it was at that moment:
  - still running, with the countdown gone;
  - stopped with nothing restored;
  - or stopped with the copy newest, so its next start loads it (the Agent's gate still runs).

  The audit has the request's row and no outcome row, and the Saves tab shows the service's real state.
- Exclusive, as restores are now, with game updates, deploys, uploads being stored and world generation on that server.

### Audit and Discord (stage B)

- **Audit** (target the server):
  - `restore`, as today, with `stop` and `start` noted, `dropMods` listed, and its outcome row (`ok`, or `rolled
    back` with the detail, from `restoreResult`);
  - `world create`: the preset, the seed and the overrides, then the stored name or the error;
  - `save upload`: the file name and size, then the stored name or the error.
- **Discord** (the alerts channel): `restoreRolledBack`, "<server> didn't start with <name>: the Agent put the previous
  world back." Uploads, world creation and a good restore post nothing. The restore's start already posts the
  server's `started`, as any start does.

### Save header check

`hub/src/save-header.ts`, with a byte-identical copy at `agent/src/save-header.ts`. A release tarball is `agent/` alone,
so the code is copied, and `agent/test/save-header.test.ts` checks that the two files are equal, as `wire.test.ts` does
for `LIMITS`. The rules come from the research's reader:

- The zip's central directory, read from the end. ZIP64 and multi-disk are refused; whether real saves ever use ZIP64
  is checked in the dev loop, including the 43 MB save. At most 20,000 entries.
- Every entry name is checked: no leading `/`, no `\`, no `..` or empty part, no symlink mode bits, none at the zip
  root, and exactly one top folder.
- `level.dat0`, `level-init.dat`, `level.datmetadata` and `control.lua` must be under it.
- `level.dat0` is read stored or deflated (method 0 or 8 only). Its zlib stream is inflated to at most 64 KiB of
  output, so a zip bomb can't grow it.
- The version is the first four u16s. The mods are found by the first mod being `base` at that version; when none
  matches, `mods` is null and the save is refused as unreadable.
- The answer: `{ version: 'X.Y.Z', build, mods: { name, version }[] }`, or a refusal reason.

The header comes from an untrusted file. It drives refusals and display only, never a path or a name on disk.

### New worlds

#### The Factorio mod release (a decision for the owner)

The task's release plan has hub, dashboard and Agent releases only. New worlds need a fourth part, **`factorio-v1.1.0`**
(`orrery` 1.1.0 on the portal). That is a deliberate deviation, and `factorio/CLAUDE.md` asks for few mod releases,
since every player downloads each one. The reasons are the new facts above:

- a map-settings file must be complete;
- the example file is not the engine's defaults;
- the preset's keys beat the file.

So no map-settings file can be written that both keeps the preset and honours the owner's choices. The mod can,
because map settings are writable at run time. And only the mod can list the presets and the autoplace controls of
the mods the server really runs. Two new commands, each in `pcall` like the others:

- `/orrery-mapgen`: answers one line of JSON, `{ presets: string[], controls: { name, category, richness }[] }`, from
  `prototypes.map_gen_preset` (in its `order`) and `prototypes.autoplace_control`. It reads only.
- `/orrery-map-settings {"expansion":bool?,"evolution":bool?,"pollution":bool?,"tech_price":number?,"spoil_time":number?}`:
  sets each one given and answers the values read back. It is refused (`{"error":"not a new world"}`) once
  `game.tick` is past 36,000 (10 minutes of play), so it can't change a world in use. The ranges are checked in Lua
  too: `tech_price` from 0.01 to 1000, `spoil_time` from 0.01 to 100.

The alternative is static tables in the Agent for 2.1's engine map-settings defaults and the nine presets'
`advanced_settings`. The Agent would write a complete map-settings file merged from them, and a key new in a later
Factorio would fail `--create` cleanly. That needs no mod release, but it copies game data that can drift, and it can't
see controls from portal mods. **The note recommends the mod commands.** Either way, uploads don't depend on it.
Without `orrery` 1.1.0, New world is refused with "New worlds need the orrery mod 1.1.0 or later: update the game
first (Game tab)." Stage B can then still be built and released in the task's order.

#### The generator unit

`deploy/factorio-create.container`, written by `setup-agent-host.sh` like `factorio.container` (managed header, put
only when changed):

```ini
[Unit]
Description=Factorio world generator (orrery)

[Container]
ContainerName=factorio-create
Label=orrery.managed=true
Image=<the same pinned image>
Pull=never
Network=none
User=<uid>
Group=<gid>
Environment=HOME=/srv/factorio
Volume=/opt/factorio:/opt/factorio:ro,z
Volume=/srv/factorio:/srv/factorio:z
ReadOnly=true
Tmpfs=/tmp
NoNewPrivileges=true
DropCapability=ALL
LogDriver=journald
Exec=/opt/factorio/current/bin/<arch>/factorio \
  --config /srv/factorio/create/config.ini \
  --mod-directory /srv/factorio/mods \
  --create /srv/factorio/create/new.zip \
  --preset ${ORRERY_PRESET} \
  --map-gen-settings /srv/factorio/create/map-gen-settings.json

[Service]
Type=oneshot
EnvironmentFile=/srv/orrery-agent/state/create.env
MemoryMax=3G
TimeoutStartSec=600
```

- The preset is the only part of the argv that changes. It comes from `create.env` in the Agent's own state, which the
  container doesn't mount. The Agent writes only `ORRERY_PRESET=<name>`, with the name from the mod's list and
  checked against `^[a-z0-9-]{1,64}$`. `${…}` makes exactly one argument, so even a tampered file could only give
  `Preset "…" doesn't exist.` and exit 1.
- `factorio.container` already uses the same expansion for `${RCON_PASSWORD}`.
- The seed goes in the JSON, so no argument carries it.
- Setup creates `/srv/factorio/create/` and its `config.ini` (`write-data=/srv/factorio/create`, so the lock and the
  log are its own). `60-orrery-agent.rules` allows factorio `start` on `factorio-create.service` and nothing else for
  it.
- Quadlet's `Type=oneshot` was checked only by a dry run on Podman 6.1.4: smoke it on the VM's Podman.
- Smoke too that systemd may read an `EnvironmentFile` under `/srv/orrery-agent` with SELinux enforcing.

The Agent offers New world only when `systemctl show -p LoadState factorio-create.service` says `loaded`. Otherwise
it answers: "The world generator isn't installed: the friend re-runs setup-agent-host.sh at agent-v1.3.0 or later." An
Agent deploy from the dashboard doesn't run setup, so this step is the friend's.

#### The form (Saves tab, New world…)

A sheet, `sm:max-w-xl`, opened from a **New world…** button in the Saves tab's header (factorio only). It first asks
the hub for `worldOptions`, which the Agent answers from its last `/orrery-mapgen` answer, refreshed on each start and
kept in `<state>/mapgen.json`. That way the form works while the server is stopped.

- **Preset**: a native select with the mod's names. Known ones get labels (Default, Rich resources, Marathon, Death
  world, Death world marathon, Rail world, Ribbon world, Lakes, Island), and others show as named.
- **Seed**: a number input, empty meaning random, 0 to 4294967295, with a **Random** button.
- **Resources**: a row per control of category `resource` on Nauvis. The columns Frequency, Size and Richness (when
  the control has one) are native selects: "Preset", then 17%, 25%, 33%, 50%, 71%, 100%, 141%, 200%, 300%, 400%, 600%
  (1/6 to 6). Size also has "None" (0).
- **Terrain**: water, trees, rocks and cliffs (`nauvis_cliff`) the same way, and the starting area (Preset, then
  17% to 600%).
- **Enemies**: Peaceful (Preset, On, Off), enemy bases (frequency and size, the same steps), and Expansion, Evolution
  and Pollution (each Preset, On or Off).
- **Difficulty**: Research cost (Preset, or ×0.01 to ×1000) and Spoil time (Space Age only; Preset, or ×0.01 to ×100).
- **Space Age planets**: one collapsible group per planet, only for controls the mod listed. Vulcanus, Gleba, Fulgora
  and Aquilo are grouped by name prefix (`vulcanus_`, `gleba_`, `fulgora_`, `aquilo_`). The other planet controls
  (`calcite`, `sulfuric_acid_geyser`, `tungsten_ore`, `scrap`, `lithium_brine`, `fluorine_vent`) are grouped by a
  small static table in the dashboard. Anything else goes under Other. A muted line: "Planets get their own seeds from
  the main one."
- Everything starts at "Preset". Only what the owner changed is sent, and only that reaches the files: a partial
  map-gen file over `--preset`, and map settings through the mod.

Footer: "Creates a new save next to the current world, which stays as it is. Loading it is a restore." and
**Create**.
While it runs: a spinner with "Creating the world… (about a minute)". When done, the save's name and size, with
**Restore it now…** (the restore sheet, with Stop and Start checked) and **Close**. A refusal shows the Agent's reason.
If `--create` fails, its last log lines show (`printable`, cut).

#### What the Agent does (`agent/src/worlds.ts`, `Worlds`)

1. Check `worldCreate`. The preset must be in the cached list. The seed is an integer from 0 to 4294967295, or null.
   Each control name must be in the cached list. Frequency and richness must be finite and in [1/6, 6]; size must be
   in [1/6, 6], or 0. Richness is allowed only where the control has it. `starting_area` is in [1/6, 6]. The map
   settings must be in their ranges and need `orrery` 1.1.0 or later. At most 100 controls.
2. Refuse when: the generator is missing; a game update, deploy, restore, upload or another world job runs; or free
   space in `saves/` is under 2 GiB.
3. Write `create/map-gen-settings.json` (`seed`, `peaceful_mode`, `starting_area` and `autoplace_controls`, only those
   given) and `<state>/create.env`. Both are atomic, through their folder handles, built from checked fields. Remove a
   leftover `create/new.zip`.
4. `systemctl start --no-block -- factorio-create.service` (`execFile`). Then poll `systemctl show` until the unit is
   inactive or failed, for 10 minutes at most. On a failure, the reply is the tail of
   `create/factorio-current.log`, made `printable`, query strings stripped, cut to 2 KiB.
5. Open `create/new.zip` with `O_NOFOLLOW` (a regular file, at most 1 GiB) and check it with `save-header.ts`: its
   version must be the installed one, and its mods the installed set. Copy it from the open handle into
   `saves/.new-<time>.partial`, stamp it older, link `new-<time>.zip` and remove `new.zip`.
6. Record the requested map settings in `<state>/worlds.json` under that name, pruned with the save. Push `saves`, and
   reply `{ name, size }`.

At a restore's good gate, when the copy's source is in `worlds.json` with map settings, the Agent sends
`/orrery-map-settings` with them. It checks the read-back and adds "map settings applied" or the mismatch to the
`restoreResult` detail. A mismatch doesn't roll back, since the world itself loaded.

### Save uploads

#### The dashboard (Saves tab, Upload save…)

A sheet with a `.zip` file input. Files over 1 GiB are refused in the browser, with "Saves are at most 1 GiB." Steps,
shown with `UpdateSteps`:

1. **Upload**: through the existing `Uploader` (chunked, resumable) to `/api/uploads`, as a percentage.
2. **Check**: `POST /api/servers/:id/saves` with `{ upload }`. The hub reads the header and answers at once:
   - a refusal, such as "Made with Factorio 2.2.0, newer than the server's 2.1.24: update the game first." or "This
     isn't a Factorio save: <reason>.";
   - or the save's version and mods, and the mods the server lacks, shown as a warning: "Missing on this server: foo,
     bar. Restoring it drops their content for good."
3. **Send**: the hub to the Agent, as a percentage from the hub's own count of bytes sent.
4. **Store**: done when the Agent reports `saveUploaded`. "Stored as uploaded-20261101T200000Z-base.zip." Then
   **Restore it now…** and **Close**.

Closing the sheet doesn't stop the job: the Saves tab lists it while it runs. A note: "Uploaded saves are kept like
world files: the 3 newest that aren't loaded stay."

#### The hub (`hub/src/save-uploads.ts`, `SaveUploads`, hub core)

- `Uploads` is today made only with packs. From stage B it is made with packs or agents, so its routes exist for a
  factorio-only hub too.
- `add(serverId, uploadId, by)`:
  - takes the finished upload (404 if there is none);
  - refuses one over 1 GiB (413);
  - checks the header (400 with the reason);
  - compares the version and mods with the Agent's last `installed`;
  - is refused (409) like a restore: an update, a deploy, a restore or another upload on that server, or an Agent below
    `WORLDS_FLOOR` (`agent-v1.3.0`, with the deploy text).

  It then moves the file to `<data>/save-uploads/<fetch id>` (a fresh 32-hex id) and sends `saveUpload`. It answers
  202 with the header and the missing mods.
- The file is kept until `saveUploaded`, or until no fetch read anything for 60 minutes, and it is wiped at start.
  One upload at a time per server.
- Progress goes to the live feed as `saveUploadStep`, at most once a second.
- Audit: `save upload`, with the file name (`basename`, cut to 200), its size, and then the outcome with the stored name.

#### The fetch connection

A third first line on the Agent port, `agentFetch`:

```json
{"type":"agentFetch","agentId":"factorio-vm","token":"<the Agent's token>","upload":"<32 hex>","offset":0}
```

- The same rules as the other first lines: the peer address is checked at accept, before any byte is read; there is a
  5 s first-line deadline; the token is compared in constant time; the line takes from the address's line budget.
- The `upload` must be one the hub offered that Agent and still holds. The `offset` must be an integer from 0 to its
  size.
- At most one fetch at a time per Agent, and one welcomed per 5 s per Agent. A refusal is `reject` with its reason
  (`reconnecting too fast`, `a fetch is running`, `no such upload`), then the close within 2 s.
- The hub answers one line, `{"type":"fetch","size":<bytes>,"sha256":"<hex>"}`. It then streams the file from
  `offset` to the end (`createReadStream` piped to the socket, which gives TCP backpressure) and ends the connection.
- **After its first line the Agent sends nothing.** Any byte from it destroys the socket. A socket that takes no byte
  for 60 s is destroyed.
- The connection counts toward the 4 per address. An Agent connection, a game connection and a fetch leave one spare,
  so a reconnect during a fetch still fits.

The Agent (`agent/src/fetch.ts`):

- On `saveUpload`, it checks the fields: `upload` is 32 hex, `size` from 1 to 1 GiB, `sha256` is 64 hex, and `name` is
  at most 200 characters.
- It checks that `saves/` has at least size × 2 + 1 GiB free. It replies (the reply means accepted), then fetches into
  `saves/.upload-<id>.partial` through the folder handle.
- It reads the header line with the 1 MiB cap. Its `size` and `sha256` must equal the request's. Then it switches to
  raw bytes, aborting past `size`.
- A cut connection resumes with `offset` set to the file's length, up to 3 tries, 10 s apart.
- At the end the Agent checks the file itself. It computes its own sha256 over the whole file and compares it with
  the request's. It runs its own `save-header.ts` check, refusing a newer version; missing mods are stored anyway,
  since the restore refuses them.
- Then it stamps the file older and links it as `uploaded-<time>-<safe>.zip`. `<safe>` is the request's `name` without
  `.zip`, every character outside `[A-Za-z0-9_-]` replaced by `-`, cut to 40 characters, or `save`. No name ever comes
  from inside the zip.
- Last, it pushes `saves` and sends `saveUploaded`, delivered as `updateDone` is (again on each connect until its
  write went out). On any failure the partial file is removed.

### Wire additions (stage B)

Additive. No `PROTOCOL_VERSION` bump.

| Direction | Message | Fields | Notes |
|---|---|---|---|
| first line | `agentFetch` | `agentId`, `token`, `upload` (32 hex), `offset` (integer) | the fetch connection (above). The answer is `fetch` `{ size, sha256 }`, then raw bytes, or `reject` |
| hub → Agent | `worldOptions` | `id` | `reply.data` `{ generator: boolean, presets: string[] (≤ 32), controls: { name, category, richness: boolean }[] (≤ 100), mod: string or null (orrery's version) }`; 30 s |
| hub → Agent | `worldCreate` | `id`, `preset`, `seed` (number or null), `peaceful` (boolean or null), `startingArea` (number or null), `controls` (`{ [name]: { frequency?, size?, richness? } }`, ≤ 100), `mapSettings` (`{ expansion?, evolution?, pollution?, techPrice?, spoilTime? }`) | `reply.data` `{ name, size }`; answered within 12 min (`AGENT_CREATE_MS`: the unit may run 10) |
| hub → Agent | `saveInfo` | `id`, `name` (a listed save) | `reply.data` `{ version, mods: { name, version }[], missing: string[] }`; 30 s |
| hub → Agent | `saveUpload` | `id`, `upload`, `name`, `size`, `sha256` | the reply means accepted; the end comes as `saveUploaded` |
| hub → Agent | `restore` (changed) | new optional `dropMods` (string[], ≤ 500) | an older Agent ignores the field |
| Agent → hub | `saveUploaded` | `upload`, `ok`, optional `name` (the stored save), optional `error` (2 KiB) | once per upload; taken once, a repeat ignored |
| Agent → hub | `restoreResult` | `name` (the restored copy), `outcome` (`ok` or `rolled back`), `detail` (2 KiB) | once per restore's first start; taken once |

Budgets: `saveUploaded` and `restoreResult` take the line budget only, each taken once (as `updateDone`); the fetch
handshake has its own rule above. `docs/protocol.md` gets the third row in "Handshake", the messages, the limits
(controls 100, presets 32, `dropMods` 500) and the fetch's rate rules. The same files change together as in stage A.

Version skew:

- A hub older than this never sends these requests, and parses `saveUploaded` and `restoreResult` as unknown types
  (ignored).
- An Agent older than `agent-v1.3.0` is blocked by `WORLDS_FLOOR` before anything is sent. If one were sent anyway, it
  answers `<type> is not supported by agent-v1.2.0` (`agent/src/hub.ts:423`). An older Agent ignores `dropMods`, so
  it restores as today, with no mods check and no gate.
- An older Agent never sends `agentFetch`.

### Trust (stage B)

- The Agent writes only its own files:
  - the two map-gen inputs, which it builds from checked fields;
  - `create.env`, holding a checked name;
  - `.partial` files, `new-*` and `uploaded-*` saves, pre-restore copies and its state.

  Every write under `/srv/factorio` goes through a folder opened with `O_NOFOLLOW`, as `saves.ts` does now.
- What Factorio or the container wrote (`new.zip`, the create log, an uploaded save) is untrusted. It is opened with
  `O_NOFOLLOW`, size-capped and checked as a save, and its header drives refusals and display only.
- Uploads are admin-only, as every API action is. A save brings its own `control.lua`, scenario Lua at mod-level
  trust, so an upload is as trusted as the person who uploads it.
- Nothing from the hub becomes a path: the stored names are the Agent's own, and the fetch id is checked as hex.
- Sizes are capped at 1 GiB with a free-space check first. The header inflate is capped at 64 KiB. Zips over 20,000
  entries are refused.
- The fetch connection reads one line, then refuses any byte from the Agent's side, and gets the same address and
  token checks as the other connections.
- Every file the Agent stores can't load unasked, and a restored one that fails to start is moved aside.

### Tests (stage B)

- `agent/test/save-header.test.ts`:
  - synthetic zips built in the test (a header with base 2.1.24 and mods; stored and deflated `level.dat0`);
  - refusals: root entries, two top folders, `..`, a backslash, a symlink entry, a missing file, ZIP64, 20,001
    entries, a junk file, and a `level.dat0` that inflates past 64 KiB (the reader stops there);
  - a header patched to 2.1.99, and one whose first mod isn't `base` (mods null);
  - the hub's copy is byte-identical.
- `agent/test/saves.test.ts`:
  - pre-restore saves have their own bucket of 10;
  - a stored file is 2 s older than the newest;
  - a restore refuses a newer version and missing mods, unless `dropMods` lists exactly those;
  - the pre-restore copy is made byte for byte;
  - the gate renames a copy that failed to start, and reports `rolled back`, or reports `ok`;
  - map settings are sent at a new world's good gate.
- `agent/test/worlds.test.ts`, with a fake `systemctl` and a fake `new.zip`:
  - every range, including frequency 0 and 7, size 0 allowed, richness on a control without it, an unknown control,
    preset or seed;
  - the files written exactly, and `create.env` holding only the preset;
  - refusals: no generator, low space, a job running, `orrery` below 1.1.0 with map settings;
  - a failed unit's log tail as the error;
  - a `new.zip` with the wrong version is refused;
  - the stored name and its mtime.
- `agent/test/fetch.test.ts`, against a fake hub port:
  - nothing is sent after the first line;
  - a header with another size or sha256 aborts;
  - a cut stream resumes at the file's length;
  - more bytes than `size` abort;
  - a wrong sha256, or a save that fails the check, leaves no file;
  - `<safe>` names (`../x.zip`, emoji, 300 characters);
  - `saveUploaded` is delivered again after a reconnect.
- `hub/test/save-uploads.test.ts` and `hub/test/agents.test.ts`:
  - the `agentFetch` first line from a wrong address (destroyed unread), with a wrong token, an unknown upload, two at
    once, and two within 5 s;
  - a byte from the Agent destroys the socket;
  - resume from an offset;
  - backpressure: a stalled reader holds the stream, and is destroyed after 60 s;
  - the 4-socket count;
  - `add` refusals (413, 400 header, 409 busy, an older Agent);
  - the file is removed after `saveUploaded`, and after 60 idle minutes.
- `hub/test/restore.test.ts`:
  - `stop` and `start`: `saveInfo` first, then the countdown, the wait for stopped, the restore and the start;
  - a mods refusal before any stop;
  - `restoreStep` events;
  - a hub restart mid-job leaves the audit's request row only;
  - an older hub's body (no new fields) behaves as today.
- `hub/test/worlds.test.ts`: `worldOptions` and `worldCreate` go through to the fake Agent; 400 on bad ranges, before
  any request; the audit rows.
- `web`, specs for the Saves tab:
  - the New world sheet: options load, Preset everywhere, only changed values sent, planets grouped, the older-mod and
    no-generator texts;
  - the Upload sheet: the 1 GiB check, the four steps, the missing-mods warning, a refusal;
  - the restore sheet with Stop and Start, the mods confirmation ("Restore anyway, dropping foo, bar"), and the steps.
- `deploy/test-setup-agent-host.sh`: `factorio-create.container` and `create/config.ini` are written, kept when
  unchanged, and pass the Quadlet dry run. The polkit rule allows `start` on `factorio-create.service` for factorio
  only (and not `stop`, nor for another user).
- `factorio/`: the two commands' JSON and their `pcall`. `/orrery-map-settings` past tick 36,000 is refused.
- **Dev loop** (local hub, Agent and the real 2.1.24 headless):
  - each preset with overrides creates a world, and the map settings read back after its first start;
  - upload the 43 MB save through the fetch with a cut and a resume;
  - a Space Age save to a base-only server is refused, then restored with `dropMods`;
  - a junk upload is refused;
  - a restore of a corrupt save rolls back to the old world.

### Release (stage B)

1. Build on its own branch from `main` after stage A shipped. Verify as `CLAUDE.md` says.
2. Release `hub-v2.17.0` and deploy it (`Uploads` with agents, the routes, the fetch listener).
3. Release `web-v0.15.0` and deploy it.
4. Release `agent-v1.3.0` and deploy it from the Host page. Uploads, the restore changes and the pre-restore save then
   work.
5. The friend re-runs `setup-agent-host.sh` at `agent-v1.3.0`, for the generator unit, its folder and the polkit rule.
   Until then, New world says so.
6. Release `factorio-v1.1.0` (portal) and put it on the server with a game update from the Game tab. Until then, New
   world says "update the game first". Players download the new mod version once.
7. Smoke on production:
   - upload a real save over the tailnet and time it;
   - restore it with Stop and Start while nobody is on, and see the pre-restore save listed;
   - create a death world with expansion off on the ARM VM, and time it and measure its memory;
   - restore that world, and check expansion off in game;
   - restore the pre-restore save to go back.

---

## Docs to update with the code

Each stage updates what it touches:

- `docs/protocol.md` (as listed per stage).
- `agent/CLAUDE.md`: the modules table (`settings.ts`, `gate.ts`, then `worlds.ts`, `fetch.ts`, `save-header.ts`, and
  the `saves.ts` and `status.ts` rows), the RCON trust rule's new text, and the tests list.
- `hub/CLAUDE.md`: the rows for `game-settings.ts`, `save-uploads.ts`, `save-header.ts`, `restore.ts`, `uploads.ts`
  (made with agents too), `agents.ts` (the fetch first line), `web.ts` and `api.ts`.
- `web/CLAUDE.md`: `settings.ts`, and the Saves tab's sheets.
- `factorio/CLAUDE.md`: the two commands.
- Root `CLAUDE.md`: `deploy/factorio-create.container` and the polkit rule's new unit.
- `CONTEXT.md`:
  - **Game settings**: a factorio server's own settings (name, password, verification, pausing, autosaves, commands,
    admins), changed in the Settings tab; the file is their source.
  - **Admin**: a player name the server treats as an admin, unverified while user verification is off.
  - **New world**: a save the Agent generates from map settings, next to the running world.
  - **Uploaded save**: a save sent from the dashboard to the server's Host.
  - **Pre-restore save**: the current world, copied as a named save before a restore loads another one; kept in its
    own bucket of 10.
  - The **Save** entry mentions the new and uploaded ones. **Rollback** gains "a restored save that fails to start,
    and game settings a start fails with".
- `docs/ROADMAP.md`: a section for this work, linking this note.

## Out of scope

- Public listing, LAN visibility, tags, upload rate and slot limits, latency and heartbeat settings, and factorio.com
  credentials on the VM.
- Bans, a whitelist, and kicking from the dashboard.
- Masking `/config set password` in the Console tab's audit (a follow-up: the Settings tab is the way).
- Map exchange strings, "the same settings with a new seed", raw map-gen or map-settings JSON, map size, and planet
  terrain, cliff or starting-area overrides (untested).
- Deleting, renaming or downloading saves from the dashboard (a Save is never copied off its Host).
- Uploads from a URL, and saves over 1 GiB.
- Discord commands for any of this.
- More than one world running at once, or a world per Agent beyond its one server.

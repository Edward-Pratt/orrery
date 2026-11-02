# Factorio: portal mod update notices and player moderation

Status: built on `fa/game-extras` (2026-11-02), not yet cut: `hub-v2.20.0`, `web-v0.18.0`, `agent-v1.4.0`, in that
order. Designed on 2026-11-01 against `main` at `2f368ab`, next to fa/world-settings, whose Settings and save uploads
shipped first; the version numbers below are this release's. See [Built](#built) for where the build differs.

The owner asked for two things on the factorio server an Agent runs:

1. **Portal mod update notices.** The Game tab marks each installed portal mod that has a newer release for the
   server's Factorio version, says "N updates" on its summary card, and one action plans them all in the Update game
   sheet. Discord hears about new updates at most once a day per server.
2. **Moderation.** On the server page: who is online, and Kick, Ban (with a reason), Unban, Promote and Demote, with
   the bans and the admins listed. The Agent builds every Factorio command itself from a checked player name and a
   cleaned reason. An older Agent refuses cleanly, and the dashboard names the release it needs.

Contents: [Verified for this note](#verified-for-this-note), [Decisions](#decisions),
[Part 1: portal mod updates](#part-1-portal-mod-updates), [Part 2: moderation](#part-2-moderation),
[Living next to fa/world-settings](#living-next-to-faworld-settings), [Release](#release),
[Docs to update with the code](#docs-to-update-with-the-code), [Out of scope](#out-of-scope).

---

## Verified for this note

On the real Factorio 2.1.24 headless build (x64, Space Age, quality, elevated rails, recycler), RCON on loopback, user
verification off (so the server made no request to factorio.com), nobody on. A scratch mod read
`game.console_command_used`. The research ran in scratch folders that are not kept. Checked on 2026-11-01 while
writing this note. `docs/notes/factorio-smoke-x64.md` has nothing on moderation.

**Where the lists live**

- **The banlist is at the write-data root, not under `config/`.** With no `--server-banlist` argument, Factorio
  writes `server-banlist.json` in its write-data folder. `config.ini` on the Host says `write-data=/srv/factorio`, and
  `deploy/factorio.container` passes no `--server-banlist`, so production's file is `/srv/factorio/server-banlist.json`.
  The adminlist is `/srv/factorio/config/server-adminlist.json`, from `--server-adminlist`.
- Factorio writes the banlist at once on each `/ban` and `/unban`, and reads it at start: bans survive a restart.
- An entry is a bare name (`"noreason"`) or an object `{ "username": "spacey", "reason": "spam  links" }`. Names are
  stored lowercased. The reason is kept as given, double spaces and a newline included; only trailing spaces go. The
  locale has `ban-report-ip=__1__ (__2__) for __3__`, so an entry can also carry an address.
- `/bans` over RCON answers `Banned players: a, Eve, Name, noreason, spacey, uni and xxx…`: no reasons, and a
  separator a name could contain. `/admins` over RCON answers nothing. **Both lists must come from the files.**

**The commands** (each over RCON, for players never seen on the server)

| command | reply | logged |
|---|---|---|
| `/ban Griefer_1 stealing iron` | `Added Griefer_1 to the banlist.` | `[BAN] Griefer_1 (not on map) was banned by <server>. Reason: stealing iron.` |
| `/ban Second` (no reason) | `Added Second to the banlist.` | `… Reason: unspecified.` (the file has the bare name) |
| `/ban griefer_1 again` | `griefer_1 is already banned.` | a second `[BAN]` line all the same |
| `/unban GRIEFER_1` | `Unbanned GRIEFER_1.` | `[UNBANNED] GRIEFER_1 was unbanned by <server>.` |
| `/unban notbanned` | `notbanned wasn't banned.` | an `[UNBANNED]` line all the same |
| `/kick Nobody x` | `Player Nobody doesn't exist.` | nothing |
| `/promote Alice` | nothing | `[PROMOTE] Alice was added to the admin list by <server> and will be promoted upon joining the game.` |
| `/promote alice` | `alice is already in the admin list and will be promoted upon joining the game.` | nothing |
| `/demote Bob` | `Bob is not in the admin list.` | nothing |
| `/demote ALICE` | nothing | `[DEMOTE] ALICE was removed from the admin list by <server> …` |

- Matching is case-insensitive throughout.
- The help texts (`core.cfg`, `[command-help]`) are `ban=<player> <reason>`, `kick=<player> <reason>`,
  `unban=<player>`, `promote=<player>`, `demote=<player>`. A first word is the name; the rest is the reason.
- **None of these flag the save.** `game.console_command_used` stayed `false` after `/ban`, `/unban`, `/kick` (of a
  player not online), `/banlist add`, `/promote` and `/demote`. fa/world-settings found the same for `/promote` and
  `/demote`.
- **A reason is inert text.** `/ban Name reason with /c game.print(1)` banned `Name` with that reason, and the flag
  stayed `false`. An RCON body holding a newline (`/ban NL one\n/c game.print(2)`) banned `NL` with the reason
  `one\n/c game.print(2)`, the second line included; nothing ran. Cleaning a reason is about display and log lines,
  not about injection.
- Factorio itself checks no name: `/ban Weird"Name x` and a 70-character name were both banned.

**The name rule.** The game's own text for a player name (`core.cfg`, `username-invalid-characters`) is "Please only
use letters, numbers, and the characters ._-". factorio.com's registration texts say 2 to 30 characters,
"alphanumeric characters and .-". So **a dot is allowed**, and the rule is `^[A-Za-z0-9_.-]{1,60}$`. That is the
rule fa/world-settings already uses for admins (`GAME_SETTINGS.admin`). It is kept at 1 to 60 rather than 2 to 30:
older accounts and LAN names may fall outside the registration rule, and nothing is gained by refusing them.

**Not checked** (each needs a game client, so they are production smoke steps):

- `/kick` of a player who is online: its reply, whether the player sees the reason, and whether the flag stays
  `false`. The locale has `player-was-kicked=__1__ was kicked by __2__. Reason: __3__.`
- Whether `/ban` disconnects a player who is online. The locale has `player-banned=Your username is banned in this
  game. Reason: __1__.` for the next join.

**Other commands 2.1 has** (left out of scope): `/whitelist <enable/disable/add/remove/get/clear>`, `/mute`,
`/unmute`, `/mutes`, `/purge` and `/banlist clear`.

---

## Decisions

| Question | Decision |
|---|---|
| What counts as a portal mod update | A newer release for the server's Factorio **line** that **fits the installed Factorio** (its `base` and other game-mod limits, as `resolve` checks them). A newer release that needs a newer Factorio is listed apart, as "needs a newer Factorio", and isn't counted. So the badge never says "1 update" for a mod the sheet then leaves as it is. |
| Portal reads | The line's list the mod browser already reads (one read, kept 15 minutes, shared), through the Import mod list's `check`. Then `mod(name)` only for the candidates, capped at 20. A mod missing from the list is read one by one as `check` already does, capped at 20. |
| Planning them all | **Update N mods…** opens the existing sheet with every updatable mod set to "Newest that fits" (`version: null`) and the others at the version they run. Then the normal catalog, "What changes" and Update. No new update path. |
| Discord notice | A hub-core typed `Notice`, `modUpdates`, worded in `format.ts`, to **the server's channel**. That is where a factorio server's game updates are already posted, and `channelFor` sends every server notice there. The alerts channel takes only host, service and check events; routing one server notice there would need a target event or a `channelFor` special case, for no gain. |
| At most once a day | Persisted: a new table, `mod_update_notices`, holds the set last posted and when. The hub restarts at every deploy, so memory would repost. `meta` holds one integer per key and can't hold a set. |
| Settings | None. The check runs every 6 hours, the notice at most once a day. |
| Where moderation goes | A **Moderation** section at the top of the existing **Players** tab, for a factorio server only. The tab stays the same for Minecraft. No new tab. |
| Features flag | None. `Features` is one line, and fa/world-settings adds `settings` to it. The section shows for `card.game === 'factorio'` and asks the hub, whose answer says what is possible (an older Agent, a stopped server, an older hub's 404). |
| Where the lists come from | The two files, read by the Agent on request (`playerLists`): `/bans` and `/admins` can't be parsed. The files are untrusted, so they drive display only. |
| Who is online | The server's latest heartbeat, as the card has it (`players`). |
| How an action is confirmed | By reading the file again after the command (ban, unban, promote, demote), or by a fresh `/orrery-status` (kick). Never by parsing Factorio's reply. The dashboard's words come from a fixed set of outcomes. |
| Kick | Only for a player online in the Agent's latest status (a fresh one if the latest lacks them), as `link` is. A kick of anyone else is answered "not online" and sends nothing. |
| Reasons | Optional, for Kick and Ban only. The hub refuses a bad one (400); the Agent cleans it again whatever it gets: at most 200 characters on one printable line. |
| Server stopped | The lists still show (they are files), but every action needs RCON, so they are disabled with a word why. Changing admins while stopped is the Settings tab's. |
| Admins | Promote and Demote here and the Settings tab's admins edit the same file through the same commands. After a promote or demote, the Agent reads the settings again and pushes `settings`, so the Settings tab follows. |
| User verification off | The Agent reports `require_user_verification` from `server-settings.json` with the lists. With it off, the section says that a ban by name stops no one. |
| Freshness | No push. The section asks on open, after its own action (the reply carries fresh lists), on the server's `join` and `leave` events (debounced 2 s) and on Refresh. An in-game `/ban` of someone online shows at once through their `leave`. |
| Discord for moderation | Nothing posted. It is audited. |
| Versions | Settings and save uploads shipped first (`hub-v2.18.0` to `hub-v2.19.1`, `web-v0.16.0` and `web-v0.17.0`, `agent-v1.2.0` and `agent-v1.3.0`), so this ships as `hub-v2.20.0`, `web-v0.18.0` and `agent-v1.4.0`. The texts below use them. |

---

## Part 1: portal mod updates

### What the hub works out

New method `FactorioCatalog.updates(factorio, mods, gameMods)` in `hub/src/updates/factorio.ts`, added at the end of the
class next to `check`:

1. `line = lineOf(factorio)`. The names are the installed mods that aren't `GAME_MODS` (so `orrery` counts: it is a
   portal mod). The Agent's `installed` names pass only the wire's length limit, so a name that fails `validName` is
   never sent to the portal: it goes straight to `unchecked`. Nothing from the Agent becomes a portal URL's path.
2. `check(line, names)`. That reads the line's list (`#list`, kept `LIST_MS`, 15 minutes, the two most recent lines,
   shared with the mod browser), and reads one by one the first `CHECK_READS` (20) names the list lacks. Each name is
   then `fits` with `latest`, `noRelease`, `missing` or `unchecked`.
3. The **candidates** are the `fits` whose `latest` is newer than the installed version (`compareVersions`). An
   installed version newer than the portal's (a dev build) is not a candidate.
4. For the first `UPDATE_READS` (20) candidates by name: `mod(name)` (kept `CACHE_MS`, 5 minutes, through `#slot`,
   so at most 4 portal reads at once), then `#choose(name, releases for the line, null, [], factorio, gameMods)`. That
   is the newest release for the line whose game-mod limits the installed Factorio meets.
   - Newer than the installed one: an **update**, `{ name, title, from, to }`.
   - Otherwise (`#choose` gave a reason, or only the installed release fits): **later**, `{ name, title, latest }`:
     its newest release needs a newer Factorio.
5. Candidates past the cap are `unchecked`. `missing` and `noRelease` names are `gone`: the portal has nothing for this
   line, so a game update can't keep them.

Limits that other picked mods put on each other (`resolve`'s rounds) are not applied here. The sheet's catalog applies
them, and when one bites it shows as an unresolved dependency, as it does today.

**Cost.** A server with 30 portal mods, all in the line's list, two of them with updates: one list read (often
already cached by the mod browser) and two mod reads. At most one list read, 20 reads for unlisted names and 20
for candidates per call, and the caches make a second call within 5 minutes free.

### `hub/src/updates/mod-updates.ts`: `ModUpdates`

Hub core, made by `startHub` whenever `GameUpdates` is (game updates on, agents and systemd). For a server an Agent
runs (`GameUpdates.has`; others 404):

- `state(id)`: `ModUpdatesState` for what the server runs now: `GameUpdates.state(id).installed`, and the enabled
  game mods in it.
  - Before the Agent's first `installed`: every list empty, with `factorio` and `checked` null.
  - The answer is kept per server with its `installed`. It is worked out again when `installed` changed, or when it
    is older than 15 minutes. One computation runs per server at a time; the others wait for it.
  - A portal failure keeps the last good answer, with its `checked` time, and sets `error` to the `GameRefused`
    message.
- **The check.** Every 6 hours (`CHECK_MS`), and first 10 minutes after the hub starts, for each such server. It is
  skipped while a game update runs on it or before its first `installed`. Each check is `state(id)` and then the
  notice rule.
- **The notice rule.** A server's set is its updates as `name@to` keys. Its row in `mod_update_notices` holds the set
  last posted and when.
  - It posts when the set holds a key the last post didn't, and the last post was 24 hours ago or more (or there was
    none). The row then takes the current set and the time.
  - New keys found sooner wait. The next check after the 24 hours posts them, if they are still there.
  - An empty set clears the stored set and keeps the time, so a later release posts again, still once a day at most.
  - A set that only shrank (mods were updated) posts nothing.
- The notice: `ServerHub.publish(id, { kind: 'modUpdates', severity: 'info', factorio, mods, count })`. `mods` holds
  the first 10 updates by name, `{ name, from, to }`, and `count` all of them. It goes on the stream as every notice
  does; the Game tab reads it as "ask again".

`hub/src/stats/db.ts`: a table `mod_update_notices (server_id TEXT PRIMARY KEY, mods TEXT NOT NULL, at INTEGER NOT NULL)`,
`mods` a JSON list of at most 500 keys, with `modUpdateNotice(id)` and `setModUpdateNotice(id, mods, at)`. A row for a
server that left the config is harmless and stays.

### Route and types

`hub/src/web/web.ts` gets a block `if (modUpdates)`, kept apart from the game update routes:

- `GET /api/servers/:id/game/updates` gives `ModUpdatesState`. 404 for an unknown server or one no Agent runs. A
  read, not audited. It can't cause more portal reads than the caches above allow.

`hub/src/api.ts`, a new section after the Import mod list's types:

```ts
/** An installed portal mod with a newer release that fits the server's Factorio: from the version it runs, to the newest that fits. */
export type ModUpdate = { name: string; title: string; from: string; to: string };
/**
 * `GET /api/servers/:id/game/updates`: the portal mod updates of what a factorio server runs (`factorio`, null
 * before its Agent's first report), as the hub last read the mod portal (`checked`, epoch ms). `later`: a newer
 * release that needs a newer Factorio. `gone`: no release for this Factorio line on the portal any more. `unchecked`:
 * past the hub's cap on portal reads. `error`: why the last read failed (the lists are then the last good ones).
 * Titles are the portal's, checked and cut: show them as text.
 */
export type ModUpdatesState = {
  factorio: string | null;
  checked: number | null;
  updates: ModUpdate[];
  later: { name: string; title: string; latest: string }[];
  gone: string[];
  unchecked: string[];
  error: string | null;
};
```

`hub/src/types.ts`, a new member at the end of `Notice`:

```ts
/** Newer portal mod releases fit a factorio server's Factorio: the first 10 by name, and how many in all. */
| { kind: 'modUpdates'; factorio: string; mods: { name: string; from: string; to: string }[]; count: number }
```

### UX: the Game tab

On the summary card (`game.ts`), only when the hub answered `GET …/game/updates`:

- Beside the "Installed" heading, a badge with words: **3 updates** (`data-updates`). None: a muted "Mods up to date"
  with "as of 14:02" in its `title`.
- Each mod chip with an update gets a suffix, `→ 0.16.3`, in the brand colour, with `title="0.16.3 is on the mod
  portal for Factorio 2.1"` and screen-reader text "update available: 0.16.3". The colour is never the only sign.
- Under the **Update game** button, an outline button **Update 3 mods…** (`data-update-all`). It is disabled, with the
  same reason, whenever **Update game** is (`blocked`). It opens the sheet with the Factorio version the server runs,
  each updatable mod at "Newest that fits" and the others at the versions they run, then asks the catalog. Everything
  after that is the existing sheet: "What changes", unresolved dependencies, the Update button and its dialog.
- Muted lines under the chips, each only when it has names:
  - "Newer releases need a newer Factorio: Krastorio2 2.1.0." (`later`)
  - "Not checked (more than 20 at once): a, b." (`unchecked`)
- An amber line for `gone`: "Not on the mod portal for Factorio 2.1 any more: oldmod. A game update can't keep it:
  remove it in Update game."
- `error`: a muted "Couldn't check the mod portal: <error>", with the last answer still shown and its time.
- While the first answer is coming, a muted "Checking the mod portal for updates…". Nothing moves when it lands.

The tab asks again on open, on `packUpdateFinished`, on a `modUpdates` notice, and when `installed` changes. A 404
(an older hub than the dashboard) hides all of it: the tab is as it is today.

### The Discord notice

`format.ts`, an `info` embed in the server's channel. Its title is "Portal mod updates". Its text, for example:

> 3 portal mod updates fit Factorio 2.1.24 on **orrery Factorio**: `flib` 0.16.2 → 0.16.3, `Krastorio2` 2.0.1 →
> 2.0.2, `space-exploration` 0.7.1 → 0.7.2. Update them from the dashboard's Game tab.

With more than 10, the list ends "and 4 more". Mod names and versions come from the portal (names checked with
`validName`, versions with `VERSION`) and go through `inline()`. The server name is `md()`'d as elsewhere. One update
reads "1 portal mod update fits …".

### Tests (part 1)

- `hub/test/factorio.test.ts`, `updates` with a fake `PortalFetch`:
  - a mod newer in the list that fits is an update;
  - one whose newest release needs `base >= 2.1.30` against 2.1.24 is `later`;
  - an installed version newer than the portal's is nothing;
  - a mod not in the list goes through `check`'s one-by-one read; `missing` and `noRelease` become `gone`;
  - 25 candidates: 20 read, 5 `unchecked`;
  - game mods are never asked; `orrery` is;
  - an installed name holding `..` or `/` is `unchecked`, with no fetch;
  - the fetch spy counts one list read for two calls within 15 minutes, and no mod read for a mod with no candidate.
- `hub/test/mod-updates.test.ts`, the whole hub with `test/fake-agent.ts` and a fake portal:
  - `GET` without a session is 401, a Minecraft server 404; the state before and after `installed`;
  - an `installed` change works it out again; a portal failure keeps the last answer with `error`;
  - the notice rule, on a fake clock: the first check posts; the same set doesn't; a new key within 24 hours waits
    and posts after them; an empty set lets a later release post; a set that shrank posts nothing;
  - a new hub on the same database file doesn't post the same set again;
  - no check while a game update runs; the notice's `mods` capped at 10, with `count`.
- `hub/test/format.test.ts`: the wording for 1, 3 and 14 updates, and a mod name holding `_` and `*` escaped.
- `hub/test/db.test.ts`: the table's round trip.
- `web/src/app/servers/game.spec.ts`:
  - the badge, the chips' suffixes and their screen-reader text;
  - **Update N mods…** opens the sheet with `null` for the updatable mods and the installed versions for the others,
    checked in the catalog request's body;
  - the `later`, `gone`, `unchecked` and `error` lines;
  - asked again on `packUpdateFinished` and on a `modUpdates` notice;
  - a 404 shows none of it.

---

## Part 2: moderation

### UX: the Moderation section

At the top of the Players tab of a factorio server (`players.ts` gets one `@if` and an import), above the lookup and
the most-played lists, which stay as they are. One new component, `moderation.ts` (`ModerationSection`), in the same
lazy chunk.

```
Moderation                                            [Ban a player…] [Refresh]
┌ Online now (2) ──────────────────────────────────────────────────────────────┐
│ alice   Admin                                   [Kick…] [Ban…] [⋯ Demote]    │
│ bob                                             [Kick…] [Ban…] [⋯ Promote…]  │
└──────────────────────────────────────────────────────────────────────────────┘
┌ Bans (3) ─────────── [filter] ─┐ ┌ Admins (2) ──────────────────────────────────┐
│ griefer_1  stealing iron  [Unban]│ │ alice [Demote]  carol [Demote]           │
│ noreason   (no reason)    [Unban]│ │ [name        ] [Promote…]                │
└──────────────────────────────────┘ └──────────────────────────────────────────┘
```

- **Online now**: one row per name in the card's `players`, with an "Admin" badge (a word) for a name in the
  adminlist (case aside). Each row has **Kick…**, **Ban…** and a ⋯ menu with **Promote…** or **Demote**.
  - A name that fails the rule (from a heartbeat, so up to 64 printable characters) gets disabled buttons with
    `title="This name can't be moderated from the dashboard: use the Console tab."`.
  - Nobody on: "Nobody is online."
- **Bans**: a row per entry, name and reason ("(no reason)" when none), and **Unban**. A filter input when there are
  more than 20. With more than 500: "Showing 500 of 1,234 bans, by name." With entries whose names fail the rule:
  "2 bans have names the dashboard can't show: see `/bans` in the Console tab."
- **Admins**: the names as chips, each with **Demote** (`aria-label="Demote alice"`). An input and **Promote…** take
  one name, checked as typed: "Names are 1 to 60 letters, digits, `_`, `.` or `-`." The same words as the Settings
  tab. A muted line: "Admins can also change in the Settings tab, also while the server is stopped."
- **Ban a player…** opens the Ban dialog with an empty name field, for someone offline or never seen.

**The dialogs** (`moderate-dialog.ts`, a spartan alert dialog with a form, in the same chunk):

- **Ban** (the confirm the owner asked for): title "Ban griefer_1?". Body: "They are disconnected if they are online,
  and can't join again until unbanned. Factorio shows them the reason." (Unchecked so far: the production smoke step
  confirms it, or the wording changes.) Then **Reason** (optional), with a counter
  "0/200", and **Cancel** and **Ban** (destructive). With verification off, the body adds the warning below.
- **Kick**: title "Kick bob?", body "They are disconnected and can join again at once.", the same optional reason, and
  **Kick**.
- **Promote** goes through `Feedback.confirm`: title "Make bob an admin?", body "Admins can kick, ban and pause, and
  run Lua commands when commands are on for admins.", verb **Promote**.
- **Unban** and **Demote** have no dialog: each undoes itself.

The reason field refuses what the hub refuses (a line break, a control character, over 200), inline, with
`aria-describedby`.

**After an action** the section takes the lists from the answer, and a toast says the outcome:

| outcome | toast |
|---|---|
| `done` | "griefer_1 is banned." / "bob was kicked." / "griefer_1 is unbanned." / "bob is an admin." / "bob isn't an admin any more." |
| `already` | "griefer_1 was banned already." (and the like), as a plain toast |
| `notOnline` | "bob isn't online any more." |
| `unconfirmed` | sticky: "Sent, but the banlist doesn't show it yet: check the Console tab." (the adminlist for promote and demote; "bob is still online" for kick) |

The hub's refusals (400, 409, 429, 502) are sticky toasts with the hub's text. A button shows a spinner while its
request runs, and every action button is disabled meanwhile.

**States**

- **User verification off** (`lists.verification === false`): an amber line at the top. "User verification is off
  (Settings tab): names aren't checked, so a banned player can join again under another name."
- **Server stopped** (the card isn't online): the lists show, and each action is disabled. "The server is stopped:
  start it to kick, ban, unban or change admins here." The Admins line points to the Settings tab.
- **The Agent isn't connected**: "The Agent isn't connected: the lists come back when it is." Online now still shows
  the card's players (empty while the server is lost).
- **An older Agent**: "This server's Agent runs agent-v1.3.0, which can't moderate players. Deploy agent-v1.4.0 or
  later from the Host page (Releases)." Online now shows without buttons, and no lists.
- **A file problem** (`lists.problem`): an amber line with the Agent's reason, such as "server-banlist.json can't be
  read: not a JSON list." The other list still shows.
- **An older hub** (its 404, the dashboard ahead): "This hub has no player moderation yet: deploy hub-v2.20.0 or
  later." The rest of the Players tab is as today.
- Loading: skeletons for the three cards.

**Accessibility**: every button names its player (`aria-label="Kick bob"`, "Ban bob", "Unban griefer_1"). The badge
and the outcomes are words, never colour alone. The dialogs take the focus and give it back. The name input's error
is tied to it with `aria-describedby`.

**Asking again**: on open, on Refresh, after each own action (from its answer), and on the server's `join` and
`leave` events, debounced 2 s. Nothing polls.

### Hub: `hub/src/servers/moderation.ts`, `Moderation`

Hub core, made by `startHub` with `integrations.agents`. For a server an Agent runs (`has`; others 404). It uses
`Agents` (requests and versions), `ServerHub` (the server's state and players, and `audit`), and nothing else.

- `state(id)`: `ModerationState`.
  - `online`: the server's players from its latest heartbeat (`ServerHub.get(id).players`).
  - `blocked`: why actions are refused now, or null. In this order: the Agent below `MODERATION_FLOOR`
    (`agent-v1.4.0`; the dev loop's `agent-v0.0.0` counts as newer, as for `beforeAgentFloor`), with the deploy text
    above; the Agent not connected; the server not online (no game connection, so no RCON).
  - `lists`: the Agent's `playerLists` answer, or null when the Agent is older or not connected, or didn't answer.
    Calls for the same server share one request in flight, and an answer is reused for 2 s. So at most one
    `playerLists` per server per 2 s, whatever the dashboards do.
- `act(id, body, by)`, answering `ModerateAnswer`:
  - **400**: `action` not one of the five; `player` failing the rule; a `reason` that isn't a string, or is given with
    `unban`, `promote` or `demote`, or holds a control character, a line or paragraph separator or a bidi control, or
    is over 200 characters once trimmed. Each refusal names the field, never echoes the value.
  - **409**: `blocked`, with its text; or another `moderate` already running on that server ("A moderation request
    is already running on <server>.").
  - **429**: over 20 actions in a minute on that server (a token bucket, 20 in bursts of 20).
  - Else it sends `moderate` (30 s). The Agent's error is a 502 with its text.
  - **Audit** (action `player <action>`, target the server, actor the admin's name, as every dashboard action), once
    the Agent answered or failed: for example `griefer_1 (reason: stealing iron): done`, `bob: not online`,
    `alice: failed: the server isn't running`. A reason in the audit is cut to 200, as sent.

`hub/src/web/web.ts` gets a block `if (moderation)`, kept apart from the others:

- `GET /api/servers/:id/moderation` gives `ModerationState`. 404 unknown, or no Agent runs it. Not audited.
- `POST /api/servers/:id/moderation` takes `ModerateRequest` and answers `ModerateAnswer`.

Types in `hub/src/api.ts` (its own section), built on new ones in `types.ts` that the Agent shares:

```ts
// hub/src/types.ts
/** What the dashboard may do to a factorio server's player, through its Agent and Factorio's own commands. */
export type ModerateAction = 'kick' | 'ban' | 'unban' | 'promote' | 'demote';
/** A ban as the server's banlist has it: the name (lowercased by Factorio) and the reason given, if any. */
export type Ban = { name: string; reason: string | null };
/**
 * A factorio server's bans and admins as its Agent read them from Factorio's files: at most 500 bans by name
 * (`bansTotal` counts all whose names pass the rule; `hidden`, those that don't), the admins, and whether
 * server-settings.json checks players' accounts (null: unreadable). `problem`: why a file can't be read.
 */
export type PlayerLists = {
  bans: Ban[];
  bansTotal: number;
  hidden: number;
  admins: string[];
  verification: boolean | null;
  problem: string | null;
};
/**
 * How an action ended: `done`; `already` (banned already, not banned, an admin already, not an admin); `notOnline`
 * (a kick of someone not on: nothing sent); `unconfirmed` (sent, but the file or the status doesn't show it).
 */
export type ModerateOutcome = 'done' | 'already' | 'notOnline' | 'unconfirmed';

// hub/src/api.ts
/**
 * `GET /api/servers/:id/moderation`: who is online (the latest heartbeat), the lists (null while its Agent is older
 * or away), and why actions are refused now (`blocked`).
 */
export type ModerationState = { online: string[]; lists: PlayerLists | null; blocked: string | null };
/** `POST /api/servers/:id/moderation`. `reason` only for kick and ban. 400 bad input, 409 blocked or busy, 429 too many, 502 the Agent. */
export type ModerateRequest = { action: ModerateAction; player: string; reason?: string };
/** The outcome, and the lists read again after it. */
export type ModerateAnswer = { outcome: ModerateOutcome; lists: PlayerLists };
```

### Agent: `agent/src/moderation.ts`, `Moderation`

Wired in `index.ts` with the server's data folder, the RCON session the hub's commands use (`run`), the
`StatusPoller` (its players, and a fresh status) and `ServiceWatch` (the unit's state).

**`lists()`** (the `playerLists` handler):

- The banlist is `<data>/server-banlist.json`, the adminlist `<data>/config/server-adminlist.json`, and
  `<data>/config/server-settings.json` gives only `require_user_verification`. Each is read through its folder,
  opened once with `O_DIRECTORY` and `O_NOFOLLOW` as `saves.ts` does, and `files.ts`'s `openPlain` (`O_NOFOLLOW`,
  `O_NONBLOCK`, a regular file on that folder's filesystem), at most 1 MiB.
- A missing banlist is no bans (Factorio writes it at the first ban). A missing adminlist is no admins.
- The banlist must be a JSON list. Each entry is a string, or an object whose `username` is a string; its `reason`
  is taken when it is a string. **Every other key, `address` included, is ignored and never copied.**
  - A name that fails the rule is counted in `hidden` and dropped.
  - A reason goes through `cleanReason` (below) and is cut to 200 characters; an empty one is null.
  - The bans are sorted by name and cut to 500; `bansTotal` counts all the good ones.
- The adminlist must be a JSON list of strings. Names that fail the rule are dropped. The first 100 are kept.
- A file that can't be read or isn't that shape: that list is empty, and `problem` says which file and why, in fixed
  words ("server-banlist.json can't be read: not a JSON list", "… larger than 1 MiB", "… not a regular file").
  Nothing from the file goes into `problem`.
- `verification` is `require_user_verification` when it is a boolean, else null.

**`act({ action, player, reason })`** (the `moderate` handler):

1. The fields were checked by `readAgentLine` (below). The module checks the rule again and cleans the reason
   again, whatever arrived.
2. One at a time: a second request while one runs is refused, "a moderation request is running". It refuses too while
   the unit isn't `active` or RCON doesn't answer: "the server isn't running".
3. Read the lists (the "before").
4. **Kick** only: the name must be in the poller's latest players, or else in a fresh `/orrery-status`, ignoring case.
   Else the outcome is `notOnline` and nothing is sent. The command uses the status's spelling of the name, which
   passed both the status checks and the rule.
5. Build the command from a fixed table, the checked name and the cleaned reason:
   - `kick`: `/kick <name>` or `/kick <name> <reason>`;
   - `ban`: `/ban <name>` or `/ban <name> <reason>`;
   - `unban`: `/unban <name>`; `promote`: `/promote <name>`; `demote`: `/demote <name>`.

   Send it on the commands RCON session, with a 10 s timeout. A timeout or a lost connection rejects ("Factorio
   didn't answer").
6. Read the lists again (the "after"), and decide the outcome:
   - `ban`: `done` if the name is a ban now and wasn't before; `already` if it was before; else `unconfirmed`.
   - `unban`: `done` if it was before and isn't now; `already` if it wasn't before; else `unconfirmed`.
   - `promote` and `demote`: the same against the admins.
   - `kick`: `done` once a fresh status lacks the name (asked twice, 1 s apart), else `unconfirmed`.

   Factorio's reply is never read for the outcome, and never sent on.
7. For `promote` and `demote`, the Agent asks `GameSettings` (fa/world-settings) to read the files again and push
   `settings`, so the Settings tab follows.
8. Reply `{ outcome, lists: after }`. Log one line, `[moderation] ban griefer_1: done`: the action, the name and the
   outcome, never the reason.

**`cleanReason(text)`**: every character in C0, DEL, C1, U+2028, U+2029, the bidi controls (U+200E, U+200F, U+202A
to U+202E, U+2066 to U+2069) and U+FEFF becomes a space. Runs of whitespace become one space, the ends are trimmed,
and it is cut to 200 characters with `cut` (never half a surrogate pair). An empty result is no reason. The hub's
400 rule refuses exactly what cleaning would change, apart from the ends' spaces and the runs.

### Wire additions

Additive. No `PROTOCOL_VERSION` bump. Minecraft's Mod is untouched.

| Direction | Message | Fields | Notes |
|---|---|---|---|
| hub → Agent | `playerLists` | `id` | `reply.data`: `PlayerLists`. 30 s |
| hub → Agent | `moderate` | `id`, `action` (one of the five), `player` (`^[A-Za-z0-9_.-]{1,60}$`), optional `reason` (at most 200 characters, only with `kick` and `ban`) | `reply.data`: `{ outcome, lists }`. 30 s; the Agent answers within 15 s (the command's 10 s, then the reads) |

**Limits**, new in `LIMITS` (hub `protocol.ts`, and the Agent's copy in `wire.ts`, which `wire.test.ts` pins):

- `bans`: 500 entries;
- `reason`: 200 characters (a ban's `reason` in `PlayerLists`, and a `moderate`'s `reason`);
- `admins`: 100 entries, the same key and value fa/world-settings adds (one key once both merge).

A name in a ban, in `admins` or in `moderate` must pass the rule; `problem` is `LIMITS.detail` (2 KiB). The largest
reply, 500 bans of a 60-character name and a 200-character reason, is about 150,000 characters of JSON: under
`LIMITS.replyData` (256 KiB). The name rule sits next to `LIMITS` in both files as `PLAYER_NAME`; `wire.test.ts`
checks the two are the same.

`REPLY_DATA` in `protocol.ts` gets `playerLists` and `moderate`, so `parseReplyData` copies only those fields and
refuses one over a limit. `AgentRequest` and `AgentReplyData` in `types.ts` get the two requests. `readAgentLine`
checks both on the Agent's side.

**Budgets.** Both are the hub's requests, so the Agent's replies take only the line budget, as every reply does. The
hub bounds what it sends:

- `playerLists`: one in flight per server and an answer kept 2 s, so at most one per 2 s;
- `moderate`: one in flight per server, and 20 a minute per server (the 429 above).

The Agent also runs one `moderate` at a time. So the commands a dashboard can put on RCON are bounded at both ends.

Places that change together: `hub/src/types.ts`; `hub/src/protocol.ts` (`LIMITS`, `PLAYER_NAME`, `REPLY_DATA`);
`agent/src/wire.ts` (`readAgentLine` for the two requests, the `LIMITS` copy, `PLAYER_NAME`) with
`agent/test/wire.test.ts`; `docs/protocol.md` ("Hub → Agent" rows, "Field limits" rows, a "Rate rules" line saying
the hub bounds these two itself, and the skew below).

**Version skew**, stated in `docs/protocol.md`:

- A hub older than this never sends them.
- An Agent older than `agent-v1.4.0` is never sent them: `MODERATION_FLOOR` blocks first, and the dashboard shows the
  deploy text. If one were sent anyway, its `readAgentLine` finds no schema for the type and returns
  `{ msg: null, id, why: 'unknown type' }`, so `HubClient` answers `{ ok: false, error: 'unknown type' }`. The hub
  passes that on as a 502: "<server>'s Agent can't moderate players (unknown type): deploy agent-v1.4.0 or later."

### Trust

**The RCON rule in `agent/CLAUDE.md`.** fa/world-settings changes it to allow `/config set`, `/promote` and
`/demote`. This adds `/kick`, `/ban` and `/unban`. Like that change, it is the owner's decision. The merged bullet,
replacing both branches' texts:

> RCON commands the agent builds are the mod's own commands with one line of JSON as the argument, and Factorio's
> built-ins `/config set <option> <value>` (the option from a fixed table in `settings.ts`, the value one it
> validated: one line, printable, within its field's limit), `/promote <name>`, `/demote <name>`, `/unban <name>`,
> `/kick <name> [reason]` and `/ban <name> [reason]` (the name checked against `^[A-Za-z0-9_.-]{1,60}$`, a kick only
> for a player online at the latest `/orrery-status`, the reason cleaned by `cleanReason`: one printable line of at
> most 200 characters). These were checked on 2.1.24 not to flag the save. The first-boot check also sends the
> built-in `/help`. Never Lua, never `/c` or `/sc`, which would flag the save for good.

It is no weaker than today in effect. The Console tab already sends what the owner types to RCON as is, `/ban`
included. These commands come only from a fixed table and checked values, and none flagged the save. If the owner
says no, moderation goes and the rest of this note stands.

The other rules, all kept:

- **The two files are container-written, so untrusted.** They drive display only. No name or reason from a file ever
  goes into a command. An Unban sends the name the admin's request carries, which the hub and the Agent check again
  by the rule, as for any typed name. Names that fail the rule are hidden and counted; the Console tab is the way for
  them.
- **No address leaves the Host.** The banlist's `address` (and any other key) is never copied.
- **The outcome comes from the files and the status, never from Factorio's reply.** The dashboard's words come from
  the four outcomes. Factorio's reply text reaches no reply, log or audit.
- **Kick only for someone online,** by the poller's checked list or a fresh one, as `link` is.
- **Reasons** are refused by the hub and cleaned by the Agent, so no reason can forge a log line or carry a bidi
  trick into the banlist or the dashboard.
- **Audited as the admin**: who, what, whom, the reason, the outcome.
- **Hub-side bounds**: one request in flight per server, 20 actions a minute, `playerLists` at most every 2 s.
- Everything from the Agent is checked by `parseReplyData` against the limits, and shown as text (Angular
  interpolation, never `innerHTML`).
- The Agent's own state stays under `/srv/orrery-agent`. Moderation writes nothing there and nothing under
  `/srv/factorio`: Factorio writes its own files.

### Tests (part 2)

- `agent/test/moderation.test.ts`, with the fake RCON (`test/fake-rcon.ts`) and files in a temporary data folder:
  - the rule: 1 and 60 characters pass, 61 fails; `a.b`, `a_b` and `a-b` pass; `a b`, `<server>`, `é`, `"x`, the
    empty name and a newline fail;
  - `cleanReason`: a newline, ` `, `‮`, a tab, a run of spaces, 201 characters, a surrogate pair at the cut,
    and spaces only (no reason);
  - the exact commands: `/ban griefer_1 stealing iron`, `/ban x` with no reason, `/kick Bob` with the status's
    spelling, `/unban`, `/promote` and `/demote`, one each, nothing else on RCON;
  - a kick of someone offline sends nothing and asks one fresh status;
  - the outcomes from the files before and after: `done`, `already`, `unconfirmed`; a kick whose player stays on is
    `unconfirmed`;
  - parsing: strings and objects; an `address` appears in no reply, push or log line (the test greps everything the
    run produced); a bad name counted in `hidden`; 501 bans cut to 500 with `bansTotal`; a symlinked banlist, a 2 MiB
    one, a FIFO and a malformed one each give `problem` and no bans;
  - one at a time; refused while the unit is inactive or RCON is down; a promote asks for the settings re-read;
  - the log line carries no reason.
- `agent/test/wire.test.ts`: `readAgentLine` for both requests (a bad action, a 61-character name, a 201-character
  reason, a reason with `promote`, an unknown field dropped); the `LIMITS` copies and `PLAYER_NAME` equal the hub's.
- `agent/test/hub.test.ts` and `agent/test/index.test.ts`: both handlers wired, and their replies through the fake
  hub's real `parseReplyData` (nothing refused).
- `hub/test/moderation.test.ts`, the whole hub with `test/fake-agent.ts`:
  - `GET` without a session is 401, a Minecraft server 404; `online` from the heartbeat;
  - an Agent at `agent-v1.3.0` is blocked with the deploy text, and nothing is sent to it;
  - not connected, and stopped (the lists, with `blocked`);
  - two `GET`s at once send one `playerLists`; a third within 2 s sends none;
  - `POST`: every 400 case (naming the field, never the value); 409 blocked, 409 while one runs, 429 on the 21st in
    a minute; a good one reaches the fake Agent exactly; the audit rows with the admin's name and the outcome;
  - an Agent that answers `unknown type` gives the 502 text above.
- `hub/test/protocol.test.ts`: `parseReplyData` for both (a ban over the limits, 501 bans, 101 admins, a bad name
  refused).
- `web/src/app/servers/moderation.spec.ts`:
  - online rows with the Admin badge; a bad name's buttons disabled with their title;
  - the Kick dialog sends its reason; the Ban dialog is a confirm with a destructive button and the counter; Unban
    and Demote send at once; Promote asks through `Feedback.confirm`;
  - the name input's rule; the reason's inline refusal;
  - each outcome's toast; the lists taken from the answer;
  - the states: verification off, stopped, not connected, an older Agent, a file problem, and an older hub's 404;
  - the 500-of line and the hidden line; the filter past 20;
  - asked again on `join` and `leave`, debounced.
- `web/src/app/servers/players.spec.ts` (new, small): the section shows for a factorio server only.

---

## Built

Built inline on 2026-11-02, after merging `main` (Settings and save uploads). Where the build differs from the
design above:

- **Kick and Ban** confirm in an inline panel under the Moderation heading (the reason with its counter, the hub's rule
  checked inline, Ban's button destructive), not in a dialog chunk of their own. Promote goes through
  `Feedback.confirm` as designed. An `unconfirmed` outcome is a sticky `Feedback.notice` (new).
- **The name rule** is `GAME_SETTINGS.admin` on both sides, the same regex; no separate `PLAYER_NAME`.
- **A symlinked or non-regular banlist** reads as no bans (`readIn` gives null for both), not as a `problem`. A file
  that isn't a list, or is over 1 MiB, is a `problem`.
- **`later`** is any installed mod whose newest release for the line `choose` doesn't take (in practice one needing a
  newer Factorio).
- **A ban, unban, promote or demote** reads the files again until they show it, 3 s at most, before `unconfirmed`, as
  Settings' admins wait for the adminlist. An unreadable `/orrery-status` never confirms a kick.
- **Rate**: 20 actions in any rolling minute per server, not a token bucket.
- **Modules**: `hub/src/updates/mod-updates.ts`, `hub/src/servers/moderation.ts`, `hub/src/web/web-game-extras.ts` (both route blocks),
  `hub/src/api-game-extras.ts` (re-exported by `api.ts`), `hub/src/updates/factorio-releases.ts` (the catalog's pure release
  helpers, moved so `ModUpdates` reuses `choose`), `agent/src/moderation.ts`, `web/src/app/servers/mod-updates.ts`,
  `web/src/app/servers/moderation.ts`.
- **The release-2 open minor** is fixed in the same release: a game update of a server stopped before it that fails
  after `updateResume`, before the swap, leaves it stopped (`failed in staging`); before, the Agent started it.

## Living next to fa/world-settings

- **Merge order.** fa/world-settings stage A merges to `main` first; it is well ahead. This branch then merges
  `main` in before its own merge, so the second merge is ours to resolve. If it is still unmerged when this is built,
  build on `main` as planned and resolve at the merge.
- **What that merge makes one thing:**
  - the name rule: its `GAME_SETTINGS.admin` and this note's `PLAYER_NAME` (the same regex) become `PLAYER_NAME`,
    used by both;
  - `LIMITS.admins` (100 in both);
  - the release check: its `beforeAgentRelease(version, floor)` in `agents.ts`. This branch uses it if it is on
    `main`, else adds the same function, and the merge keeps one;
  - the `agent/CLAUDE.md` RCON bullet: the merged text above.
- **Shared files**, edited at their ends or in blocks of their own: the `Notice`, `AgentRequest` and `AgentReplyData`
  unions in `types.ts` (a new member at the end: a merge keeps both); `protocol.ts` (`LIMITS` keys, `REPLY_DATA`
  rows); `api.ts` (a section of its own); `web.ts` (`if (modUpdates)` and `if (moderation)` blocks); `start.ts` (two
  blocks); `agent/src/hub.ts` handlers and `agent/src/index.ts` wiring (a block); `docs/protocol.md` (rows); the
  `CLAUDE.md` tables (new rows only, plus the one RCON bullet).
- **Admins.** Both features change `server-adminlist.json` through `/promote` and `/demote`. The Agent's
  `Moderation` calls `GameSettings` to read again and push `settings` after its own promote or demote (step 7). Until
  fa/world-settings is merged, that call isn't there, and nothing else needs it.
- **User verification.** `server-settings.json` can hold a value the running server doesn't have yet (fa/world-settings'
  `startedWith`). For the "a ban stops no one" line, the running value is the one that counts. Once merged,
  `Moderation` takes `verification` from `GameSettings`' `startedWith`; until then, from the file.
- **The Players tab** isn't touched by fa/world-settings, and the Game tab is touched only by this branch.

---

## Release

Shipped together with Settings (fa/world-settings stage A). Both branches merge to `main` before the cut.

1. Build on `fa/game-extras`. Verify as `CLAUDE.md` says (hub, agent and web), and run `deploy/test-setup-agent-host.sh`
   (no change expected: nothing in `deploy/` changes).
2. Release **`hub-v2.20.0`** and deploy it. Portal mod updates work at once: they need nothing from the Agent. The
   first check runs 10 minutes later, and the first Discord notice can come then.
3. Release **`web-v0.18.0`** and deploy it. Against `agent-v1.3.0`, the Moderation section shows the deploy text.
4. Release **`agent-v1.4.0`** and deploy it from the Host page (Releases). The friend does nothing: no unit, polkit
   rule or setup step changes.
5. Smoke on production:
   - Game tab: put an older release of a small mod on through Update game, then see "1 update", **Update 1 mod…**,
     and the update. Check that one Discord notice came, and no second one the same day.
   - With nobody on: ban a made-up name with a reason, see it listed, unban it.
   - Promote and demote a made-up name, and watch the Settings tab follow.
   - **With the friend online** (the steps this note couldn't check):
     - kick them with a reason: do they see it, and does the section show `done`?
     - ban them: are they disconnected at once, and do they see the reason when they try again? Then unban. If
       either answer is no, change the Ban and Kick dialogs' wording to match.
     - after each, check that `game.console_command_used` is still `false` (as the smoke notes read it).
   - If user verification is off by then: the amber line shows.

---

## Docs to update with the code

- `docs/protocol.md`: as listed in [Wire additions](#wire-additions).
- `agent/CLAUDE.md`: a modules row for `moderation.ts`; the `wire.ts`, `hub.ts` and `index.ts` rows (the two requests,
  `PLAYER_NAME`, the wiring); the RCON trust bullet (merged text); the tests.
- `hub/CLAUDE.md`: rows for `mod-updates.ts` and `moderation.ts`; the `factorio.ts` (`updates`), `db.ts`
  (`mod_update_notices`), `format.ts` (`modUpdates`), `types.ts`, `api.ts`, `web.ts` and `start.ts` rows; `Moderation`
  and `ModUpdates` in the list of modules frontends may call.
- `web/CLAUDE.md`: `moderation.ts` and `moderate-dialog.ts` in the servers row; the Game tab's update badge and
  **Update N mods…**; the Players tab's Moderation section.
- `CONTEXT.md`:
  - **Portal mod update**: a newer release of a portal mod a factorio server runs that fits its Factorio. The Game tab
    marks it, the hub posts it at most once a day, and installing it is a game update. _Avoid_: mod update (the Mod
    is the Minecraft one), upgrade.
  - **Moderation**: kicking, banning, unbanning, promoting and demoting a factorio server's players from the Players
    tab, through Factorio's own commands, which the Agent builds. _Avoid_: admin tools, mod actions.
  - **Ban**: a name on a factorio server's banlist, with an optional reason Factorio shows them. By name only, so it
    stops no one while user verification is off.
  - **Admin** comes from fa/world-settings; it gains "promoted and demoted from the Players tab too".
- `docs/ROADMAP.md`: a section for this work, linking this note. The mod browser's section still says "to cut as
  `hub-v2.16.0` … then `web-v0.14.0`"; it shipped, so that section moves to done.

---

## Out of scope

- Updating mods by itself, or on a schedule. The hub only says what is available.
- Notices for new Factorio releases (the Update game sheet already lists them), a per-mod "ignore this update", and
  settings for the check's interval or the notice's channel.
- Showing portal changelogs for an update.
- The whitelist, `/mute`, `/unmute`, `/purge` and `/banlist clear`.
- Bans by address, timed bans, and one banlist shared across servers.
- Editing the banlist while the server is stopped (the adminlist has the Settings tab for that).
- Discord posts for moderation, and Discord commands for any of this.
- Kicking or banning from Discord or the Chat tab, and moderation for Minecraft servers.
- Masking a `/ban` reason typed in the Console tab's audit: the Console tab audits commands as typed.

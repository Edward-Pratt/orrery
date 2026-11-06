# servers

The servers' pages, Minecraft and factorio: one row per server (`cards.ts`, skeletons while loading; `changes.ts`'s
`changesCard`, the events that change a card (lifecycle, `lost` too, and a factorio server's `paused`), kept apart so
the shell's attention strip doesn't load the page; with `newServer` on, New server (`new-server.ts`, a deferred
full-height sheet: id, name, game port, memory, pack version from `GET /api/library`, its start script from
`…/scripts` (a looping one preselected, its loop edit pre-ticked), the runtime (the newest; System java), the EULA
tick; checked as the hub checks them; the hub's refusals as toasts), the running install's card from `install` events
(a failure's reason in red), and each Pending server as a dashed row with a "Waiting for setup" badge linking to
`waiting.ts` (`/servers/waiting/<id>`, routed before `:id`: the setup command with Copy, after the script's install
line when the hub sends one, and Discard, typed id); `row.ts`: state dot and word, amber while `lagging`, the card's
rate (TPS or UPS, by its `rate.label`; "Paused" while `paused`), player count, 24 h uptime, and the actions its state
allows: Restart (5-minute countdown, no dialog) and Console with a ⋯ menu of Stop and Restart now online, Start
offline, the countdown and Cancel while a restart is pending; a linked server's Start and Stop go through
`ServiceControl`; tapping the row outside its buttons opens the page; live TPS from `tps` events, cards re-fetched on
lifecycle, join/leave, `paused`, restart and lag notices and on a linked service's `state` events; nothing polls) and
a server page: a shell (`server.ts`: header with name, state, the linked service's line and `actions.ts`'s
`ServerActions` (also the row's; `full` adds "Restart in…" and "Audit log for this server" to its ⋯ menu), then tabs
from `SECTIONS` the server has (Console with `features.console`; Game with `features.update`, which `hub-v2.14.0`
reports false; Settings with `features.settings`; Backups named Saves on a factorio server); its `detail` is fetched
again, debounced, on the events that change a card and on backup notices, or on `refresh()`) over lazy child routes,
one per section (`overview.ts`: who's online, 24 h rate (the card's `rate`: label and scale; "Paused" beside it while
`paused`) and players sparklines linking to History, a pending restart with Cancel; `chat.ts` (each line starts with
its local time from the event's `at`, the day too before today; sent lines tagged `Discord` or `Dashboard`; a factorio
server's `milestone`s as "Research finished: …", "First rocket launched from …", "First space platform in orbit: …" or
"First landing on …", then "by <player>" and "(force <name>)" when the event has them) and `console.ts` (only with
`features.console`; a factorio command keeps its `/`, e.g. `/players`; a refused one shows the hub's why, such as a
factorio command over 256 characters, kept in the box (no `maxlength`: a cut paste would run); full-height logs that
stick to the bottom, `log.ts`'s `StickBottom`; console output is shown from the stream only; ↑/↓ step through the
commands this browser ran on the server and ☆ saves the box's command as a chip, both in `localStorage` under
`orrery.console.<serverId>`, ☆ hidden without storage); `players.ts` (`/stats` redirects): on a factorio server first
`moderation.ts`'s `ModerationSection` (`GET …/moderation`: who is online with an Admin badge, Kick… and Ban… (an
inline confirm under the heading with an optional reason, its counter and the hub's rule checked inline; Ban's button
destructive; Ban a player… takes a typed name), Promote… (`Feedback.confirm`) or Demote; the bans with their reasons
("(no reason)") and Unban, a filter past 20, "Showing 500 of N" and the hidden count; the admins as chips with Demote
and a Promote… input checked by the name rule; each action a `POST`, its answer's lists shown and its outcome a toast
(`unconfirmed` a sticky `Feedback.notice`); lines for verification off, `blocked`, a file `problem`; an older hub's
404 names hub-v2.20.0; asked again on Refresh, after a kick, and on the server's join and leave, 2 s apart at most),
then the lookup as a card, top players per period as tables (side by side, or a Day / Week / All toggle-group on a
phone); `player.ts`: `PlayerCard`, and `PlayerCards`/`appPlayer` that open any player name's card in a dialog;
`backups.ts` (only with a backup folder; a factorio server's saves, in save words: Saves, Save now, Saving…, each
marked Named, Autosave or World by its `kind`, and "Current world" on `current`; restoring one copies it as the newest
save, which the next start loads; the dialog names that copy as the Agent does, `restored-<time>-<name>` with the
prefixes of earlier restores dropped): four stat tiles (Free amber under the minimum), Start backup (no dialog),
Upload save… on a factorio server whose hub takes them (`features.upload`; `save-upload.ts`'s `SaveUpload`: a `.zip`
of at most 1 GiB through `Uploader`, then `POST …/saves`, the rest from the stream's `saveUpload` notes as one status
line (a finished one the stream replays from before the tab opened is not shown), the list fetched again when stored;
loading it is a Restore; an older hub's 404 names the release it needs), the list with a ⋯ Restore per row (typed-name
confirm, disabled with a reason unless the linked service is stopped, or while a pack update runs), and
`?restore=<name>` preselects one (the Pack tab's offer after a rollback); `backup-progress.ts`: `BackupProgress`, what
is backing up or restoring (ends on the live feed's finished/failed notice or the restore's answer; only ones started
from this browser), shown in the tab and the attention strip, no reply text; `logs.ts` (only with the detail's
`logs`): the folder's log files and crash reports newest first (size, time), the chosen one's last 1000 lines
(`latest.log` first, else the newest; `StickBottom`), Refresh fetching the list and the file again, a slower answer
for another file dropped, and with a linked service its journal from `GET /api/services/:id/logs` with its own
Refresh; `history.ts`: rate (the card's `rate`; "Paused" beside it while `paused`), player and uptime graphs extended
by live events newer than the history's `asOf` (`lost`: uptime unknown, a gap, and no players); `pack.ts` (only with
the detail's `pack`, last): #87's variant A, Adopt as the empty state (a version picked from `GET /api/library`, with
a link to the Library page, Compare, the report's keep boxes (all unticked to start), no confirm), then the summary
card (Update pack, its sheet the same library picker, or Apply N changes; its Java runtime row: a `<select>` of System
java and the library's runtimes with "pending restart", or, when the unit doesn't name the link, the two
`Environment=` lines to add; disabled with the hub's `blocked` or offline), the amber pending box, the red box for a
failure while preparing, Extras (pills, ⋯ Replace / Edit label and note / Remove, the Mod as a locked last row),
Config edits (a red line when one matched nothing, a match preview in its sheet), Kept path chips and the history (By
hidden on a phone); sheets full screen on a phone; changes ask nothing (a toast says they're pending), Update and
Apply ask once; the running update's step card follows `packUpdateStep` notices (Cancel only while preparing or
counting down), a "Done" line on success; after a rollback an amber line whose restore offer opens Backups with
`?restore=<backup>` preselected (a typed restore like any); `game.ts` (only with `features.update`, a factorio
server's while the hub's game updates are on, last; `hub-v2.14.0` reports it false, so no Game tab shows there):
Factorio and every mod it runs (with `mod-updates.ts`'s `PortalUpdates`, provided by the tab: `GET …/game/updates`
asked on its first state, whenever what the server runs changes, on a `modUpdates` notice and a finished update; a
badge "N updates" or "Mods up to date" by Installed, each updatable chip's "→ <version>" with its words for screen
readers, lines for releases needing a newer Factorio, mods gone from the portal (amber), the unchecked and a failed
check, and Update N mods…, which opens the sheet with those at "Newest that fits"; an older hub's 404 shows none of
it) (the game's own muted: `base`, `space-age`, `quality`, `elevated-rails`, `recycler`, never picked), Update game
(disabled with the hub's `blocked`, not while stopped: the update starts it), its sheet the Factorio version (the
running one and the catalog's per channel; one listed on both channels reads stable, whatever the order) and the
portal mods, each at its version or "Newest that fits", Remove (none on `orrery`: its Agent needs it), Add by portal
name or from the Browse view (a mod the server runs comes back at the version it runs) (`mod-browser.ts`'s
`ModBrowser`, in the sheet in place of the update view, which stays as it was, scroll included; a `@defer` chunk
prefetched once the sheet is idle: the portal's mods for the picked version's line from `GET …/game/mods` (search sent
300 ms after typing stops, category, sort, 24 a page with Load more, which waits while a new search is asked or loads,
a row a later page repeats dropped, an older answer dropped), each with its thumbnail from the hub's route (a
placeholder when it fails), owner, compact download count, version, "Mod pack" and "Space Age" badges and a portal
link the hub built, its standing in words on one `aria-disabled` button (Installed, Added, Required by X, Add back,
Add), so the focus stays on it, Add going through Add by name's path so its dependencies (a mod pack's mods) follow, a
footer counting the changes (a live region) with Review the update; a 404 names the hub release it needs; every portal
string shown as text), or a whole list through Import mod list (`mod-import.ts`'s `ModImport`, in the sheet in place
of the update view as Browse is, focus back on its button: the client's `mod-list.json` uploaded (where it is on
Windows, Linux and macOS said; over 256 KiB not read) or names pasted one per line or comma-separated, read in the
browser by `mod-list.ts`'s `parseModList` (JSON when it starts with `{`, its shape checked; enabled mods only, the
game's own (`GAME_MODS`, which `game.ts` takes from there) and disabled ones left out, names checked with the Agent's
rule (and not `.` alone, as the hub), each once, at most 500 (`MODS_MAX`, the hub's `LIMITS.mods`); `shown` makes a
refused name safe to show); the names not in the update yet (picked, or added by the catalog for one) checked with
`POST …/game/check` for the picked version's line (none asked when there are none; an older answer dropped; a 404
names the hub release it needs), then a preview before anything changes: the mods to add (each the newest that fits,
or back at the version the server runs; with "Keep the versions in the file", shown only when the file has some, its
version, "checked for <line> on Add" when it isn't the line's newest the check answered), those already in the update,
and every one skipped with why (not on the portal, no release for the line, not checked, the game's own (enabled or
disabled on the server too, or that the file differs and the server keeps its own setting), not a mod's name (the
first 50 listed, the rest counted)), the disabled count; Add N mods (disabled with nothing new, or over 500 with the
picks) appends them to the picks, the ones there kept as they are, and asks the catalog), every change asking `POST
…/game/catalog` again (an older answer dropped), the dependencies it added ("required by"), the unmet ones in red (no
start until fixed), What changes ("Nothing: the server runs these already…" when the picks are what it runs), and the
catalog's refusal inline; Update asks once (a stopped server: no save first, and it starts it; cancelled: back to the
sheet as it was); the step card (Backup called Save) and history from `packUpdate*` notices like the Pack tab's, also
fetched again on card events, deploys and `agentLost`/`agentBack`; `settings.ts` (only with `features.settings`, a
factorio server's while the hub's game settings are on, after Game; an older hub leaves `settings` out, so no tab, and
its 404 says "This hub has no game settings yet: deploy hub-v2.16.0 or later."): its game settings as `GET …/settings`
gives them, in cards (Server: name (a changed one at most 50 bytes in UTF-8, as Factorio keeps, the hub's
`GAME_SETTINGS.nameBytes`), description, max players, the game password; Joining: the account check, a `role="switch"`
button, and the idle kick; Pausing; Saving; Lua commands, a native select; Admins, chips with "Remove <name> from the
admins" and an Add checked as typed), changed fields marked "●" (the saved value in its `title`), "next restart"
badges on `auto_pause` and `autosave_slots`, and a sticky footer saying what applies now and what at the next restart
(or when the server starts, while stopped) and which `extra` keys a save drops, Save (disabled until a valid change,
and with the hub's `blocked`); one `PUT` with every field and the admins, `game_password` only when changed (typed, or
Generate: 20 letters and digits from `crypto.getRandomValues`, shown) or removed (null; Remove disabled while the
account check is off); the password is never shown back, only "Set" or "Not set"; turning the account check off shows
the note's warning in an `aria-live` region, switches Lua commands to Off (a red line if picked again), marks admins
"(name not checked)" and needs a password; banners for a rollback (`rolledBack`), keys waiting for a restart
(`pending`, with Restart…: `Feedback.confirm`, then a 5-minute countdown while players are on, else now), a stopped
server, a file that can't be read (setup's defaults shown), and the hub's `blocked`; an Agent too old, one not
connected or one that hasn't reported leaves the fields read-only, and with no report at all (too old, or none yet:
`settings` and `problem` both null) only the hub's reason shows, no cards and no footer, never setup's defaults as the
server's; fetched again on its `settings` notice, card events, deploys, service states and `agentLost`/`agentBack`;
`update-steps.ts`: `UpdateSteps` (the step card; Cancel while `cancellable`, whatever the step) and `UpdateHistory`,
shared by both; `/servers/<id>/chat` links deep), which `inject(ServerPage)` for the detail. A new section is a child
route plus a `SECTIONS` row (whose `has` reads the detail and `ServerPage.may`, a permission on this server).

What a user may do decides what shows (`Session.can`, on the server; the hub refuses the rest either way): Console
`servers.console`; Logs `servers.logs` (the linked service's journal in it `services.logs`); Pack and Game
`servers.pack`; Settings `servers.settings`; the chat box `servers.chat`; Restart, Cancel, the backups' Start and
Upload save `servers.control`; Restore `servers.restore`; moderation `servers.moderation`; a linked service's Start and
Stop `services.control`; "Audit log for this server" `audit`; New server, the Pending servers and Discard `library`.
Without them the page reads only: a viewer's is the overview, chat without the box, Players, History and Backups.

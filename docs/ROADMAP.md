# Roadmap

Living document. Each release gets design notes in `docs/notes/`, with its build plan, before it's built; its
section here links them. Releases up to Packs v2 were specced as GitHub issues, linked from their sections. v1–v1.3
specs and plans are in `docs/archive/`. **Size:** S = an evening or less, M = a day or two, L = several days.
**Where:** *hub* = hub-only update; *mod* = new mod jar; *protocol* = hub and mod both change (protocol bump).

## Done

- **v1**:
  - two-way chat relay, and join/leave/death/achievement posts;
  - `/status`, `/list`, `/cmd`;
  - started/stopped/crash/hung alerts, SQLite uptime;
  - systemd units that work under SELinux.
- **v1.1**:
  - player-skin webhook chat, presence and channel topics;
  - `/restart` with countdown, and daily restarts;
  - crash-log uploads;
  - hub hardening.

## v1.2a — done (hub + small mod update, no protocol change)

Spec: `docs/archive/specs/2026-09-24-gtnh-discord-v1.2a-design.md`

| Feature | Where | Size |
|---|---|---|
| Embeds for alerts, status, stats and backups (chat stays plain) | hub | S |
| Playtime, last seen, `/top`, daily peak players | hub | M |
| Daily summary post | hub | S |
| `/backup start` with a finish notice; `/backup status` / `list` with count and total size; missing-backup watchdog | hub | M |
| `/cmd` captures async replies (spark) | mod | S |
| Deferred minors (daily timer leak, symlinks, audit id, webhook name cache, topic warning, stale outbox) | hub + mod | S |

## v1.2b — done (shipped with v1.2a; additive messages, protocol stays v1)

Spec: `docs/archive/specs/2026-09-24-gtnh-discord-v1.2b-design.md`

| Feature | Where | Size |
|---|---|---|
| Per-dimension tick times; lag alerts (TPS < 15 for 2 min, configurable) naming the worst dimension; `/tps` with history | protocol | M |
| BetterQuesting quest-completion announcements | mod | M |
| Account linking: `/link` code in Discord, `/discord link <code>` in game; linked names in chat and stats | protocol | M |
| Exact backup events: the mod watches ServerUtilities' log for "backup done/failed", replacing the folder heuristic | protocol | S |
| Long-running command output (e.g. the spark profiler's result link) delivered after `/cmd` has returned | protocol | S |

## v1.3 — done (operations; server smoke test and first tagged releases pending)

Spec: `docs/archive/specs/2026-09-25-gtnh-discord-v1.3-design.md` · Decision: `docs/adr/0001-monorepo-independent-versions.md`

| Feature | Where | Size |
|---|---|---|
| GitHub Actions CI: hub tests on Node 24 + 26, mod build and JUnit, restore-script test | repo | S |
| Independent releases: `hub-vX.Y.Z` / `mod-vX.Y.Z` tags (past releases tagged too); mod version from `mod-v*` tags; mod jar attached to its GitHub release | repo + mod | S |
| Hub accepts a protocol version range (current and previous), so servers can update mods one at a time | hub | S |
| **Backup restore** as a server-side script (`deploy/restore-backup.sh <name>\|latest`): refuses unless `gtnh` is stopped, unpacks to staging, swaps it in and keeps the old world as `World.pre-restore-<time>`, prints the next steps | deploy | M |
| Backup disk space: free-space warning (`backupMinFreeGB`); size, free space and growth in `/backup status` and the daily summary | hub | S |
| `hub.db` upkeep: prune TPS samples older than 90 days (other tables kept), nightly `VACUUM INTO` copy, 7 kept | hub | S |
| External liveness ping (`healthcheckUrl`, e.g. healthchecks.io), only while Discord is connected, so you're told when the hub or the whole host dies | hub | S |
| `npm run check-config`: validate `config.json` offline with the same rules as startup, all errors at once | hub | S |

## v2 — web dashboard (five steps and the redesign deployed)

Spec: #26 · Decision: `docs/adr/0002-hub-with-integrations.md`. The hub becomes a platform whose integrations (Discord,
Minecraft, host) are switched on by config, and the dashboard is a separate Angular app in `web/`. The table
below is the original feature list. What ships in v2.0 hasn't been decided yet.

**Step 1 — done (`hub-v2.0.0`, deployed 2026-09-26):** renamed to orrery (#28); the hub starts through `startHub`
(#27); `config.json` grouped by integration, with `check-config` guiding the move from the old shape (#29);
Discord and Minecraft switched on by config, and the health ping follows the hub instead of Discord (#30);
production cutover and smoke test (#31).

**Step 2 — done (`hub-v2.1.0`, deployed 2026-09-26):** the web integration with Discord login and
sessions (#37); an audit log of frontend actions (#32); the live event stream (#33); REST reads (#34) and actions
(#35); `dash.orrery.run` served through Caddy (`deploy/Caddyfile`) (#36).

**Step 3 — done (`hub-v2.2.0` + `web-v0.1.0`, deployed 2026-09-27):** TPS on the event stream (#38); the
dashboard in `web/` with Discord login and logout against the hub's API types (#39); live server cards and chat
(#40); `web-v*` releases, `deploy/install-web.sh` and Caddy serving the dashboard (#41); production smoke test (#42).

**Step 4 — done (`hub-v2.3.0` + `web-v0.2.0`, deployed 2026-09-27):** events for the host, services and checks, with
Discord's `alertsChannel` (#43); checks (#44); host metrics (#45); services with state and logs (#46); service
start/stop/restart through a polkit rule, with a clean countdown stop for a linked server, and `gtnh.socket` no longer
`PartOf` its service (#47); production smoke test (#48).

**Step 5 — done (`hub-v2.4.0` + `web-v0.3.1`, deployed 2026-09-27):** server page sections
(#49); graphs with ECharts, starting with the host (#50); server history (TPS, players, uptime) and the audit log page
(#51); console and countdown restarts, on the server page and the cards (#52); player stats (#53); the backups
section, with the hub reporting the free-space minimum (#54); restoring a backup from the dashboard, wrapping
`deploy/restore-backup.sh`, only while the linked service is stopped (#55); production smoke test (#56), which found
that a section's event stream hung behind its page's in the browser's HTTP cache (fixed in `web-v0.3.1`). The
restore wasn't run live in that test.

**Redesign — done (`hub-v2.5.0` + `web-v0.4.1`, deployed 2026-09-28):** spec #73, from #59, #60 and #72. The shell: a sidebar (a
bottom tab bar on a phone), theme, avatar menu and login card (#74); confirm tiers, toasts and in-flight spinners
(#75); server rows with per-state actions, with lag and the linked service's state on each card (#76); the attention
strip and sidebar badges (#77); the server page header, tabs and Overview (#78); the Console, Chat, Players (was
Stats) and History tabs (#79); the Backups tab (#80); Services with the checks merged in, so the checks page is gone
(#81); Host tiles (#82); audit log paging and actor filter (#83); production release and smoke test (#84), which found that a tap on a server row opened `/<id>` instead of
`/servers/<id>` (fixed in `web-v0.4.1`).

| Feature | Where | Size |
|---|---|---|
| HTTP API and live event stream (`hub/src/web/`, calling `ServerHub`, `RestartScheduler`, stats) | hub | M |
| Login with Discord (OAuth), reusing the admin-role check | hub | M |
| Pages: server cards; uptime, TPS and player graphs; live chat; console with command input | web | L |
| Server management: start/stop/restart via a narrowly scoped polkit rule for `gtnh.service` | hub + deploy | M |
| Backups page: list, sizes, trend; **restore button** (wraps the v1.3 script, with confirmation) | hub + web | M |
| Base stats (LSC power, AE2 storage, crafting CPUs) from the existing `oc-influxdb-exporter` (later: not in step 5) | hub | M |

## v2 continued — chat, deploys, staging, packs

Map: #57 (its CI piece shipped with #69). One spec per row, built in this order: each needs the rows above it, except
that staging's hub and web changes (the `environment` field, `/api/environment` and the badge) can land early.

**Chat mirroring — done (`hub-v2.6.0` + `web-v0.5.0` + `mod-v1.4.0`, deployed 2026-10-01):** #88 (#92, #93, #94).

**Releases and deploys — deployed 2026-10-01 (`hub-v2.6.0`, `hub-v2.6.1`, `web-v0.5.0`, `mod-v1.4.0`):** #89. The
release script (#96); `integrations.github` and read-only Releases on the Host page (#97); the hub deploy script, units
and polkit (#98); hub deploys with the history (#99); restore exclusion, the floor and Discord notices (#100); dashboard
deploys (#101); Mod deploys (#102); the one-time move to `/home/opc/orrery` and smoke test (#103), which found that
SELinux won't let systemd follow the `current` symlink into `WorkingDirectory` (the hub unit now has none). Still to
smoke test: a Rollback of a broken hub release, and a dashboard deploy (it waits for `web-v0.5.1`).

**Packs — done (`hub-v2.7.0` + `web-v0.6.0`, deployed 2026-10-02):** #90. The Pack tab, Kept paths and `keep` (#104);
uploads, Compare and Adopt (#105); Extras and Config edits with changes pending (#106); pack updates: Prepare, Backup,
Stop, Swap and the health gate (#107); live steps and Cancel (#108); rollback, interruption and the restore offer
(#109); exclusive with restores and deploys (#110). The installed pack's zip is kept in `<data>/packs/` so changes can
be applied onto it. Production adopted (#111) and `deploy/legacy/update-server.sh` deleted. Uploads go through
Cloudflare, which refuses bodies over 100 MB: the adopted zip went up over an SSH tunnel to Caddy (use a pack URL for
updates). Still to smoke test on the real server: Apply changes, a version update with players online, a rollback and
restoring its pre-update backup.

**Staging — built, to set up on the host:** #91. Config's `environment` and `GET /api/environment`, the dashboard's
Staging badge and tab title, the Servers page without the Minecraft integration (for Staging's offline `demo`),
`deploy/orrery-hub-staging.service` (its header: the one-time setup), the Caddyfile's `staging.orrery.run` site and
`hub/config.staging.example.json`. Still to do on the host: the setup and the spec's manual smoke test.

**Logs, history and console — done (`hub-v2.13.0` + `web-v0.11.0`, deployed 2026-10-26):** no spec, three issues.
Chat and console history survive hub restarts and deploys: a server's chat lines and console entries go to a `feed`
table that seeds the live feed at start, newest 500 per server kept (#145). A Logs tab on the server page: `logs/`,
crash reports and the linked service's journal, the last 1000 lines of a file the hub listed (#146). The console
remembers this browser's commands (↑/↓) and keeps saved commands as chips (#148). Still to check on the real server:
the Logs tab against `gtnh`'s folder.

| # | Spec | Where | Size | Needs |
|---|---|---|---|---|
| 1 | Chat mirroring across dashboard, Discord and game, and a hub timestamp on every live event (folds in #85): #88 | hub + web + mod (optional wire field, no protocol bump) | M | — |
| 2 | Releases and deploys: `.github/release.sh`, hub self-deploy with Rollback, dashboard and Mod deploys, `integrations.github`: #89 | repo + hub + web + deploy | L | — |
| 3 | Staging: a second Environment at `staging.orrery.run`, its own OS user, OAuth app and `demo` server: #91 | hub + web + deploy | S | #89's release layout and deploy units |
| 4 | Packs: Adopt, Extras, Config edits, Pack updates with Rollback, the Pack tab: #90 | hub + web + deploy | L | #89's Mod deploy (a Pack update puts the Mod back) |
| 5 | Packs v2: the pack library (chunked uploads, GitHub Actions artifacts), Java runtimes, New server with `add-server.sh`, the Mod renamed `orrery`: #134 · Map: #123 · Layout: `docs/adr/0003-host-directory-layout.md` | hub + web + mod + deploy (no protocol bump) | L | #90; staging set up for its smoke test |

## Factorio through an Agent — releases 1 and 2 shipped (2026-11-01)

Notes: `docs/notes/factorio-agent.md` (the design, the build plan M0 to M8 and the smoke checks; local until the owner
commits a cleaned copy, because the repo is public and the notes name the friend's VM details) · Decision:
`docs/adr/0004-remote-hosts-through-an-agent.md`. One Factorio 2.1 Space Age server on a friend's Oracle Linux 9
aarch64 VM, reached over his Tailscale tailnet. An **Agent** (`agent/`) on the VM dials out to the hub (Agent port
25584) and runs Factorio, in Podman, for it; a control-only Factorio mod (`factorio/`, `orrery` on the mod portal)
reports chat and events to the Agent. Hub, dashboard, Agent and Factorio mod are released separately, in that order
(`docs/adr/0001`). Split into two releases on 2026-10-31.

**Release 1 — shipped 2026-11-01** as `hub-v2.14.0`, `web-v0.12.0`, `agent-v1.0.0` and `factorio-v1.0.0` (`orrery`
1.0.0 on the mod portal):

| Milestone | Where | Size |
|---|---|---|
| M1: Factorio in Podman on the VM by `deploy/setup-agent-host.sh`; the Agent's `check`; the `agent-v*` and `factorio-v*` release lines, the mod put on the mod portal by `release.yml` | deploy + agent + factorio + repo | L |
| M2: the Agent port and connection (address check, 1 MiB line cap, rate limit, agent-lost rules); status with UPS and Paused; the VM as a second Host | hub + agent + web | L |
| M3: chat both ways with Discord and the dashboard; join, leave and death with cause; every research and each force's first rocket, platform and landing; `/link` shared with Minecraft | hub + agent + factorio + web | L |
| M4: start, stop and restart with countdowns; console and logs | hub + agent + web | M |
| M5: saves as Backups (on request, every 6 h after play), and restore | hub + agent + web | M |

On release 1 alone, the Factorio version changes by re-running the setup with `--factorio`, mods are added by hand,
and the Agent updates by re-running the setup at the new `agent-v` tag; its dashboard has no Game tab and no Agent rows
under Releases. A local end-to-end loop (hub, Agent and a headless server) passed its 14 scenarios; real players,
Discord, Podman, real systemd timeouts and the tailnet are checked only by the smoke tests in the notes, after the cut.

**Release 2 — shipped 2026-11-01** as `hub-v2.15.0`, `web-v0.13.0` and `agent-v1.1.1` (`agent-v1.1.0` is a burned tag
with no GitHub release). The friend ran the setup once from the Agent tag; later Agent releases deploy from the
dashboard (the first was `agent-v1.2.0`).

| Milestone | Where | Size |
|---|---|---|
| M6: game updates: the Factorio version and portal mods picked in the Game tab, with their dependencies; backup, countdown stop, swap, health gate and rollback, like a pack update | hub + agent + web | L |
| M7: Agent deploys from the dashboard (`agent-v*` assets, rollback if the Agent won't reconnect): the Agent starts `orrery-agent-deploy@<tag>`, which runs `deploy/deploy-agent.sh` | hub + agent + web | M |

A local end-to-end loop (hub, Agent, a headless 2.1.24 server and a fake mod portal and GitHub) passed: an update
adding a mod and its dependency, a gate failure rolled back to the pre-update save, a cancel while downloading, a hub
restart during an update, and an Agent deploy through the real `deploy-agent.sh`. The real portal, ARM64 build,
Podman and polkit are not in it: they are left to the smoke checks in the notes, after the cut.

## Game tab: the mod browser — shipped (`hub-v2.16.0`, `web-v0.14.0`; Import mod list in `hub-v2.17.0`, `web-v0.15.1`)

Notes: `docs/notes/mod-browser.md`. A Browse view in the Update game sheet: the mod portal's mods for the picked
Factorio line, searched, filtered by category, sorted, with thumbnails, summaries and download counts, and Add, which
puts a mod in the update with its required dependencies (a portal mod pack's mods too). The hub reads the portal and
serves the thumbnails; the dashboard never talks to it. With it, a release on both channels reads as stable, and "What
changes" says when the server runs the picks already. No Agent, mod or protocol change. Import mod list (a client's
`mod-list.json` or pasted names, checked with `POST …/game/check`) followed in the next hub and dashboard minors.

## Factorio game settings, new worlds and save uploads — Settings and save uploads shipped, new worlds designed

Notes: `docs/notes/factorio-world-settings.md`. On the factorio server an Agent runs, in two stages, each released
on its own:

| Stage | What | Where | State |
|---|---|---|---|
| A | Game settings from a Settings tab: name, description, max players, game password, user verification (off for family-shared players, with its warning and an alert in Discord's alerts channel), autosaves, the idle kick, pausing, Lua commands and the admins; written to `server-settings.json` and applied live where Factorio can, with a start gate that puts back the last good settings when the next start fails | hub + agent + web (additive messages `settings` and `settingsSet`, no protocol bump) | shipped: `hub-v2.18.0`, `web-v0.16.0`, `agent-v1.2.0` |
| B | A save uploaded from the dashboard (Saves tab, Upload save…), loaded by a Restore | hub + agent + web (`saveUploadStart`, `saveChunk`, `saveUploadEnd`, `saveUploadCancel` over the Agent connection, not the design's separate fetch connection) | shipped: `hub-v2.19.0` (`hub-v2.19.1`), `web-v0.17.0`, `agent-v1.3.0` |
| B | A new world from map settings (keeping the current world as a save), and the restore extended (stop and start, mod checks, a pre-restore save, rollback) | hub + agent + web + factorio (`orrery` 1.1.0) + a setup re-run | designed only |

Not covered by the tests, so left to smoke checks on production: `/config` with players online, and the start gate
on the real Podman unit.

## Factorio: portal mod update notices and player moderation — cut as `hub-v2.20.0`, `web-v0.18.0`, `agent-v1.4.0`, not yet deployed

Notes: `docs/notes/factorio-game-extras.md`. On a factorio server an Agent runs:

| Part | What | Where |
|---|---|---|
| 1 | Portal mod updates: the Game tab marks each installed portal mod with a newer release that fits the installed Factorio, counts them, and **Update N mods…** plans them all in the Update game sheet; Discord hears about new ones at most once a day in the server's channel | hub + web (no Agent change) |
| 2 | Moderation in the Players tab: who is online, Kick, Ban (with a reason), Unban, Promote and Demote, the bans and the admins, through Factorio's own commands that the Agent builds | hub + agent + web (additive messages `playerLists` and `moderate`, no protocol bump; `/kick`, `/ban` and `/unban` allowed by the owner on 2026-11-02) |

Also a fix: a game update of a server stopped before it that fails after the hub resumes it, before the swap, leaves the
server stopped. Cut 2026-11-02 as `hub-v2.20.0`, `web-v0.18.0` and `agent-v1.4.0` (`MODERATION_FLOOR`: an older
Agent gets the deploy text), to deploy from the Host page in that order; the friend does nothing. Left to the smoke check on
production: a kick and a ban of a player who is online (what they see, and that the save isn't flagged), and the first
Discord notice.

Then, in order: New world (stage B above), then off-site save copies (`docs/notes/factorio-save-copies.md`, to
redesign against the transfer save uploads use).

## Status page — hub and dashboard built, Caddy next

Notes: `docs/notes/public-status.md`. A public page on `status.orrery.run`, with no login, for players: each listed
server's name, game, state, the players online (count and names) and uptime over 7 and 30 days, polled every 30 s.
The hub's `GET /api/public/status` answers only the servers listed in `integrations.web.status`, field by field; the
page boots alone from the dashboard's build (no shell, no session), served on its own Caddy site that proxies nothing else. Hub + web + Caddy and
a DNS record, no Agent or mod change. To cut as the next hub minor, then the next dashboard minor.

## The App: orrery on Android — designed

Notes: `docs/notes/android-app.md`. A native Android app (Kotlin, Jetpack Compose): the servers, services, checks and
Hosts at a glance; start, stop and restart; a server's restart and backup; and push notifications for problems and
recoveries through Firebase Cloud Messaging. The hub gains bearer sessions (a password login as a User, the same
`Users.login` as the dashboard's), phone registrations tied to their session, and an FCM sender. A new part `android/`, released as a signed APK
on `android-vX.Y.Z` tags. After the status page, whose first commit moves the hub's login code out of `web.ts`.

## Users: local accounts, roles and permissions — built, to release

Notes: `docs/notes/users.md`. The dashboard stops logging in through Discord: a User is a row in `hub.db` with a
username and a password (`scrypt`), Roles are editable sets of a fixed permission vocabulary, a Grant gives a user a
role for every server or some, and an Invite (a one-use link, also how a password is reset) is how a user gets in.
The hub refuses an action the user's roles don't cover (writes default-deny), and the dashboard hides it. A Users
page (users, roles, the user's own account) and a CLI (`npm run users -- invite <name>`) for the first owner and a
locked-out one. The bot's own admin-role check stays. One hub and one dashboard release, back to back; the old config
keys and `DISCORD_CLIENT_SECRET` are tolerated one release. A second factor (TOTP) is the release after. Before the
App, whose login (`docs/notes/android-app.md`) is the same password login. Built on branch `users` (hub and dashboard,
ADR 0005); next, the two releases and the by-hand steps in the note's "Release and deploy".

## Later / if needed

- More GitHub integration: a repo's CI runs and open issues, growing #89's `integrations.github` (introduces a Project term).

- Whitelist gating (auto-whitelist linked members, remove on leaving the Discord server). Needs the
  privileged Server Members intent.
- Cross-server chat and a network-wide `/status` (multi-server already works in the hub).
- Moderation: mute the bridge for a player, a word filter for Discord → game.
- Grafana/InfluxDB export of hub stats (TPS, players, uptime).
- Agents beyond the Factorio release: a Minecraft server run through an Agent, more than one server per Agent, Agents that only report a Host, and a staging Agent.

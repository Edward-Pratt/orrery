# Roadmap

Living document. Each release gets a spec as a GitHub issue (`/to-spec`), broken into ticket issues
(`/to-tickets`), before it's built; its section here links the spec issue. v1–v1.3 specs and plans are in
`docs/archive/`. **Size:** S = an evening or less, M = a day or two, L = several days.
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

## v2 — web dashboard (being designed)

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

| Feature | Where | Size |
|---|---|---|
| HTTP API and live event stream (`hub/src/web/`, calling `ServerHub`, `RestartScheduler`, stats) | hub | M |
| Login with Discord (OAuth), reusing the admin-role check | hub | M |
| Pages: server cards; uptime, TPS and player graphs; live chat; console with command input | web | L |
| Server management: start/stop/restart via a narrowly scoped polkit rule for `gtnh.service` | hub + deploy | M |
| Backups page: list, sizes, trend; **restore button** (wraps the v1.3 script, with confirmation) | hub + web | M |
| Base stats (LSC power, AE2 storage, crafting CPUs) from the existing `oc-influxdb-exporter` | hub | M |

## Later / if needed

- GitHub integration: a repo's CI runs, releases and open issues (introduces a Project term).

- Whitelist gating (auto-whitelist linked members, remove on leaving the Discord server). Needs the
  privileged Server Members intent.
- Cross-server chat and a network-wide `/status` (multi-server already works in the hub).
- Moderation: mute the bridge for a player, a word filter for Discord → game.
- Grafana/InfluxDB export of hub stats (TPS, players, uptime).
- A hub on a different machine from the game servers (TLS, and rethinking the localhost-only port).

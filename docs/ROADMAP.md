# Roadmap

Living document. Each release gets a spec (`docs/superpowers/specs/`) and a plan (`docs/superpowers/plans/`)
before it's built. **Size:** S = an evening or less, M = a day or two, L = several days.
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

## v1.2a — in progress (hub + small mod update, no protocol change)

Spec: `docs/superpowers/specs/2026-09-24-gtnh-discord-v1.2a-design.md`

| Feature | Where | Size |
|---|---|---|
| Embeds for alerts, status, stats and backups (chat stays plain) | hub | S |
| Playtime, last seen, `/top`, daily peak players | hub | M |
| Daily summary post | hub | S |
| `/backup start` with a finish notice; `/backup status` / `list` with count and total size; missing-backup watchdog | hub | M |
| `/cmd` captures async replies (spark) | mod | S |
| Deferred minors (daily timer leak, symlinks, audit id, webhook name cache, topic warning, stale outbox) | hub + mod | S |

## v1.2b — in progress (ships together with v1.2a; additive messages, protocol stays v1)

Spec: `docs/superpowers/specs/2026-09-24-gtnh-discord-v1.2b-design.md`

| Feature | Where | Size |
|---|---|---|
| Per-dimension tick times; lag alerts (TPS < 15 for 2 min, configurable) naming the worst dimension; `/tps` with history | protocol | M |
| BetterQuesting quest-completion announcements | mod | M |
| Account linking: `/link` code in Discord, `/discord link <code>` in game; linked names in chat and stats | protocol | M |
| Exact backup events: the mod watches ServerUtilities' log for "backup done/failed", replacing the folder heuristic | protocol | S |
| Long-running command output (e.g. the spark profiler's result link) delivered after `/cmd` has returned | protocol | S |

## v1.3 — operations

| Feature | Where | Size |
|---|---|---|
| GitHub Actions CI: hub tests on Node 24 + 26, mod build and JUnit | repo | S |
| Tagged releases: version from the git tag, mod jar attached to the GitHub release | repo | S |
| **Backup restore** as a server-side script (`deploy/restore-backup.sh <name>`): refuses unless `gtnh` is stopped, moves the current world to `World.pre-restore-<time>`, unpacks the chosen backup, prints the next steps | deploy | M |
| Backup retention report: size trend, and a warning when the backup folder passes a size limit | hub | S |
| `hub.db` maintenance: prune old events/sessions, and a nightly copy of the database | hub | S |
| External liveness ping (e.g. healthchecks.io) so you're told when the hub or the whole host dies, which the bot can't report itself | hub | S |
| `npm run check-config`: validate `config.json` (JSON, ids, times, paths) without starting the bot | hub | S |

## v2 — web dashboard

| Feature | Where | Size |
|---|---|---|
| HTTP API and live event stream (`hub/src/web/`, calling `ServerHub`, `RestartScheduler`, stats) | hub | M |
| Login with Discord (OAuth), reusing the admin-role check | hub | M |
| Pages: server cards; uptime, TPS and player graphs; live chat; console with command input | web | L |
| Server management: start/stop/restart via a narrowly scoped polkit rule for `gtnh.service` | hub + deploy | M |
| Backups page: list, sizes, trend; **restore button** (wraps the v1.3 script, with confirmation) | hub + web | M |
| Base stats (LSC power, AE2 storage, crafting CPUs) from the existing `oc-influxdb-exporter` | hub | M |

## Later / if needed

- Whitelist gating (auto-whitelist linked members, remove on leaving the Discord server). Needs the
  privileged Server Members intent.
- Cross-server chat and a network-wide `/status` (multi-server already works in the hub).
- Moderation: mute the bridge for a player, a word filter for Discord → game.
- Grafana/InfluxDB export of hub stats (TPS, players, uptime).
- A hub on a different machine from the game servers (TLS, and rethinking the localhost-only port).

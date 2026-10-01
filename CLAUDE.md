# orrery

A hub for everything its owner runs or ships (game servers first); today a Discord bridge for GT: New Horizons
(MC 1.7.10) servers. Two independent projects in one repo:

- `hub/` — Node/TypeScript Discord bot and the "brain". See `hub/CLAUDE.md`.
- `mod/` — server-side Forge 1.7.10 mod, a thin adapter. See `mod/CLAUDE.md`.
- `web/` — the dashboard, an Angular app talking only to the hub's HTTP API. See `web/CLAUDE.md`.
- `deploy/` — systemd units for the production host (hub; GTNH server with a FIFO console, no tmux — SELinux-safe), `orrery-hub.rules` (polkit: the hub's user may start/stop/restart exactly the listed units; **keep its `UNITS` in sync with `integrations.systemd`**), the `Caddyfile` (TLS for the dashboard and Grafana;
  serves the dashboard from `/var/www/orrery`, `/api` to the hub), `install-web.sh` (installs a dashboard release
  there; tested by `test-install-web.sh`) and `restore-backup.sh` (puts a backup back over a stopped server's world; the hub runs it for the dashboard's restore;
  tested by `test-restore-backup.sh`).
- `docs/protocol.md` — the wire protocol (living, authoritative). Specs and tickets are GitHub issues
  (`/to-spec`, `/to-tickets`); `docs/archive/` holds the v1–v1.3 specs and plans (deprecated, history only).
- `docs/ROADMAP.md` — planned releases, linking each to its spec issue; update it when a release ships or scope moves.

Nothing builds at the root: run npm in `hub/` and `web/`, Gradle in `mod/`.

## Architecture rules

- The hub owns all state. **Integrations** are built in and switched on by their section under `integrations` in
  `config.json`; none is required (`docs/adr/0002`, `CONTEXT.md`). Today: `minecraft`, `discord`, `web`, `checks`, `host` and `systemd`.
- **Minecraft integration** = a mod port and a token per server. Mods connect **out** to the hub (TCP
  `127.0.0.1:25580`, newline-delimited JSON, protocol v1). Off: no port is opened. The socket stays in `ServerHub`.
- **Discord integration** = the bot, a frontend. Frontends (Discord, and the dashboard through the web API) only call the public
  API of `ServerHub` (`hub/src/servers.ts`), `RestartScheduler`, `Stats` (`hub/src/stats.ts`), `LiveFeed`
  (`hub/src/live.ts`, numbered events with replay) and the hub-core modules of the host, checks and services
  (`HostMonitor`, `Checks`, `Services`, `Restores`); they
  never talk to mods, systemd or the database directly. Off: no bot and no `DISCORD_TOKEN` needed; everything else still runs.
- **Web integration** = the HTTP API (Hono, `127.0.0.1`, under `/api`) for the dashboard, with Discord OAuth login
  for admin-role members (its own `guildId`/`adminRoleId`, else `integrations.discord`'s; no bot needed) and SQLite sessions (`hub/src/web.ts`). Same
  frontend rule as Discord, plus its own session rows in `Db`. Off: no HTTP port and no `DISCORD_CLIENT_SECRET` needed.
- `hub/src/start.ts` (`startHub`) wires the hub from config; `index.ts` only builds the real outside world.
- The mod has no business logic and no Discord knowledge.

## Changing the wire protocol

Protocol lives in three places that must change together:
1. `hub/src/protocol.ts` (`SCHEMAS` validation; the message types are in `hub/src/types.ts`),
2. the mod (`HubClient.java` hello, `GameEvents.java` messages),
3. `docs/protocol.md`.
Bump `PROTOCOL_VERSION` (and the mod's hello `protocol`) for any incompatible change.
The hub accepts `MIN_PROTOCOL..PROTOCOL_VERSION` (`protocol.ts`). Policy: keep the previous version supported, so
raise `MIN_PROTOCOL` only one release after a bump.

## Verify before claiming done

```bash
cd hub && npm test && npm run typecheck
cd mod && ./gradlew spotlessApply build   # runs JUnit tests too
cd web && npm test && npm run build       # the build also type-checks against the hub's API types
bash deploy/test-restore-backup.sh        # needs zip and unzip
bash deploy/test-install-web.sh
bash .github/test-changes.sh              # which parts CI runs (.github/changes.sh)
bash .github/test-release.sh              # the release script against a throwaway repo
```

Behaviour that needs a real server (event hooks, command capture) can only be checked by the manual
smoke test in the release's tickets — say so rather than claiming it works.

## Releases

Hub, mod and dashboard are versioned separately (`docs/adr/0001`); a part's version is only its latest
`hub-vX.Y.Z`, `mod-vX.Y.Z` or `web-vX.Y.Z` tag. Cut one with `.github/release.sh <hub|mod|web> <major|minor|patch>`
from an up-to-date, clean `main`: it shows the next tag and its notes, asks y/N (`--yes` skips) and pushes only that tag.
Never delete or move a tag; fix a failed release forward with the next patch.
`.github/workflows/release.yml` runs CI for that part only (`.github/changes.sh`), then creates the GitHub release. Its notes are
that part's commits (`.github/notes.sh`); for the mod it attaches the jar, for the dashboard its build as `orrery-web-vX.Y.Z.tar.gz`
(the server never builds Angular; `web-v0.x` until the dashboard is finished). The hub is deployed with
`git checkout hub-vX.Y.Z` on the server, the dashboard with `sudo bash deploy/install-web.sh web-vX.Y.Z`.

## Secrets

`hub/config.json` (server tokens, IDs) and `.env` (`DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`) are git-ignored. Never commit them.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `Edward-Pratt/orrery` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

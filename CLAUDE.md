# orrery

A hub for everything its owner runs or ships (game servers first); today a Discord bridge for GT: New Horizons
(MC 1.7.10) servers. Two independent projects in one repo:

- `hub/` — Node/TypeScript Discord bot and the "brain". See `hub/CLAUDE.md`.
- `mod/` — server-side Forge 1.7.10 mod, a thin adapter. See `mod/CLAUDE.md`.
- `web/` — the dashboard, an Angular app talking only to the hub's HTTP API. See `web/CLAUDE.md`.
- `deploy/` — systemd units for the production host (hub; GTNH server with a FIFO console, no tmux — SELinux-safe), `orrery-hub.rules` (polkit: the hub's user may start/stop/restart exactly the listed units; **keep its `UNITS` in sync with `integrations.systemd`**, except the servers `add-server.sh` added, each with its own `60-orrery-<id>.rules`: remove that file when its server leaves the config), the `Caddyfile` (TLS for the dashboard and Grafana;
  serves the dashboard from `/var/www/orrery`, `/api` to the hub), `install-web.sh` (installs a dashboard release
  there, stamping `<webDir>.release` with the tag; tested by `test-install-web.sh`), `restore-backup.sh` (puts a backup back over a stopped server's world; the hub runs it for the dashboard's restore;
  tested by `test-restore-backup.sh`) and the deploys, which the hub starts per tag through polkit:
  `orrery-deploy@.service` runs `deploy-hub.sh` as the hub's user (builds `<root>/releases/<tag>`, flips the
  `current` symlink, rolls back if the hub won't stay up 30 s), `orrery-deploy-web@.service` runs `deploy-web.sh` as
  root from a root-owned copy in `/usr/local/lib/orrery` (around `install-web.sh`); both write
  `<root>/deploy-status.json` and are tested by `test-deploy.sh`. `orrery-deploy-staging@` and
  `orrery-deploy-web-staging@` are staging's copies. Their polkit blocks are separate from `UNITS`: they allow only
  `start` on those templates for well-formed tags and `restart` on that environment's hub. Staging (`docs/ROADMAP.md`, #91) runs `orrery-hub-staging.service` as
  `orrery-staging` from `/srv/orrery-staging` (its header holds the one-time setup; config from
  `hub/config.staging.example.json`), behind the Caddyfile's `staging.orrery.run` site (port 25582, `/var/www/orrery-staging`).
  `add-server.sh` (run as root from its root-owned copy in `/usr/local/lib/orrery`) finishes a Pending server: its
  `config.json` entry, token and service link (checked as the hub user, `config.json.bak` kept), `<id>.service` and
  `<id>.socket` like `gtnh`'s, its polkit file, enabled, then the hub restarted; tested by `test-add-server.sh`.
- `docs/protocol.md` — the wire protocol (living, authoritative). Specs and tickets are GitHub issues
  (`/to-spec`, `/to-tickets`); `docs/archive/` holds the v1–v1.3 specs and plans (deprecated, history only).
- `docs/ROADMAP.md` — planned releases, linking each to its spec issue; update it when a release ships or scope moves.

Nothing builds at the root: run npm in `hub/` and `web/`, Gradle in `mod/`.

## Architecture rules

- The hub owns all state. **Integrations** are built in and switched on by their section under `integrations` in
  `config.json`; none is required (`docs/adr/0002`, `CONTEXT.md`). Today: `minecraft`, `discord`, `web`, `checks`, `host`, `systemd` and `github`. Packs need no section of their own: a
  server with a `dir`, a linked service (`systemd`) and a Mod token (`minecraft`) has one. The hub's host needs `unzip`
  for them (and for `restore-backup.sh`), and `tar` for the library's Java runtimes.
- **Minecraft integration** = a mod port and a token per server. Mods connect **out** to the hub (TCP
  `127.0.0.1:25580`, newline-delimited JSON, protocol v1). Off: no port is opened. The socket stays in `ServerHub`.
- **Discord integration** = the bot, a frontend. Frontends (Discord, and the dashboard through the web API) only call the public
  API of `ServerHub` (`hub/src/servers.ts`), `RestartScheduler`, `Stats` (`hub/src/stats.ts`), `LiveFeed`
  (`hub/src/live.ts`, numbered events with replay) and the hub-core modules of the host, checks and services
  (`HostMonitor`, `Checks`, `Services`, `Restores`, `Deploys`, `Packs`, `Uploads`, `Library`); they
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
bash deploy/test-deploy.sh                # deploy-hub.sh and deploy-web.sh, with fake systemctl, npm and gh
bash deploy/test-add-server.sh            # with fake systemctl, runuser and SELinux tools; the config check is real
bash .github/test-changes.sh              # which parts CI runs (.github/changes.sh)
bash .github/test-release.sh              # the release script against a throwaway repo, and mod-jars.sh
```

Behaviour that needs a real server (event hooks, command capture) can only be checked by the manual
smoke test in the release's tickets — say so rather than claiming it works.

## Releases

Hub, mod and dashboard are versioned separately (`docs/adr/0001`); a part's version is only its latest
`hub-vX.Y.Z`, `mod-vX.Y.Z` or `web-vX.Y.Z` tag. Cut one with `.github/release.sh <hub|mod|web> <major|minor|patch>`
from an up-to-date, clean `main`: it shows the next tag and its notes, asks y/N (`--yes` skips) and pushes only that tag.
Never delete or move a tag; fix a failed release forward with the next patch.
`.github/workflows/release.yml` runs CI for that part only (`.github/changes.sh`), then creates the GitHub release. Its notes are
that part's commits (`.github/notes.sh`); for the mod it attaches one jar per Minecraft target, `orrery-<mc>-<version>.jar` (`.github/mod-jars.sh`, tested by `test-release.sh`), for the dashboard its build as `orrery-web-vX.Y.Z.tar.gz`
(the server never builds Angular; `web-v0.x` until the dashboard is finished). Deploy from the dashboard's Host page
(Releases): a hub or dashboard deploy runs its `orrery-deploy@` / `orrery-deploy-web@` unit, a Mod deploy puts the jar in
place at the end of the server's countdown. Only `hub-v2.6.0` / `web-v0.5.0` and later deploy (`FLOOR` in
`hub/src/deploys.ts`). By hand still: units, polkit rules and the `/usr/local/lib/orrery` copies of `deploy-web.sh`,
`install-web.sh` and `add-server.sh` when a release changes them, and `install-web.sh` for a first install or an archive.

## Secrets

`hub/config.json` (server tokens, IDs) and `.env` (`DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`) are git-ignored. Never commit them.
`GITHUB_TOKEN` (with `integrations.github`, and for the library's Actions artifacts: a fine-grained token with read access to the repo's contents and Actions) lives in
the root-only `/etc/orrery.env` on the host (staging: `/etc/orrery-staging.env`), read by the hub and its deploy units.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `Edward-Pratt/orrery` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

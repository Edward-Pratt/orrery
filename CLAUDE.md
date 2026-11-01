# orrery

A hub for everything its owner runs or ships (game servers first); today a Discord bridge for GT: New Horizons
(MC 1.7.10) servers, and a Factorio 2.1 server run through an Agent. Independent parts in one repo:

- `hub/` — Node/TypeScript Discord bot and the "brain". See `hub/CLAUDE.md`.
- `mod/` — server-side Forge 1.7.10 mod, a thin adapter. See `mod/CLAUDE.md`.
- `agent/` — Node/TypeScript service on a remote Host that dials out to the hub and runs that Host's Factorio server. See `agent/CLAUDE.md`.
- `web/` — the dashboard, an Angular app talking only to the hub's HTTP API. See `web/CLAUDE.md`.
- `factorio/` — the Factorio mod `orrery`, control-only Lua, published on the mod portal. See `factorio/CLAUDE.md`.
- `deploy/` — systemd units for the production host (hub; GTNH server with a FIFO console, no tmux — SELinux-safe), `orrery-hub.rules` (polkit: the hub's user may start/stop/restart exactly the listed units; **keep its `UNITS` in sync with `integrations.systemd`**, except the servers `add-server.sh` added, each with its own `60-orrery-<id>.rules`: remove that file when its server leaves the config, and the services an Agent backs, which the hub never runs systemctl on: its Agent does, on its own Host), the `Caddyfile` (TLS for the dashboard and Grafana;
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
  `setup-agent-host.sh` sets up an Agent's Host (the friend runs it as root, and again at each new `agent-v` tag): Factorio in
  a rootful Podman Quadlet (`factorio.container`), the Agent as `orrery-agent.service` from the newest `agent-v*`
  release, the newest `factorio-v*` release's mod when `mods/` has none, `60-orrery-agent.rules`, and a random game
  password in `server-settings.json` (kept on a re-run), shown only in the mode-600 `/srv/factorio/first-boot.txt`. A re-run
  keeps the image, the Factorio version and `--memory-max` unless told otherwise. It switches Factorio's `current` and
  image together with `factorio.container`, once that release passed `--version` in that image, and the agent's `current`
  last, after its units are written, so a re-run that fails on its way leaves both as they were; tested by
  `test-setup-agent-host.sh`. `deploy-agent.sh` and `orrery-agent-deploy@.service` ship with it (an agent release next
  to the running one, rolled back if it won't connect; tested by `test-deploy-agent.sh`), but nothing starts them
  until agent deploys exist (release 2).
- `docs/protocol.md` — the wire protocol (living, authoritative).
- `docs/notes/` — designs and build plans, one Markdown file per piece of work, in whatever shape fits it (no
  `/to-spec` or `/to-tickets`, no GitHub-issue specs). Releases up to Packs v2 were specced as GitHub issues, which
  stay as history; `docs/archive/` holds the v1–v1.3 specs and plans (deprecated, history only).
- `docs/ROADMAP.md` — planned releases, linking each to its notes (older ones to their spec issue); update it when a
  release ships or scope moves.

Nothing builds at the root: run npm in `hub/`, `web/` and `agent/`, Gradle in `mod/`.

## Architecture rules

- The hub owns all state. **Integrations** are built in and switched on by their section under `integrations` in
  `config.json`; none is required (`docs/adr/0002`, `CONTEXT.md`). Today: `minecraft`, `agents`, `discord`, `web`, `checks`, `host`, `systemd` and `github`. Packs need no section of their own: a
  server with a `dir`, a linked service (`systemd`) and a Mod token (`minecraft`) has one. The hub's host needs `unzip`
  for them (and for `restore-backup.sh`), and `tar` for the library's Java runtimes.
- **Minecraft integration** = a mod port and a token per server. Mods connect **out** to the hub (TCP
  `127.0.0.1:25580`, newline-delimited JSON, protocol v1). Off: no port is opened. The socket stays in `ServerHub`.
- **Agents integration** = the Agent port (`integrations.agents.listen`, the hub's tailnet address) and an Agent per
  remote Host, each running one factorio server. Agents dial **out** to it; `Agents` (`hub/src/agents.ts`) checks the
  peer address before reading a byte and hands each Agent's game connection to `ServerHub`. Off: no Agent port.
- **Discord integration** = the bot, a frontend. Frontends (Discord, and the dashboard through the web API) only call the public
  API of `ServerHub` (`hub/src/servers.ts`), `RestartScheduler`, `Stats` (`hub/src/stats.ts`), `LiveFeed`
  (`hub/src/live.ts`, numbered events with replay) and the hub-core modules of the host, checks and services
  (`Hosts`, `Agents`, `Checks`, `Services`, `Restores`, `Deploys`, `Packs`, `Uploads`, `Library`); they
  never talk to mods, systemd or the database directly. Off: no bot and no `DISCORD_TOKEN` needed; everything else still runs.
- **Web integration** = the HTTP API (Hono, `127.0.0.1`, under `/api`) for the dashboard, with Discord OAuth login
  for admin-role members (its own `guildId`/`adminRoleId`, else `integrations.discord`'s; no bot needed) and SQLite sessions (`hub/src/web.ts`). Same
  frontend rule as Discord, plus its own session rows in `Db`. Off: no HTTP port and no `DISCORD_CLIENT_SECRET` needed.
- `hub/src/start.ts` (`startHub`) wires the hub from config; `index.ts` only builds the real outside world.
- The mod has no business logic and no Discord knowledge. The Factorio mod is the same, and talks only to its
  server's Agent (events out over local UDP, commands in over RCON), never to the hub.

## Changing the wire protocol

Protocol lives in four places that must change together:
1. `hub/src/protocol.ts` (`SCHEMAS` validation; the message types are in `hub/src/types.ts`),
2. the mod (`HubClient.java` hello, `GameEvents.java` messages) and the Agent (`agent/src`: it imports the hub's types
   with `import type` only, and `wire.ts` keeps copies of `PROTOCOL_VERSION` and `LIMITS` that `agent/test/wire.test.ts`
   checks against `protocol.ts`),
3. for game-connection messages the Factorio mod produces, `factorio/control.lua` and its UDP table in
   `factorio/CLAUDE.md` (the Agent turns those datagrams into the messages),
4. `docs/protocol.md`.
Bump `PROTOCOL_VERSION` (and the mod's hello `protocol`, and the Agent's copy) for any incompatible change.
`agentHello.protocol` is the same `PROTOCOL_VERSION`, accepted in the same range (`docs/adr/0004`).
The hub accepts `MIN_PROTOCOL..PROTOCOL_VERSION` (`protocol.ts`). Policy: keep the previous version supported, so
raise `MIN_PROTOCOL` only one release after a bump.

## Verify before claiming done

```bash
cd hub && npm test && npm run typecheck
cd mod && ./gradlew spotlessApply build   # runs JUnit tests too
cd web && npm test && npm run build       # the build also type-checks against the hub's API types
cd agent && npm test && npm run typecheck # the typecheck also covers the hub's types it imports
bash deploy/test-restore-backup.sh        # needs zip and unzip
bash deploy/test-install-web.sh
bash deploy/test-deploy.sh                # deploy-hub.sh and deploy-web.sh, with fake systemctl, npm and gh
bash deploy/test-add-server.sh            # with fake systemctl, runuser and SELinux tools; the config check is real
bash deploy/test-setup-agent-host.sh      # the agent Host's setup, with fake dnf, podman, Quadlet, systemctl, curl and more (needs jq)
bash deploy/test-deploy-agent.sh          # deploy-agent.sh, with fake curl, systemctl (playing the agent) and id
bash .github/test-changes.sh              # which parts CI runs (.github/changes.sh)
bash .github/test-release.sh              # the release script against a throwaway repo, mod-jars.sh, agent-tarball.sh, factorio-zip.sh and factorio-publish.sh (needs zip, unzip and jq)
```

Behaviour that needs a real server (event hooks, command capture) can only be checked by the manual
smoke test in the release's notes (older releases: their tickets) — say so rather than claiming it works.

## Releases

Hub, mod, dashboard, agent and Factorio mod are versioned separately (`docs/adr/0001`); a part's version is only its latest
`hub-vX.Y.Z`, `mod-vX.Y.Z`, `web-vX.Y.Z`, `agent-vX.Y.Z` or `factorio-vX.Y.Z` tag (the prefix is the part's folder).
Cut one with `.github/release.sh <hub|mod|web|agent|factorio> <major|minor|patch>`
from an up-to-date, clean `main`: it shows the next tag and its notes, asks y/N (`--yes` skips) and pushes only that tag.
Never delete or move a tag; fix a failed release forward with the next patch.
`.github/workflows/release.yml` runs CI for that part only (`.github/changes.sh`; an agent tag also runs the deploy tests, as the agent Host's setup ships at that tag), then creates the GitHub release. Its notes are
that part's commits (`.github/notes.sh`); for the mod it attaches one jar per Minecraft target, `orrery-<mc>-<version>.jar` (`.github/mod-jars.sh`, tested by `test-release.sh`), for the dashboard its build as `orrery-web-vX.Y.Z.tar.gz`
(the server never builds Angular; `web-v0.x` until the dashboard is finished), for the agent `agent/` without its tests,
its `package.json` carrying the tag's version (`.github/agent-tarball.sh`, tested by `test-release.sh`), as
`orrery-agent-vX.Y.Z.tar.gz` plus its `.sha256`, and for the Factorio mod `orrery_<version>.zip`
(`.github/factorio-zip.sh`, refusing a version that isn't `factorio/changelog.txt`'s top section), which `.github/factorio-publish.sh` then puts on the mod portal as `orrery` with the
`FACTORIO_API_KEY` repo secret (both tested by `test-release.sh`). Deploy from the dashboard's Host page
(Releases): a hub or dashboard deploy runs its `orrery-deploy@` / `orrery-deploy-web@` unit, a Mod deploy puts the jar in
place at the end of the server's countdown. Only `hub-v2.6.0` / `web-v0.5.0` / `agent-v1.1.0` and later deploy (`FLOOR` in
`hub/src/deploys.ts`). By hand still: units, polkit rules and the `/usr/local/lib/orrery` copies of `deploy-web.sh`,
`install-web.sh` and `add-server.sh` when a release changes them, and `install-web.sh` for a first install or an archive.

When a change ships in several parts, release them in this order, each in place before the next: hub, dashboard, agent,
Factorio mod. The Factorio server ships in two releases (the owner's decision of 2026-10-31; `docs/ROADMAP.md`).
**Release 1**: the Agent connection, status with UPS and paused, the VM as a second Host, chat, events, milestones and
linking, the console and logs, start, stop and restart with countdowns, and saves as Backups with restore. **Release 2**:
game updates and agent deploys from the dashboard. So in release 1 nothing is deployed to the Agent's Host from the
dashboard: the dashboard has no Game tab and no Agent rows under Releases (release 2's `FLOOR` holds `agent-v1.1.0`, as `agent-v1.0.0` has no `deploy` handler: the dashboard refuses to deploy from or to it, naming the setup re-run), the
friend re-runs `setup-agent-host.sh` as root at the new `agent-v` tag (it updates the agent, its units and its polkit
file; `--factorio <version>` changes the Factorio version), and mods, a new `orrery` release included, are put in
`/srv/factorio/mods` by hand. The mod must reach the portal in release 1, as players download it when they join, so
`FACTORIO_API_KEY` is needed then. The setup stops without a `factorio-v*` release to install unless `mods/` already
holds the `orrery` mod.

By hand for the Factorio server, once, in this order:
1. Cut and deploy `hub-vX.Y.0` **with the old `config.json`**; confirm the deploy is `ok`.
2. On the hub host: join the friend's tailnet as `tag:orrery-hub` and put `tailscale0` in the firewalld zone `tailnet`
   (the header of `deploy/orrery-hub.service` has the commands); install the changed `orrery-hub.service` (it waits for
   `tailscaled.service` and reads `/etc/orrery-factorio-account.env` if there is one); add `integrations.agents`, the
   `factorio` server and its Discord channel to `config.json`; `systemctl daemon-reload`; restart the hub. Rolling
   the hub back below this release: first roll the dashboard back to the previous `web-v` tag from Host > Releases,
   while this hub still serves it (the dashboard reads new hub API without a guard, ADR 0001, so its server pages break
   against an older hub; only its Releases rows don't, so a hub rolled back first can still be rolled forward from
   there). Then remove those config sections (the older hub refuses a server without a Mod token, and the factorio
   server has none, so it would not start), then roll the hub back.
3. Cut and deploy `web-vX.Y.0`; cut `agent-v1.0.0` and `factorio-v1.0.0` (the setup installs both; the mod
   reaches the portal from the second). The friend runs `deploy/setup-agent-host.sh` from the agent tag (its header
   has the options; `--no-hub` while the hub doesn't listen yet), and again from each later `agent-v` tag.

## Secrets

`hub/config.json` (server tokens, IDs) and `.env` (`DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`) are git-ignored. Never commit them.
`GITHUB_TOKEN` (with `integrations.github`, and for the library's Actions artifacts: a fine-grained token with read access to the repo's contents and Actions) lives in
the root-only `/etc/orrery.env` on the host (staging: `/etc/orrery-staging.env`), read by the hub and its deploy units.
`FACTORIO_USERNAME` and `FACTORIO_TOKEN` (the owner's factorio.com account, for the mod portal downloads of game updates,
release 2; nothing reads them in release 1) live in the root-only `/etc/orrery-factorio-account.env`, read by `orrery-hub.service`
alone: the deploy units load `/etc/orrery.env`, and their `npm ci` must never see the account. Never commit them or put them in
`config.json`. `FACTORIO_API_KEY` (the mod portal, with "Publish Mods" and "Upload Mods") is a GitHub repo secret, read only by
`release.yml`'s portal step.
On an Agent's Host, setup writes the root-only `/etc/orrery-agent.env` (`ORRERY_AGENT_TOKEN`, the Agent's token from the hub's
`config.json`; read by `orrery-agent.service`) and `/etc/orrery-factorio.env` (`RCON_PASSWORD`; read by the Agent's unit and the
container). The friend's machine holds them; the owner never sees them. Setup also writes a random `game_password` into
`/srv/factorio/config/server-settings.json` (kept on a re-run; its saved default in `/usr/local/lib/orrery/defaults/` is
root-only) and shows it only in `/srv/factorio/first-boot.txt` (factorio's, mode 600), for the friend to share with the players;
the owner sees it there too, as the friend sends that file.

## Issues and domain docs

- Bugs and loose tasks are GitHub issues on `Edward-Pratt/orrery` (via `gh`). Designs are not: they go in `docs/notes/`.
- `CONTEXT.md` is the glossary: name things with its terms, and avoid the words it lists under _Avoid_.
- `docs/adr/` holds the decisions. When a change contradicts an ADR, say so explicitly and update or supersede it,
  rather than silently overriding it.

# deploy

What each file here is for, and which test covers it. The rules for the whole repo are in the root `CLAUDE.md`;
how releases are cut and deployed is in `docs/RELEASING.md`.

Systemd units for the production host (hub; GTNH server with a FIFO console, no tmux — SELinux-safe), `orrery-hub.rules` (polkit: the hub's user may start/stop/restart exactly the listed units; **keep its `UNITS` in sync with `integrations.systemd`**, except the servers `add-server.sh` added, each with its own `60-orrery-<id>.rules`: remove that file when its server leaves the config, and the services an Agent backs, which the hub never runs systemctl on: its Agent does, on its own Host), the `Caddyfile` (TLS for the dashboard and Grafana;
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
`setup-agent-host.sh` sets up an Agent's Host (the friend runs it as root, and again only as `docs/RELEASING.md` says: to leave `agent-v1.0.0`, or for a release that changes the files it installs): Factorio in
a rootful Podman Quadlet (`factorio.container`), the Agent as `orrery-agent.service` from the newest `agent-v*`
release, the newest `factorio-v*` release's mod when `mods/` has none, `60-orrery-agent.rules`, and a random game
password in `server-settings.json` (kept on a re-run), shown only in the mode-600 `/srv/factorio/first-boot.txt`. A re-run
keeps the image, the Factorio version (a game update's too) and `--memory-max` unless told otherwise. It switches Factorio's `current` and
image together with `factorio.container`, once that release passed `--version` in that image, and the agent's `current`
last, after its units are written, so a re-run that fails on its way leaves both as they were; tested by
`test-setup-agent-host.sh`. `deploy-agent.sh` (setup's root-owned copy in `/usr/local/lib/orrery`) and
`orrery-agent-deploy@.service` ship with it: the hub starts an Agent deploy through the Agent, whose `deploy` handler
runs `systemctl start --no-block orrery-agent-deploy@<tag>.service` (allowed by `60-orrery-agent.rules`), and the unit
runs the script as factorio. It puts the release next to the running one, flips `/srv/orrery-agent/current`, restarts
the Agent and rolls back unless the new one writes its `connected` file within 60 s; its `deploy-status.json` goes
back to the hub as `deployResult`. It writes only `/srv/orrery-agent`; tested by `test-deploy-agent.sh`.

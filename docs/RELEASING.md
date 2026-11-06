# Releasing

How each part is versioned, cut and deployed, and the by-hand steps for the Factorio server. The rules that
must be followed are repeated in the root `CLAUDE.md`; this is the reference behind them.

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
place at the end of the server's countdown, and an Agent deploy (a row per Host) sends its Agent `deploy`, which starts
`orrery-agent-deploy@<tag>` on that Host. Only `hub-v2.6.0` / `web-v0.5.0` / `agent-v1.1.0` and later deploy (`FLOOR` in
`hub/src/updates/deploys.ts`; an Agent running a release below `agent-v1.1.0` is refused too, as it can't deploy itself). By hand still: units, polkit rules and the `/usr/local/lib/orrery` copies of `deploy-web.sh`,
`install-web.sh` and `add-server.sh` when a release changes them, and `install-web.sh` for a first install or an archive.
On an Agent's Host, an Agent deploy changes only the Agent's code: a release that changes `orrery-agent.service`,
`orrery-agent-deploy@.service`, `60-orrery-agent.rules`, `factorio.container` or `deploy-agent.sh` still needs the
friend to re-run `setup-agent-host.sh` from its tag, as do a new image (`--image`, `--refresh-image`) and `--memory-max`.

Deploying from Releases needs the `deploys` permission. Dashboard logins are local Users (ADR 0005, `docs/notes/users.md`):
an Environment's first owner, and an owner locked out with no other to help, come from the users CLI on the host as the
hub's OS user, which prints a one-use invite link (production: `cd /home/opc/orrery/current/hub && npm run users --
invite <you> /home/opc/orrery/config.json` as `opc`; Staging: the same from `/srv/orrery-staging/current/hub` as
`orrery-staging`, with `/srv/orrery-staging/config.json`); everyone else is invited from the Users page. The release
that brought Users is a hub and a dashboard release back to back (the old login card's "Log in with Discord" is a 404
between them), then that CLI invite on each Environment.

When a change ships in several parts, release them in this order, each in place before the next: hub, dashboard, agent,
Factorio mod. The Factorio server ships in two releases (the owner's decision of 2026-10-31; `docs/ROADMAP.md`).
**Release 1**, shipped 2026-11-01 as `hub-v2.14.0`, `web-v0.12.0`, `agent-v1.0.0` and `factorio-v1.0.0`: the Agent
connection, status with UPS and paused, the VM as a second Host, chat, events, milestones and linking, the console and
logs, start, stop and restart with countdowns, and saves as Backups with restore. **Release 2**, cut as the next hub
and dashboard minors and `agent-v1.1.0`, in that order: game updates (a factorio server's Game tab: the Factorio
version and its portal mods, a new `orrery` release included) and Agent deploys from Host > Releases. Production
deploys that hub first, then the dashboard: both features need the new hub (`hub-v2.14.0` reports `features.update`
false and lists no Agent hosts). `agent-v1.0.0` has neither an `update` nor a `deploy` handler, so `FLOOR` holds
`agent-v1.1.0`: the dashboard refuses to deploy a release below it, and any deploy onto an Agent running one, whose
Game tab says it has no game updates; those two name the setup re-run. So an Agent on release 1 reaches release 2 once
by hand: the friend re-runs `setup-agent-host.sh` as root from the `agent-v1.1.0` tag (it updates the agent, its units,
its polkit file and `deploy-agent.sh`); from there on, Agent releases deploy from the dashboard. `--factorio <version>`
still picks the Factorio version on a setup run, but a game update is the way to change it, and the mods, later. The
mod had to reach the portal in release 1, as players download it when they join, so `FACTORIO_API_KEY` was needed
then. The setup stops without a `factorio-v*` release to install unless `mods/` already holds the `orrery` mod.

By hand for the Factorio server, once, in this order:
1. Cut and deploy `hub-vX.Y.0` **with the old `config.json`**; confirm the deploy is `ok`.
2. On the hub host: join the friend's tailnet as `tag:orrery-hub` and put `tailscale0` in the firewalld zone `tailnet`
   (the header of `deploy/orrery-hub.service` has the commands); install the changed `orrery-hub.service` (it waits for
   `tailscaled.service` and reads `/etc/orrery-factorio-account.env` if there is one, which game updates need: see Secrets in the root `CLAUDE.md`); add `integrations.agents`, the
   `factorio` server and its Discord channel to `config.json`; `systemctl daemon-reload`; restart the hub. Rolling
   the hub back below this release: first roll the dashboard back to the previous `web-v` tag from Host > Releases,
   while this hub still serves it (the dashboard reads new hub API without a guard, ADR 0001, so its server pages break
   against an older hub; only its Releases rows don't, so a hub rolled back first can still be rolled forward from
   there). Then remove those config sections (the older hub refuses a server without a Mod token, and the factorio
   server has none, so it would not start), then roll the hub back.
3. Cut and deploy `web-vX.Y.0`; cut the `agent-v*` and `factorio-v*` releases (release 1: `agent-v1.0.0` and
   `factorio-v1.0.0`; the setup installs the newest of each, and the mod reaches the portal from the second). The
   friend runs `deploy/setup-agent-host.sh` from the newest agent tag (its header has the options; `--no-hub` while the
   hub doesn't listen yet). After that, Agent releases deploy from Host > Releases (from `agent-v1.1.0` on), and the
   friend re-runs the setup only as above: to leave `agent-v1.0.0`, or for a release that changes the files it installs.

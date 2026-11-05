# Factorio server through an orrery agent

Status: local design notes, not committed. Date: 2026-10-30. Based on `main` at `cde862c`; file and line references are at that commit.

This is the final design. It replaces the earlier drafts from the review session (kept only in that session's scratchpad) and applies the review in the appendix. Related local notes in this folder: `factorio-smoke-x64.md` (facts checked on a local x64 server) and `factorio-friend-setup.md` (the friend's tailnet steps).

Conventions:

- **(S*n*)** marks a statement that rests on a fact not yet checked on the friend's VM. Each one is a numbered smoke check in "First-boot smoke checks".
- "The owner" runs orrery and the production hub host. "The friend" owns the VM and runs every step on it. The owner never logs in to the VM.

---

## Resume here (state at the end of 2026-10-31)

The build ran as Claude workflows and was **stopped on purpose** (usage) partway through phase 2b. Nothing is pushed
or tagged. Everything below is local. Agent reports are saved in `docs/notes/factorio-build-log/` (`*.results.json`,
one entry per finished agent), with the workflow scripts (`workflow-scripts/`), the e2e harness scripts (`e2e/`), the
tailnet page sources (`tailnet-page/`) and `vm-facts.sh`.

### Branches (all under `.claude/worktrees/`)

| Branch (worktree) | State |
|---|---|
| `factorio-agent` (`wf_0b394bf2-e1d-5`) | Integration, HEAD `0cbe254`: contract, RCON fix, the mod, deploy, dashboard, **`main` (owner's edits), `fa/hub` M2-M5, `fa/agent` M1-M5 and `fa/docs` all merged** (no conflicts). Verified at `0cbe254`: hub 421, agent 86, web 221 tests pass; hub/agent typechecks and the web build pass; every deploy and .github test passes (test-deploy.sh with gpgSign off). Mod Gradle build not rerun (mod/ unchanged). |
| `fa/hub` (`fa-hub`) | M2-M5 done (`70a701a`): Agent port (address check, 1 MiB line cap, rate limit, agent-lost rules, paused), chat/milestones/linking (`factorio_links`), agent Services and one-restart countdown, console and logs through the agent, saves as Backups, restore. **M6 (game updates) and M7 (agent deploys) not done.** |
| `fa/agent` (`fa-agent`) | M1-M5 done (`3d3ca99`): config, hub connection, UPS/paused, host samples, unit state, UDP events, say/notice/reply, service control and the stopping rule, logs, saves and restore. **M6 (`update.ts`) and M7 (`deploy.ts`, `check.ts` first-boot report) not done.** |
| `fa/web`, `fa/factorio`, `fa/deploy` | Done, reviewed, merged into `factorio-agent`. |
| `fa/docs` (`fa-docs`) | ADR 0004, ADR 0001 lines, `CONTEXT.md` terms; last commit is a WIP (interrupted, not reviewed). |
| `fa/e2e` (`fa-e2e`) | Throwaway: hub+agent+mod heads merged for an end-to-end loop; the loop was stopped before it reported. Harness scripts copied to the build log. Never merge it. |
| `fa/rcon` | Merged; can be deleted. Also old `worktree-wf_0b394bf2-e1d-1..4`. |

### hub-v2.20.0 / web-v0.18.0 / agent-v1.4.0 cut 2026-11-02 (game extras; merged as `190a6b8`, release runs green)

Not deployed yet: the owner deploys hub, then web, then the Agent from Host > Releases, then the smokes.

#### Built on `fa/game-extras`

Owner chose (2026-11-02): game extras next (portal mod update notices + moderation), `/kick`, `/ban`, `/unban` allowed,
and the release-2 resume minor fixed. Production confirmed on hub-v2.19.1 / web-v0.17.0 / agent-v1.3.0, Upload save
smoked. Branch `fa/game-extras` = main + 6 commits (`8925333`..`cfe3533`); full Verify green (hub 555, agent 216, web
271, typechecks, web build). Next: owner's go to merge into `main` and cut hub-v2.20.0, web-v0.18.0, agent-v1.4.0 in
that order (deploy each from Host > Releases; friend does nothing), then the smokes in
`docs/notes/factorio-game-extras.md` "Release". After that: New world (stage B), then redesign save copies.

### hub-v2.19.0 / web-v0.17.0 / agent-v1.3.0 cut 2026-11-02 (save upload, built inline)

Upload save… on the Saves tab: the hub sends the upload to the Agent in 512 KiB base64 pieces over the Agent
connection (`saveUploadStart`/`saveChunk`/`saveUploadEnd`/`saveUploadCancel`; no separate fetch connection, unlike
the stage B design), the Agent checks sha256 and the save (`agent/src/save-check.ts`: zip names, one top folder,
`level.dat0`'s version, no newer than installed) and stores `uploaded-<time>-<name>.zip` timed older (loading it is a
Restore). `SAVES_FLOOR` agent-v1.3.0. Next: New world (stage B design: needs a setup re-run for
`factorio-create.container` and `orrery` 1.1.0's map commands), then the players panel and update notices
(`fa/game-extras` design), then off-site save copies.

### hub-v2.18.0 / web-v0.16.0 / agent-v1.2.0 cut 2026-11-02 ~00:00 UTC

Settings (the Settings tab: server-settings.json through the Agent's `settings`/`settingsSet`, live or by restart,
the verification toggle with its warning; floor agent-v1.2.0), the first-boot check's S6 fix. Deploy: hub, web, then
the Agent from Releases (the first dashboard Agent deploy). Switched to inline work (owner, 2026-11-01): the workflows
were stopped after their useful stage. Next inline: update notices and the players panel (design on `fa/game-extras`,
agent-v1.3.0), then New world and save upload (design in `docs/notes/factorio-world-settings.md`, stage B), then
off-site save copies (`docs/notes/factorio-save-copies.md` on `fa/game-extras`).

### In flight 2026-11-01 ~23:10 UTC

- `fa/world-settings`: stage A Settings (then stage B New world and save upload, with a hub<->Agent file transfer).
- `fa/game-extras`: mod update notices and a players panel (kick/ban/unban/promote/demote, the Agent builds the
  commands), shipping with Settings as agent-v1.2.0; and the design of off-site save copies
  (`docs/notes/factorio-save-copies.md`), to build once stage B's transfer lands.
- Owner chose (2026-11-01): off-site save copies, mod update notices, players panel; not now: committing these notes.
  Reminder: these notes and the build log are only on this laptop.

### hub-v2.17.0 / web-v0.15.1 cut 2026-11-01 ~23:00 UTC

Import mod list (Game tab: a client mod-list.json or pasted names, previewed, merged into the picks; hub
`POST …/game/check` against the cached 2.1 list). `web-v0.15.0` is a burned tag (a flaky game.spec request race, fixed in
`2f368ab`). Next: Settings (stage A of `fa/world-settings`) as hub-v2.18.0, the next web and agent-v1.2.0.

### hub-v2.16.0 / web-v0.14.0 cut 2026-11-01 ~22:20 UTC

The mod browser (Game tab update sheet: portal list fetched whole by the hub, cached 15 min, searched and sorted by the
hub; thumbnails proxied), a release listed on both channels reads stable, "Nothing to change" says why (the screenshot's
squeak-through-2 0.2.1 was already installed), the LiveFeed listener limit, a countdown cancelled by a dropped down
event; agent's check S6 wording waits for agent-v1.2.0. Design: `docs/notes/mod-browser.md` (tracked). In flight:
`fa/world-settings` (stage A Settings, then stage B New world and save upload). The personal site update is on
`site/orrery-factorio` in Edward-Pratt.github.io (`dc71f87`), not pushed.

### Release 2 CUT 2026-11-01 ~19:50 UTC

`factorio-agent-2` merged into `main` (`c038a5e`), then `hub-v2.15.0`, `web-v0.13.0`, `agent-v1.1.1`. `agent-v1.1.0`
is a burned tag (its release run failed on a flaky deploy test; no GitHub release, so setup and the hub never offer
it). Root cause, fixed in `48f5a05`: deploy-agent.sh's gate compared wall-clock times from two processes and a clock
stepped back on GitHub's runner; it now removes `connected` before each restart and checks the version only. Release-2
review findings and fixes: `factorio-build-log/` (session scratchpad `r2-finish.json`). Open, owner decision: after
updateResume a failed update starts the old server even if the owner had stopped it before (minor).
Go-live: deploy hub-v2.15.0 and web-v0.13.0, then the friend's setup at `agent-v1.1.1`, then the M2-M7 smokes.

### Friend's side 2026-11-01

Podman 5.8.2 (meets 4.6+). OCI ingress rule for UDP 34197 added. Admins for now: `Edguardia` only
(`--admins Edguardia`).

### Production 2026-11-01 ~19:00 UTC

Owner deployed `hub-v2.14.0` and `web-v0.12.0` (Minecraft fine), then on the hub host: the new `orrery-hub.service`,
`/etc/orrery-factorio-account.env`, and `config.json` with the `factorio` server, `systemd` entry `factorio`,
`discord.channels.factorio` and `integrations.agents` (listen `100.101.102.103:25584`, agent `factorio-vm` from
`100.90.80.70`, its token generated on the host). `check-config` passes; the Agent port listens. Backups on the host:
`config.json.bak` (before) and `config.json.broken` (a hand edit fixed in place). A rollback below `hub-v2.14.0` needs
those sections out first. Next: release 2 cut, then the friend's setup at `agent-v1.1.0` (token sent privately).

### Release 1 CUT 2026-11-01 ~17:40 UTC

`factorio-agent` merged into `main` (`9d7de61`, pushed; CI green), then `hub-v2.14.0`, `web-v0.12.0`, `agent-v1.0.0`,
`factorio-v1.0.0` (release runs all green; `orrery` 1.0.0 is on the mod portal, owner account Edguardia). Gates passed
first: e2e 14/14 (`factorio-build-log/e2e/RESULTS-r1-final.md`), final review (`r1-final-review.json` in the session
scratchpad; fixes `f22667d`..`cece4c0`), DS1 Podman. **Not deployed yet**: owner deploys hub first with the OLD
config.json, then the by-hand steps of M8, then web, then the friend's setup at `agent-v1.0.0`, then the M2-M5 smokes.
Release 2 (`factorio-agent-2`, worktree `fa2`) continues: e2e loop, review, docs; it must be re-merged with `main`.

### State 2026-11-01 16:00 UTC

- `factorio-agent` (worktree `wf_0b394bf2-e1d-5`) = release 1 with every review fix merged (`fa/r1-hub`, `fa/r1-agent`,
  `fa/r1-deploy`; F1-F5 and the 30 findings in `factorio-build-log/r1-review.json`, except AS4 and AC3c, being fixed now).
  Full Verify list green at the merge (hub 446, agent 111, web, every deploy and .github test).
- `factorio-agent-2` (worktree `fa2`) = release 1 + `fa/r2-hub` + `fa/r2-agent` (M6, M7) + a reconcile pass (`144c2a7`,
  `760af2c`: fresh-id resume/cancel, `LIMITS.url` 2048, deploy result after hello, stall timeouts). Merging release 1
  into it now, then the cross-check fixes (game mods' enabled rule, cancel rules, deploy wait vs unit timeout).
- Then: the release-1 and release-2 e2e loops (Factorio 2.1.24 headless re-downloaded into the session scratchpad), a
  final multi-lens review, release-2 docs.
- Open, owner: DS1 (run the Quadlet file in Podman on the laptop: `sudo pacman -S podman`), the factorio.com API key,
  `/etc/orrery-factorio-account.env`; whether `events` rows of factorio servers get a count cap (HT3).

- **DS1 done 2026-11-01** (rootless Podman 6.1.4 on the laptop, ports moved; `factorio-build-log/ds1-podman.results.json`):
  `/orrery-status` answers, S4, S5, S6, S19, S21, S22, S24, S29 pass; S23/S25 skipped (no SELinux; keep-id adds a
  passwd entry). Found: setup's `server-settings.json` lacked `name`/`description`, so Factorio refused to host (fixed
  on `factorio-agent`). Notes only: the mod hardcodes UDP 34199; Factorio logs `Error ... Got EOF on stdin` on every
  start (never alert on "Error" greps); the Quadlet path check assumes `/usr/libexec/podman/quadlet` (OL).

### In flight 2026-11-01 (new worktrees under `.claude/worktrees/`, all from `factorio-agent` at `13f59da`)

| Branch (worktree) | Work |
|---|---|
| `fa/r1-hub` (`r1-hub`) | Release 1: F1 + addendum (per-type rate budgets), F2, F3, F4, then the review's other hub findings. |
| `fa/r1-agent` (`r1-agent`) | Release 1: the agent's game-event budget (5/s, burst 30), the time-bomb `saves.test.ts:233` fix, then the review's agent findings and the rest of `check.ts`. |
| `fa/r1-deploy` (`r1-deploy`) | Release 1: F5 game password in setup, then the review's setup findings. |
| `fa/r2-agent` (`r2-agent`) | Release 2: agent M6 `update.ts`, then M7 `deploy.ts`. |
| `fa/r2-hub` (`r2-hub`) | Release 2: hub M6 (catalog, `GameUpdates`, routes, `updating()`, `features.update` back on), then M7. |

Rate budgets decided 2026-11-01 (hub and agent agree): per Agent-port connection 20 lines/s, burst 100, closed after
10 s over; per type, dropped not closed: `hostSample` 1 per 10 s with the hub's clock, game events 2/s burst 30,
`link`/`unlink` 1/s burst 5, `updateStep` 5/s burst 20, identical `serviceState`/`saves`/`installed` skipped. The
agent forwards game events at most 5/s, burst 30, and `updateStep` per step at most 1/s unless its state changes.

Plan after these: merge `fa/r1-*` into `factorio-agent` (full Verify list), then `factorio-agent-2` = that plus
`fa/r2-*`; the release-2 e2e loop (an update with one added mod and its dependency, an agent deploy); a multi-lens
review; release-2 docs (reverse release 1's "no update or deploy handlers" lines).

### Owner decision 2026-10-31: split release

Replaces "Release shape. One big release" in Decisions. **Release 1** = M1-M5 (agent connection, status/UPS/paused,
second Host, chat/events/milestones/linking, console/logs, service control with countdowns, saves/backups/restore,
the first-boot `check`), cut after the e2e loop and a review. Its dashboard hides the Game tab
(`features.update` false, fixed after the e2e loop) and Agent release rows (`DeploysAnswer.agent.hosts` empty). Without M6, the Factorio version
changes by a setup re-run with `--factorio` and mods are added by hand; without M7, the agent updates by a setup
re-run at the new `agent-v` tag. **Release 2** = M6 (game updates) and M7 (agent deploys). Release order inside each
stays hub, web, agent, Factorio mod. The mod must reach the portal in release 1 (players download it on join), so
the `FACTORIO_API_KEY` secret is needed for release 1.

### Next, in order (release 1)

1. ~~The local e2e loop~~ Done 2026-10-31 on `0cbe254`: all 10 scenarios PASS (`factorio-build-log/e2e/RESULTS.md`). Its one finding (an agent server reported `features.update`, so the Game tab showed with no M6 routes) is fixed in `factorio-agent` (hub `web.ts`: `update` false until M6). Not covered: real players, Discord, Podman/Quadlet, real systemd timeouts, the tailnet.
2. Review: **finished 2026-11-01** (agent package, setup script, hub beyond the Agent port, interfaces, Minecraft regressions; each batch adversarially verified): 30 findings kept, 2 refuted, in `factorio-build-log/r1-review.json`; fixes on `fa/r1-*`. Earlier: Findings in `factorio-build-log/review-release1.md`, none fixed yet: F1 major (hostSample stored per line with the agent's own `ts`, no cadence limit) and its addendum (the 50 lines/s per-line rate limit lets a token holder fill the feed/DB: add per-type budgets); F2 rejected sockets never destroyed, no per-peer cap; F3 `Links.#fails` map never shrinks; F4 `backup` `detail` posted to Discord without `md()`; F5 owner decision: no game password or whitelist on the internet-facing server. Finish the review (agent package, setup script), then fix.
3. ~~M8 docs~~ done 2026-10-31 (`99444bf`..`13f59da`). Then the cut per M8.

### Later (release 2)

1. Hub M6 and M7, agent M6 and M7 (prompts: `workflow-scripts/factorio-phase2b-*.js`, the `m6`/`m7` steps;
   the agent's update allowlist is `www.factorio.com`, `dl.factorio.com`, `dl-mod.factorio.com` after S11).
2. Merge the M6/M7 work into `factorio-agent` (release 1 is already merged); the whole Verify list
   (`test-deploy.sh` needs `tag.gpgSign=false` here); reconcile cross-part interfaces (the mod sends death `cause`/`killer`,
   not `message`; milestone `text` is the subject only; every RCON reply has `ok`; `EnvironmentFile=` is two lines;
   `deploy-status.json` and the `connected` file between `deploy-agent.sh` and `deploy.ts`); the local e2e loop
   (hub + agent + headless 2.1.24 + a fake `systemctl`); a multi-lens review; M8 docs (root `CLAUDE.md`, `ROADMAP.md`
   after the owner's edits).
3. ~~Notes to fix~~ (done 2026-10-31: platforms seeding, the agent asset name, the death fields).

### Decisions taken 2026-10-31

- **Agent-port line cap `LIMITS.lineBytes` = 1 MiB** (Claude, while the owner was away; replaces this note's 64 KiB,
  which contradicted its own field limits). The agent trims every line it sends to fit. One constant to change.
- A Mod's long `cmdResult`/`cmdLate` output and `backup.detail` are **cut**, not refused, on the Mod port (deployed
  Forge mods send up to 2000 lines); everything else over a limit is refused.
- Tokens and server ids are at most 256 characters (config refuses longer ones; the wire caps them).
- **HT3 (owner, 2026-11-01): a lifecycle rate limit, not a row cap.** The hub records at most about 20 lifecycle
  rows an hour per factorio server and drops the rest (one log line); old history is never deleted.
- **Later (owner, 2026-11-01): a separate uid for the agent** (`orrery-agent`, the container keeps `factorio`, saves and
  mods through a shared group), so the container's uid can't read the agent's token from `/proc/<pid>/environ`.
- **License (owner, 2026-11-01): MIT** for the repo and the mod (`LICENSE` at the root and in `factorio/`); the portal's
  `default_mit` matches. **First mod version 1.0.0** (`factorio-v1.0.0`; the changelog says so).
- **F5 (owner, 2026-11-01): a game password.** Setup writes a random `game_password` into `server-settings.json` and
  prints it in `first-boot.txt`; the friend shares it with the players.

### Done by hand on 2026-10-31

- Tailnet: final grants policy with tests live (set through the API; the browser editor hung). VM `<vm-name>`
  (100.90.80.70) tagged `tag:factorio`; hub `orrery-hub` (100.101.102.103) joined; hub firewalld zone `tailnet`
  holds `tailscale0` with only the rich rule. From the VM: 22 times out, 25584 refused (nothing listens yet).
- S11 passed (302 to `dl-mod.factorio.com`, query key `secure` only). #143 (Packs v2 smoke) passed.
  `#factorio` channel id `1566211046257991700`. VM facts in `factorio-friend-setup.md`.

### Still waiting on

- Owner: the factorio.com API key for `FACTORIO_API_KEY`; Still open 1 (dev tags to the portal); whether to commit
  `docs/notes/` (the repo is **public**: strip the friend's VM details and tailnet IPs first).
- Friend: OCI ingress for UDP 34197; the admins' Factorio names; what the Docker/Java services are; a memory cap
  (or none); step 13 of the tailnet page (revoke the API token).

## Earlier plan (2026-10-31 morning, superseded by "Resume here")

State at the end of 2026-10-31. Nothing is pushed.

### 1. The friend's setup

Follow `factorio-friend-setup.md`, which also lists what to bring back. It was updated after the review:

- Setup needs **Podman 4.6 or newer**. If his is older, he updates Podman first.
- The hub's firewalld zone admits only the VM's tailnet IP, through a rich rule, instead of opening 25584 to the whole
  zone.

The page to send him is the "Factorio Tailnet Setup" artifact: https://claude.ai/artifact/KV5oQt4ApFEt3o2g6XarMo. It
is private until shared, and has the same changes.

### 2. Your own tasks

- Create a `#factorio` channel in the Discord guild and note its channel id. It goes in `discord.channels.factorio`.
- Create a factorio.com API key with "ModPortal: Publish Mods" scope, to claim the name `orrery` with the first build.
  Keep it private; it later becomes a GitHub Actions secret, never a file in the repo.
- Optional: `sudo pacman -S podman` on this PC, so the Quadlet unit can be tested locally on x64 before the friend
  runs setup.
- Answer "Still open" below. The first item, whether dev tags may publish `orrery` 0.x to the portal, decides how M1
  installs the mod.

### 3. Uncommitted work on `main`

The working copy on `main` holds edits from 2026-10-31:

- the spec-process change (`CLAUDE.md`, `README.md`, `docs/ROADMAP.md`, `mod/CLAUDE.md`, `docs/agents/` deleted);
- your own `deploy/orrery-hub.rules` change;
- this `docs/notes/` folder (untracked).

Commit them when ready.

### 4. Branch `factorio-agent`

The branch is local only. Its worktree is `.claude/worktrees/wf_0b394bf2-e1d-5`. It merges four pieces built in
parallel:

- release plumbing for the `agent` and `factorio` parts, with `.github/factorio-zip.sh` and a `factorio/` stub;
- the `agent/` package with its Source RCON client;
- multi-host Host support (`/api/hosts`, a host picker);
- a game kind per server, with TPS out of 20 or UPS out of 60.

Test results there:

- `hub` (356 tests), `web` (187 tests and the build), `agent` (11 tests and the typecheck), `test-restore-backup`,
  `test-install-web`, `test-add-server`, `test-changes` and `test-release` all pass.
- `deploy/test-deploy.sh` fails on this PC only: git config has `tag.gpgSign=true`, so its plain `git tag` asks for a
  message (`fatal: no tag message?`). Nothing in `deploy/` changed. Run it with signing off, or let CI run it.

To do, in this order:

1. **Commit the staged review fix** in that worktree. It removes the "Mod on X" deploy row for factorio servers (in
   `hub/src/updates/deploys.ts`, with a test) and a duplicated agent line in the verify list in `CLAUDE.md`. The workflow's
   own commit was blocked by the rtk commit guard.
   `cd .claude/worktrees/wf_0b394bf2-e1d-5 && git commit -m "fix: no Mod row for a factorio server; one agent line in the verify list"`
   and add the `Co-Authored-By` line if you want it.
2. **Fix the RCON client** (`agent/src/rcon.ts`). It was built before the x64 smoke results, and two of its
   assumptions are wrong:
   - It sends an empty end-marker packet after each command. Factorio never answers one, so every `exec` would hang
     until its timeout.
   - It caps packets at 4 MiB. Factorio sends each reply as one packet of any size (5 MB tested).

   The fix: one reply packet per command, matched by id; no marker; a higher cap (16 MiB); strip the trailing `\n`.
   Make `agent/test/fake-rcon.ts` behave like Factorio, not like a generic Source server. See "Architecture" (RCON)
   and S8 below.
3. **Gaps the integration review found but didn't fix:**
   - The `TAG` pattern in `hub/src/updates/deploys.ts` ignores `agent-v*` and `factorio-v*`.
   - A factorio server is still allowed `backupDir`, `keep` and `service` in config.
   - `/tps` still says "slowest dimensions", and a Factorio lag notice would say "slowest: unknown".
   - `ci.yml`, `.github/changes.sh` and the `CLAUDE.md` verify comment say the agent imports `hub/src/types.ts`. Not
     true yet.
   - `/api/hosts` exists only when `integrations.host` is on.
   - Release order: the dashboard reads `card.rate` and `/api/hosts` without a guard, so deploy the hub first.
4. **Provenance.** Commit `71efc67` (the RCON client) was made with `/usr/bin/git`, which skipped the rtk commit hook
   after a plain commit was refused. Its content was checked: only `agent/` files and an `agent/node_modules/` line in
   `.gitignore`.
5. **Clean up.** Once the merge looks right, the task worktrees `wf_0b394bf2-e1d-1` to `-4` and their branches can be
   removed.

### 5. Then build

Continue with "Build plan" below. The Factorio mod is the next piece that needs nothing from the friend's VM. It can
be tested against the local 2.1.24 headless server, the same way `factorio-smoke-x64.md` was produced.

---

## Summary

This adds one Factorio 2.1 Space Age server, with light non-overhaul mods, to the orrery the owner already runs.

- The server runs on the friend's existing Oracle Linux 9 aarch64 (Ampere) VM. That VM already runs other software, so setup touches only its own user, folders, units and ports.
- Factorio 2.1 ARM64 headless needs GLIBC_2.38. OL9 has glibc 2.34. So Factorio runs in a Podman container with a newer glibc, and OL9 stays as it is.
- A small Node service on the VM, the **Agent**, runs natively on the host. It dials out to the hub over the friend's Tailscale tailnet, on port 25584, with one token. It speaks the same JSON-lines protocol as the Mod, on its own listener with stricter limits.
- The agent owns everything local to the VM: RCON, the Factorio mod's events, `factorio.service` (generated by Quadlet, controlled through polkit), saves, host metrics, game and mod updates, and its own deploys.
- A new control-only Factorio mod, `orrery`, is published publicly on mods.factorio.com. It emits chat, join, leave, death, research and milestone events, handles account linking, and answers a few RCON commands.

The hub stays the owner of all state. Frontends stay the same in kind:

- **Discord**: a new channel in the same guild. Two-way chat, join, leave, death with cause, every research finished, and rocket and planet firsts.
- **Dashboard**: the server with chat, status, UPS and a console; start, stop and restart with countdowns; saves as Backups, with restore; a Game tab for Factorio and mod updates; an Agent row under Releases; the VM as a second Host.
- **Account linking**: one Discord `/link` code works in either game. Factorio names are stored next to Minecraft names.

Everything ships as one release, made of hub, web, agent and Factorio mod tags, cut at the end. It follows the open Packs v2 smoke test (#143) on the same host.

### Non-goals

- Crash-log attachments for the Factorio server.
- More than one server per agent, and agents that only report a host.
- A publicly listed Factorio server. No factorio.com credentials go in `server-settings.json`.
- Factorio in Packs, the Pack library, New server or `add-server.sh`. Those stay Minecraft-only.
- A staging agent. Staging (#91) gets no agent.
- Translating localised names. Research and planet names are prettified internal names (S14).
- TLS inside the tailnet. WireGuard already encrypts it. ADR 0004 records this.
- Upgrading the VM's OS or Podman, or replacing Podman.
- Building or publishing a container image.

---

## Decisions (owner's)

These are fixed.

- **Server.** One Factorio 2.1 Space Age server with light non-overhaul mods.
- **Host.** The friend's existing Oracle Linux 9 aarch64 (Ampere) VM, which already runs other software. The friend runs every setup step himself: a blind-run root script plus clear steps. The owner never logs in.
- **Container.** Factorio 2.1 ARM64 headless needs GLIBC_2.38 (checked with `readelf`; it links only libc, libm and libresolv). OL9 has glibc 2.34. So Factorio runs in Podman and OL9 stays: a minimal image with glibc 2.38 or newer, program files and saves bind-mounted from the host, host networking, and `factorio.service` generated by Quadlet. The agent runs natively on the host.
- **Network.** The friend's Tailscale tailnet; the owner's production hub host joins it. The tailnet policy, which the friend sets through the Tailscale API (`factorio-friend-setup.md`; not in place yet): `tag:factorio` may reach `tag:orrery-hub` on `tcp:25584` only; members may SSH to `tag:factorio`. The hub host puts `tailscale0` in a firewalld zone with only 25584/tcp open, and joins with `--accept-dns=false`.
- **Agent.** A small Node service on the VM dials out to the hub on port 25584 (a separate listener bound to the tailnet IP; the Mod port 25580 stays on loopback), with one token per agent. It owns RCON, the mod's events, `factorio.service` (polkit-scoped), saves, host metrics, game and mod updates, and its own deploys.
- **Release shape.** One big release, no phasing, with internal milestones and smoke tests.
- **Scope of the release.** Two-way chat (same Discord guild, a new channel, plus the dashboard); join, leave and death with cause; status with UPS and lag alerts; an RCON console; start, stop and restart with countdown; saves as backups kept on the VM only, with restore; Packs-like Factorio and mod updates (backup, countdown stop, swap, health gate, rollback); agent deploys from the dashboard (`agent-v*` assets from the public GitHub repo, rollback if it won't stay connected); the VM as a second Host.
- **Discord posts.** Every research finished. Rockets and planets: firsts only (first rocket, first space platform, first landing on each planet, per force).
- **Account linking.** Yes, shared with Minecraft: one link per Discord user, the Factorio name stored alongside.
- **Auto-pause.** Stays on. Lag alerts and hung detection stay quiet while paused.
- **Factorio mod.** Published public on mods.factorio.com as `orrery`. The owner's factorio.com account uploads it; the portal API key lives only in GitHub Actions secrets.
- **Download token.** The owner's factorio.com download token lives on the hub host. The agent gets only resolved download links. This needs the first-boot redirect check (S11). Fallback: a root-only env file on the VM.
- **Saves.** A named save every 6 h if anyone played since the last, before every update, and on demand. Keep the newest 20. Factorio autosaves are listed too.
- **Listing.** Private server, not in the server browser. Players join by address.
- **Restarts.** `factorio.service` has `Restart=on-failure`. Restarts go through `systemctl restart`. An in-game `/quit` leaves it stopped.
- **Access.** The friend already has the Discord admin role. No new permission model.
- **Specs.** Local notes, not GitHub issues. No `/to-spec` format.
- **Release order.** Hub first, then web, then agent, and the Factorio mod last. After the open Packs v2 smoke test (#143) on the same host.

---

## Architecture

### Parts

| Part | Folder / tag | New or changed |
|---|---|---|
| Hub | `hub/`, `hub-v*` | New `integrations.agents` and the `Agents` hub-core module (listener, handshake, RPC). Servers get a `game` kind. Services, Backups, Logs and Restore get per-server sources. Multi-host `HostMonitor`. New `GameUpdates` and `FactorioCatalog`. Deploys gain an `agent` part. Links gain Factorio names. Game-aware wording (TPS or UPS). |
| Agent | `agent/`, `agent-v*` (new) | Node 24+, TypeScript run directly like the hub, no runtime dependencies. Runs natively on the VM as `orrery-agent.service`, with a private Node build. |
| Factorio mod | `factorio/`, `factorio-v*` (new) | Control-only Lua: `info.json`, `control.lua`, `locale/en/orrery.cfg`, `changelog.txt`. Published as `orrery`. |
| Dashboard | `web/`, `web-v*` | Host picker, server tabs gated per feature, a Game tab, agent rows under Releases, TPS or UPS labels. |
| Forge Mod | `mod/` | No change. |
| Deploy | `deploy/` | `setup-agent-host.sh`, `deploy-agent.sh`, `factorio.container` (Quadlet), `orrery-agent.service`, `orrery-agent-deploy@.service`, `60-orrery-agent.rules`, and their tests. |
| CI | `.github/` | `agent` and `factorio` parts, the Factorio zip script, the portal upload. |

### Trust boundary

```
 Owner's hub host (OL, SELinux, firewalld, user opc)     Friend's VM (OL9 aarch64, glibc 2.34, other software)
 ┌────────────────────────────────────────────┐          ┌───────────────────────────────────────────────┐
 │ orrery-hub                                 │          │ orrery-agent.service (native, user factorio)  │
 │  127.0.0.1:25580  Mod port (unchanged)     │          │   node: /usr/local/lib/orrery/node (private)  │
 │  127.0.0.1:25581  web API (Caddy -> /api)  │ tailnet  │   state: /srv/orrery-agent (not in container) │
 │  100.a.b.c:25584  Agent port ◄─────────────┼──────────┼── RCON 127.0.0.1:27015                        │
 │    firewalld zone `tailnet`: rich rule,    │WireGuard │   UDP 127.0.0.1:34199 ◄─ only from :34198     │
 │    source = VM's tailnet IP, 25584/tcp     │          │   systemctl factorio.service (polkit)         │
 │    peer address checked at accept          │          │                                               │
 │  /etc/orrery.env: GITHUB_TOKEN             │          │ factorio.service (Quadlet -> podman, rootful, │
 │  /etc/orrery-factorio-account.env:         │          │   runs as factorio's uid, Network=host)       │
 │    FACTORIO_USERNAME, FACTORIO_TOKEN       │          │   /opt/factorio (ro, :z)  game binaries       │
 │    (read only by orrery-hub.service)       │          │   /srv/factorio (rw, :z)  saves, mods, config │
 └────────────────────────────────────────────┘          │   send_udp from 127.0.0.1:34198 -> :34199     │
                                                         │   0.0.0.0:34197/udp ◄── players (by address)  │
                                                         └───────────────────────────────────────────────┘
```

### Trust rules

- **Exposure.** The hub exposes only the Agent port to the tailnet, bound to its tailnet IP. The Mod port and the web API stay on loopback. The documented "Hub binds 127.0.0.1" boundary still holds for Minecraft.
- **Hub host firewall.** `tailscale0` goes in its own firewalld zone, `tailnet` (the name used in `factorio-friend-setup.md`), with the default reject target and no open ports. One rich rule allows only the VM: `rule family=ipv4 source address=<vm-ts-ip> port port=25584 protocol=tcp accept`. Tailscale installs its own netfilter rules, so this must be proven with a port scan (S13).
- **Hub host joins the tailnet** as `tag:orrery-hub`, with `--accept-dns=false`. Tailscale SSH stays off on the hub host.
- **Tailnet policy** (the friend's, set through the Tailscale API; its tests refuse a save that opens the hub's known ports to the VM). The friend administers it, so the hub does not rely on it alone.
- **The Agent port is hostile input.** Anything on the friend's tailnet that the policy lets through can reach it, and the agent's peer is on another person's machine. One bad line must never take down the hub, because the hub also runs the GTNH bridge, the Discord bot and the dashboard. So:
  - The peer address is checked in the connection handler, before any byte is read. A mismatch destroys the socket silently. This applies to both first-line kinds (`agentHello` and the game `hello`).
  - Lines are read from raw chunks with a hard cap of 64 KiB per line, before and after the handshake. Over the cap, the socket is destroyed.
  - Every schema field has a maximum length (see "Protocol additions").
  - Events copy only the schema's fields. `ServerHub` stops spreading `msg` (`servers.ts:333`).
  - A per-connection rate limit (a token bucket, for example 50 lines/s with a burst of 200). Over the limit, lines are dropped and logged once. Ten seconds over the limit closes the connection.
  - The agent token is at least 32 characters and compared with `timingSafeEqual`.
  - An agent may speak only for the one server listed under it.
- **Agent-side checks.**
  - The agent never runs a path or argv it received from the hub.
  - Every RPC maps to a fixed operation on its own configured unit, folders and file names, with names checked against its own listing.
  - The `update` message is validated like any other input: `version` must match `^\d+\.\d+\.\d+$`; mod names must match `^[A-Za-z0-9_. -]+$` and contain no `..`; URLs must be `https` and on an allowlist of hosts (`www.factorio.com`, `dl.factorio.com`, and `dl-mod.factorio.com`, the mod CDN host S11 found). Redirects are followed only to allowlisted hosts.
  - The agent does not trust hashes from the hub. It fetches `https://www.factorio.com/download/sha256sums/` itself for the game, and the public `https://mods.factorio.com/api/mods/<name>/full` for each mod's `sha1`. A mismatch with the hub's values fails prepare.
  - The agent never runs `podman`. It has no root, no Podman socket and no rights over other containers. Only the setup script, run by the friend as root, pulls the image and writes the Quadlet file.
  - polkit lets user `factorio` start, stop and restart `factorio.service`, restart `orrery-agent.service`, and only start `orrery-agent-deploy@agent-vX.Y.Z.service` for well-formed tags.
- **The container is less trusted than the agent.** Factorio is internet-facing (34197/udp), runs third-party Lua mods, and can write everything under `/srv/factorio`. So:
  - The agent keeps all its own state (`update.json`, staging bookkeeping, the release list) under `/srv/orrery-agent`, which the container does not mount.
  - The agent never takes a path, version or name from any file under `/srv/factorio`. Release names are validated against `^\d+\.\d+\.\d+$` before any symlink flip.
  - Saves, mods and logs are opened with `O_NOFOLLOW`, checked with `isFile()` and a matching `st_dev`, and copied from the open file handle (the pattern of `hub/src/servers/logs.ts:71-80`).
  - Everything that comes back over RCON (status, players, versions) is untrusted. It drives display and health gates, never a file path or a security decision on its own.
- **Container.** Factorio runs as factorio's uid with no capabilities, `--security-opt no-new-privileges`, a read-only root filesystem, and the game binaries mounted read-only. SELinux confines it as `container_t`.
- **Credentials.** Owner credentials (factorio.com, GitHub) stay on the hub host, unless S11 fails. The only secrets on the VM are the agent token and the local RCON password.

### Data flow

```
 player chat/join/leave/death/research/rocket/platform/landing/link
   └► factorio mod: helpers.send_udp(34199, json, 0)   [server-only, source port 34198]
        └► agent (UDP listener, source and seq check) ─ game connection ─► hub ServerHub ─► LiveFeed, Discord, Db
 Discord/dashboard chat ─► hub `say` ─► agent ─► RCON `/orrery-say {json}` ─► game.print (no echo)
 Discord /link ─► code ─► player types `/orrery-link CODE` ─► `link` ─► Links ─► `linkResult` ─► `/orrery-reply`
 agent every 5 s ─► RCON `/orrery-status` ─► {tick, tick_paused, players, version, mods}
        └► heartbeat {tps: UPS, players, paused} ─► hub (lag, tps rows, hung detection)
 dashboard Stop/Restart ─► Services (agent backend) ─► countdown via `notice` ─► agent ─► systemctl --no-block
 dashboard Game update ─► GameUpdates (catalog, dependency resolution, resolved URLs) ─► agent prepare/backup
        ─► hub countdown stop ─► agent swap/start/gate/rollback ─► step notices
 agent every 60 s ─► hostSample ─► HostMonitor[vm-id] ─► Host page, host notices
```

With `Network=host`, RCON, the UDP game port and `send_udp` to the agent all use the host's network stack, exactly as a native install would.

### Agent connection: the existing protocol on its own listener

`integrations.agents.listen { host, port }` (for example `100.x:25584`) runs a second TCP listener. It keeps the 5 s hello deadline and the strict pre-handshake rule, and adds the byte cap, field limits, rate limit and accept-time address check above. The first line must be `agentHello`, or a game `hello` for that agent's server. The Mod port 25580 does not change.

Why a separate port: the Mod port's loopback bind is a documented trust boundary; firewalld and the bind address then apply to agents alone; the Forge mod and `PROTOCOL_VERSION` stay untouched.

**Boot race.** `orrery-hub.service` orders only `After=network-online.target`, and the tailnet IP may not exist yet. The listener retries the bind every 10 s on `EADDRNOTAVAIL`, logs once, and never blocks hub startup. The unit also gains `After=tailscaled.service`.

**ServerHub timers.** Hung detection and the 60 s offline grace timer start today inside `listen()` (`servers.ts:129-131`), which `start.ts:119` calls only with the Minecraft integration. They move to a `ServerHub.start()` that `startHub` always calls. `listen()` keeps the socket only. Sockets passed to `attach()` join `#sockets`, so `close()` destroys them.

Rejected: opening the Mod port to the tailnet; a Tailscale TCP forward to loopback (it hides the peer address); separate protocol versioning.

### Liveness: two connections and an agent-lost rule

- **Agent connection.** Persistent, opened with `agentHello { protocol, agentId, token, agentVersion }`. It carries host samples, service state, saves, RPCs and update steps. It stays up while Factorio is down, which the Start button needs.
- **Game connection.** It reuses the existing `hello`, with the agent's token as `token`. `serverId` must be that agent's `server`. The hub accepts it only while that agent's connection is up. The agent opens it only while RCON answers. From then on `ServerHub` treats it like a Mod connection.

What an outage means:

1. **Planned agent exit.** On a deploy or SIGTERM, the agent sends `bye` and closes both connections. The hub emits the new silent lifecycle `lost`, which records `unknown`, posts nothing and clears players and TPS. Reconnecting brings the server back without an alert.
2. **Agent lost.** The agent sends `ping` every 10 s. With no line for 20 s, or a close without `bye`, the hub marks the agent lost. It destroys the game connection, emits `lost`, and posts one `agentLost` host notice to `alertsChannel`, then `agentBack` on reconnect. 20 s is under `hungMs` (30 s), so a tailnet partition gives one host notice, not "Server not responding".
3. **Game connection closes without `stopping`, agent connection up.** The hub waits up to 5 s for the agent connection to close too. If it does, rule 2 applies. Otherwise it is a crash ("went down unexpectedly").

**The `lost` lifecycle.** `Lifecycle` (`types.ts:69`) gains `lost`. It maps to `unknown` in `db.ts` `LIFECYCLE_STATES`, and is silent in `format.ts` like `offline`. It joins `CARD_EVENTS` in `web/src/app/servers/changes.ts`, and the web history and attention texts (which say "the mod is not connected" today). LiveFeed drops the server's latest TPS on it, as on `stopped`.

**When the agent sends `stopping`.** Only for stops the agent started itself (a `serviceAct` stop or restart, an update's stop). For any other change, it waits for a final unit state (`inactive`, `failed`, or `activating` with an auto-restart) and uses `Result`: `success` means stopped, anything else a crash. A Quadlet unit may pass through `deactivating (stop-post)` on a crash too, so `deactivating` alone decides nothing.

**Hung detection.** A heartbeat is sent only after a successful RCON round trip to `/orrery-status`, never from a timer. RCON answers while auto-paused (verified on x64, S1), so heartbeats continue while paused and a frozen Factorio shows as hung even then. Hung detection is turned off only while the agent is lost, never because of `paused`.

Rejected: one multiplexed connection with `up` and `down` messages. It would refactor `ServerHub`'s `Conn` for the same outcome.

### Mod to agent: `helpers.send_udp`

Factorio starts with `--enable-lua-udp 34198`. The mod calls `helpers.send_udp(34199, helpers.table_to_json(evt), 0)`. Each event carries a `seq` kept in `storage`, so the agent logs gaps.

Verified on x64 (`factorio-smoke-x64.md` section 4): `--enable-lua-udp <port>` is the local port Factorio binds on `127.0.0.1`, and it is the source port of every datagram. `send_udp` with no listener raises no error and logs nothing. Payloads up to 60,000 bytes arrive; 70,000 fail with only a log warning. If the port is taken, Factorio logs `Opening Lua UDP Socket failed: ... Address already in use`, keeps running, and `send_udp` silently does nothing.

**Authenticating the channel.** The VM runs other software, and any local process can send to 127.0.0.1:34199. So:

- The agent listens on `127.0.0.1:34199` and accepts packets only from `127.0.0.1:34198`, and only while `factorio.service` is active.
- After each start, the agent reads `factorio-current.log` and requires the line `Opening socket at (IP ADDR:({127.0.0.1:34198}))` for the Lua socket. If it finds `Opening Lua UDP Socket failed` instead, or neither line within 60 s, it drops all UDP events until the next start and posts one notice ("game events are off: port 34198 is taken"). This closes the race where another process grabs 34198 before Factorio does.
- `link` and `unlink` are accepted only for names in the latest `/orrery-status` player list.
- Events are at most 4 KiB; the agent drops anything larger.

Why UDP: `send_udp(…, 0)` acts only on the server, while `print` runs on every peer; Factorio's stdout goes to the journal, not to the agent; mod-registered commands do not flag the save (verified), unlike `/sc` and `/c`. Losing events while the agent is down matches the Mod's policy.

Rejected: stdout `print` (journal parsing, runs on every peer); a `write_file` tail (rotation, a disk write per event; it stays the fallback); RCON polling an outbox in `storage`.

### Agent to mod: RCON with mod commands

RCON binds `127.0.0.1:27015` with a random password. The agent uses non-zero packet ids and reads each packet by its int32 size field. Factorio sends one packet per command of any size (5 MB tested) and never answers an empty sentinel packet (verified).

Admin commands return at once unless `e.player_index == nil`. Over RCON it is nil (verified on x64, S2):

- `/orrery-say {json}`: `game.print` with `skip = never`, shown as `[Discord] <author> msg` (blue) or `[Dashboard]` (gold). `game.print` raises no `on_console_chat`, so no echo (verified). Before printing, the mod neutralises rich text in the author and message by inserting U+200B after every `[`, so Discord text cannot render `[color=…]`, `[img=…]`, `[gps=…]` or `[special-item=…]` tags.
- `/orrery-notice {json}`: system lines such as countdowns, in yellow.
- `/orrery-status`: `rcon.print(table_to_json{tick, tick_paused, players, version, mods = script.active_mods, loaded})`.
- `/orrery-save <name>`: `game.server_save(name)`.
- `/orrery-reply {json}`: `{player, ok, message}`, printed to that one player. Used for link results.

Player commands (they need a non-nil `player_index`, and take the player's name from `game.players[index].name`, never from the text): `/orrery-link <CODE>` and `/orrery-unlink`.

The mod drops `on_console_chat` events with no `player_index`, so plain console text an admin types on the dashboard never reaches Discord (plain RCON text raises `on_console_chat` with nil `player_index`, verified).

**Every handler runs in `pcall`.** Verified on x64: an uncaught Lua error in a mod command handler ends the server with exit 255 and **no save**. So every command and event handler in `control.lua` is wrapped in `pcall`. A command reports its error as JSON through `rcon.print`; an event handler logs it with `log()` and drops the event.

**The agent never sends `/sc` or `/c`.** On an unflagged save the first one is refused with "Please repeat the command", and the repeat flags the save for good (verified).

### UPS, auto-pause and hung detection

Verified on x64 (S1): RCON answers while auto-paused with 0 players. Each RCON command runs one game tick, so `game.tick` advances by one per poll, not with time. `game.tick_paused` stays `false` under auto-pause.

- **UPS** = Δ`game.tick` / Δ wall time between `/orrery-status` polls every 5 s. It travels in the heartbeat's `tps` field; the server's `game` sets the scale to 60.
- **`paused`** is set by the agent when any of these holds: `tick_paused` is true; no players are online and `auto_pause` is on in `server-settings.json`; or Δtick is at most 1 per poll with players online (an admin's pause, if it does not set `tick_paused`; S32). The `auto_pause` value is read as a plain boolean; it comes from a container-writable file, so it only affects alerting.
- **While paused:** `lag.ts` neither samples nor alerts; no `tps` rows are recorded and the hub ignores the heartbeat's `tps`; hung detection keeps running (heartbeats keep coming); the dashboard shows "Paused".
- **Lag alert.** UPS under `lagTps` (default 50 for Factorio) for `lagMinutes`, while players are online and not paused.

### Server `game` kind

- `servers[].game` is `'minecraft'` (default) or `'factorio'`. It decides whether a Minecraft token is required, the rate scale and label (TPS 20 or UPS 60), the `lagTps` limit, the console dialect, Discord wording and avatars, the link table and hint, and which features exist.
- A Factorio server has no `dir`. It must be the `server` of exactly one agent.
- **Intents replace hard-coded console strings.** `ServerHub` gains `broadcast(id, text)` and `backup(id, by)`. For Minecraft they send today's `cmd` (`say …`, `backup start`). For Factorio they send the new `notice` and `save` messages. The agent builds every RCON string and does all sanitising. The hub never builds Lua or Factorio command text.
- `runCommand` no longer strips the leading `/` for Factorio (`servers.ts:211`). Control characters are still stripped.

### Restart semantics

- The Quadlet file sets `Restart=on-failure` and `RestartSec=10` in `[Service]`.
- Stopping sends SIGINT through Podman (`--stop-signal=SIGINT`). Verified on x64: SIGINT and SIGTERM both save to the loaded file and exit 0, in about 0.5 s on a small map. A Lua error exits 255 with no save; SIGKILL exits 137.
- A restart is always `systemctl restart factorio.service`, through the agent.
- **No double countdown.** Today `Services.act` (`services.ts:97-101`) schedules a countdown when players are online, and `RestartScheduler.#fire` (`restarts.ts:134-136`) clears the pending entry before it calls `fire`. A `fire` that called `Services.act` would start a second 5-minute countdown. So `Services` gains `now(id, verb, by)`, which calls the backend directly (local `systemctl --no-block` or the agent's `serviceAct`) with no countdown. For Factorio servers, `RestartScheduler`'s per-game `fire` calls `services.now(service, 'restart')`. `RestartScheduler` is built before `Services` (`start.ts:99`, `:129`), so the `fire` looks `services` up late through a closure, the way `packs?.busy` is.

Consequences:

- A `/quit` exits 0. The unit goes `inactive` with `Result=success` and stays down (S19). Discord posts "Server stopped", and the dashboard can start it again. A player probably cannot run `/quit` in game; it is run from the dashboard Console over RCON.
- A crash exits non-zero. systemd restarts the unit after 10 s. The hub posts "went down unexpectedly".

Rejected: `Restart=always` with a console stop (the GTNH pattern). It would turn `/quit` into a surprise restart.

### Remote Host

- The agent sends `hostSample { sample: HostSample }` every 60 s, in the shape at `types.ts:194-200`. It reads the VM's real `/proc/stat`, `/proc/loadavg`, `/proc/meminfo` and `statfs` on its configured mounts. The numbers cover the whole VM, including the friend's other software.
- `HostMonitor` is split. `record(sample)` holds the memory and disk warning logic. A local timer runs only for the hub's own host. There is one monitor per host id.
- `host_samples` is already keyed by `host_id`, so no migration. The host id is the agent id. Thresholds come from `agents[].host`.

### Remote Service control

- `Services` gets a backend per service: local (today's `Run`) or agent. A service is agent-backed when it is the `service` of a server that some agent serves. There is no separate `agent` key on the service.
- The agent pushes `serviceState { unit, active, sub, since, result }` on change and on connect. `read()` serves the cached state.
- `act()` keeps its countdown logic and sends `serviceAct { id, action }`. The agent runs `systemctl <verb> --no-block -- factorio.service`, like the local backend (`services.ts:95`), so a long shutdown save never exceeds the 30 s RPC timeout.
- Logs: `journal { id }` returns the tail of Factorio's own `factorio-current.log`, and of `agent.log` for the agent. The agent's user is not added to `systemd-journal`, because that would let it read every log of the friend's other software. Factorio already logs `--rcon-password <private>` in its program arguments (verified), so no redaction is needed for it.
- Agent services are left out of the hub host's polkit `UNITS`. This is an explicit exception to the "keep `UNITS` in sync" rule.

Quadlet generates an ordinary system unit called `factorio.service`. `systemctl start|stop|restart|show` works on it like on any unit, and the polkit rule matches the unit name. The agent never talks to Podman.

### Saves as Backups

- **What is listed.** Every `*.zip` in `/srv/factorio/saves`, opened with `O_NOFOLLOW` and checked with `isFile()`. Each has a kind:
  - `named`: `orrery-<UTC time>.zip`, made on request, every 6 h if anyone played since the last one, and before every update (`orrery-pre-update-<from>-<time>.zip`);
  - `auto`: Factorio's `_autosave*.zip`;
  - `world`: anything else, for example `world.zip` from setup, a `--world` import, or a `restored-*` copy. The file Factorio last loaded (from the log line `Loading map <path>: <bytes> bytes.`, verified) is marked "current world", because Factorio saves into it on every stop.
- **Retention.** The agent keeps the newest 20 `named` saves, pre-update saves included. It keeps the newest 3 `world` files, and never the one marked current. A save that a running update depends on is never pruned. Factorio rotates its own autosaves. Saves never leave the VM.
- **Making a save.** The hub's `save` message makes the agent run `/orrery-save orrery-<time>`. Verified on x64 while auto-paused with 0 players: the file is written within about 50 ms on a small map. The agent waits until the file exists and its size has been stable for 5 s, with a bounded wait of 5 minutes. Then it answers with the existing `backup { ok, detail }`, so Discord, the dashboard and the backup watchdog work unchanged. Names never start with `_autosave`.
- **The list in the hub.** The agent pushes `saves { saves: [{name, size, mtime, kind, current}], free }` after any change. The hub's per-server `backupSource { list, free }` serves it to `Stats` and `BackupWatcher`.
- **Watchdog.** For agent servers, `BackupWatcher` skips the age check when no player session has opened since the newest save (`db.sessionsSince`). Without that, any 12 h with nobody online would post `backupOverdue`.
- **Restore.** Factorio starts with `--start-server-load-latest`, which loads the newest mtime, autosaves included, at 1 s granularity (verified). To restore, the server must be stopped (the hub checks, the agent checks again). The agent opens the chosen save with `O_NOFOLLOW`, checks it, copies from the handle to `restored-<time>-<name>.zip`, and stamps its mtime at least 2 s newer than every other file in `saves/`. The next start loads it. Nothing is overwritten.
- **Labels.** The agent copies inside `/srv/factorio/saves`, so the new file inherits the folder's SELinux label and the container can read it.

### Factorio updates, Packs-like

The hub decides and the agent carries out. `GameUpdates` (new, hub core) reuses the Pack update step model, notices, `pack_updates` rows, cancel windows and the busy checks.

- `FactorioCatalog` (new) reads `api/latest-releases`, `download/sha256sums/` and `/api/mods/<name>/full`, filtered by `info_json.factorio_version`. It applies the agent's name and version checks to the portal data.
- **Dependencies.** The catalog resolves required dependencies (no prefix, and `~`) of each picked release transitively. It picks versions that meet every limit, including `base` against the target Factorio version, and honours `!` incompatibilities. Resolved mods are added to `mods[]`. Optional (`?`, `(?)`) dependencies are not added. Unresolved dependencies are shown in the Game tab, and the update cannot start until they are fixed.
- The `pack_updates` row stores from and to as text (`"2.1.24 · 5 mods"`), with the mod diff in `changes`.

Steps:

1. **prepare (agent).**
   - The hub sends `update { id, factorio: {version, url, sha256}, mods: [{name, version, sha1, url}] }`. The agent validates it (Trust rules) and checks hashes against factorio.com and the public portal API itself.
   - It downloads into `/opt/factorio/.incoming/` and `/srv/factorio/.incoming/`, never `/tmp`. Game tarballs need no credentials.
   - It checks the new binary's highest `GLIBC_2.x` need against the image's glibc, recorded at setup in `/etc/orrery-agent/image.json`. If the image is too old, prepare fails with "needs glibc 2.x; the friend must re-run setup with a newer image".
   - It extracts to `/opt/factorio/releases/<ver>/` if missing. It stages mods and `mod-list.json` in `/srv/factorio/mods.next/`, and copies `mods/mod-settings.dat` there if it exists. Factorio keeps startup and per-user mod settings in that file inside the mods folder (2.1 changelog), so dropping it would reset settings that can change prototypes.
2. **backup (agent).** It saves `orrery-pre-update-<from>-<time>`. If the server is stopped, it skips this and records the newest save.
3. **stop (hub).** The agent reports `stop: waiting`. The hub runs `Services.act(stop)` with the usual countdown. When the unit is inactive, it sends `updateResume { id }`. Until then, `updateCancel { id }` cleans up.
4. **swap (agent).** It flips `/opt/factorio/current`, moves `mods` to `mods.prev` and `mods.next` to `mods`, and starts the unit. No image change.
5. **gate (agent).** Within 5 minutes: RCON answers; `/orrery-status` reports the target version and exactly the target mod set; the game connection is up.
6. **rollback (agent), only if the gate fails.** It restores the old `current` and `mods.prev` (with its `mod-settings.dat`). Saves cannot be downgraded (S31), so it copies the pre-update save as the newest. It starts and gates again. The outcome is `rolled back` or `failed`.

Recovery and exclusions:

- The agent keeps its bookkeeping in `/srv/orrery-agent/state/update.json`, outside the container's mounts. A restart after a swap with no passed gate rolls back.
- If the hub restarts mid-update, `GameUpdates` closes its own rows as "interrupted". After the agent reconnects, it sends `updateCancel` if the update is before the swap; otherwise it records the agent's later `updateDone`. `Packs.start`'s interrupted sweep (`packs.ts:322-330`) is limited to servers that have packs, so it never closes a game update's row.
- One `updating(id?)` check, `packs?.busy(id) || gameUpdates?.busy(id)`, replaces `packing` everywhere: the Deploys deps (`deploys.ts:234`), the RestartScheduler `paused` callback (`start.ts:99`), Restores (`start.ts:135-137`) and `DeploysAnswer.packing`. So a hub deploy, a daily restart and a restore are all refused during a game update.
- Updates exclude restores, agent deploys and other updates on that server.
- The agent keeps the 3 newest releases under `/opt/factorio/releases`, plus the running one.
- Step `detail`, error text and `agent.log` never carry a query string: the agent strips everything after `?` from URLs. The hub also redacts `token=`, `secure=` and `username=` from incoming `detail` before it becomes a notice.

A first `orrery` install, and adding the friend's light mods, are just updates.

### Agent self-deploy with rollback

- The hub sends `deploy { id, tag }` over the agent connection.
- The agent checks the tag against `^agent-v\d+\.\d+\.\d+$` and starts `orrery-agent-deploy@<tag>.service` through polkit.
- The unit runs `/usr/local/lib/orrery/deploy-agent.sh` (a root-owned copy) as `factorio`. Like `deploy-hub.sh`, it takes a flock; downloads `orrery-agent-vX.Y.Z.tar.gz` (the tag `agent-vX.Y.Z` minus `agent-`) and its `.sha256` from the public GitHub release, with no token; extracts to `/srv/orrery-agent/releases/<tag>`; flips `current` and restarts `orrery-agent.service`; gates on the agent writing `/srv/orrery-agent/connected` (version and time) after `welcome`, within 60 s; otherwise rolls back and restarts; writes `deploy-status.json` and keeps 3 releases.
- The hub follows the Mod deploy pattern (`deploys.ts:411-445`). The outcome is `ok` when `agentHello` arrives with the tag as `agentVersion` in time. If it reconnects on the old version, the agent sends `deployResult { tag, outcome, log }` from `deploy-status.json`.
- A deploy is refused during an update, a restore or a countdown on the agent's server. On hub restart, a running agent deploy row is failed as "interrupted".
- The floor is `agent-v1.0.0`.
- An agent deploy never touches Factorio, the container or the Node build. Changes to units, polkit or Node need a setup re-run by the friend.

### Mod portal publishing

- The name `orrery` is free today (verified). It is claimed by the first `factorio-v*` tag.
- The portal API key lives only in GitHub Actions secrets, as `FACTORIO_API_KEY`, with the usages "ModPortal: Publish Mods" and "ModPortal: Upload Mods". After the first publish, the owner may replace it with an Upload-only key.
- A `factorio-v*` tag makes `release.yml` write the version into `info.json`; build `orrery_<ver>.zip` with `.github/factorio-zip.sh` (top folder `orrery_<ver>/`, S9); attach the zip to the GitHub release; then call `init_upload` with `mod`. If the portal answers `UnknownMod`, it calls `init_publish` with `mod` alone instead. Either way it then posts to the returned `upload_url`. For a first publish that post carries `file`, `description`, `category=utilities`, `license=default_mit` and `source_url`; for later releases only `file`. `test-release.sh` asserts this.
- The GitHub asset also lets the setup script install `orrery` without credentials.

### Credentials for mod downloads

The owner's factorio.com `username` and `token` live on the hub host, in a separate root-only file `/etc/orrery-factorio-account.env` (mode 600), read only by `orrery-hub.service`. They are not in `/etc/orrery.env`, which the deploy units also load (`orrery-deploy@.service:15`, `orrery-deploy-web@.service:15`), so `npm ci` install scripts never see them. `FactorioCatalog` requests `mods.factorio.com{download_url}?username&token` with `redirect: 'manual'`, and passes the agent only the resulting signed URL. The hub resolves links right before it sends `update`, so short-lived URLs stay fresh.

- **Conditional on S11** (passed 2026-10-31: 302 to `dl-mod.factorio.com`, query key `secure` only): the authenticated download must answer with a 302 to a CDN URL that carries no credentials.
- **Fallback if S11 fails**: the token goes in the root-only `/etc/orrery-agent.env` on the VM. The hub sends plain `download_url`s and the agent adds the credentials. The friend, as root, could read the token. The owner accepts that only if S11 fails.
- **Scope risk.** This is the game client's own token. Whether it also allows multiplayer login or hosting as the owner is S12. It matters only in the fallback.

### Account linking for Factorio players

One link per Discord user, shared across games. The Factorio name is stored next to the Minecraft one.

**Storage.** The `links` table cannot be rebuilt (`db.ts:91`: tables are only added, never altered), and `links.player` and `uuid` are `NOT NULL`. So:

- New table `factorio_links (discord_id TEXT PRIMARY KEY, name TEXT NOT NULL, linked_at INTEGER NOT NULL)`, with a unique index on `name COLLATE NOCASE`.
- An older hub after a rollback ignores the new table.

**Flow.**

1. In Discord, `/link` issues one code, as today. The reply names each game that has a server: "In Minecraft, type `/discord link CODE`. In Factorio, type `/orrery-link CODE`. Within 10 minutes."
2. In Factorio, the player types `/orrery-link CODE`. The mod sends `{t: "link", player, code}` over UDP. The name comes from the player's own index.
3. The agent checks the name is online and sends the existing `link { player, uuid: "", code }` on the game connection.
4. `Links.redeem` takes the server's game. For Factorio it writes `factorio_links`, replacing any earlier link of that Discord user or that name. The failed-attempt limit is keyed by game and lower-case name.
5. The hub answers with the existing `linkResult`. The agent turns it into `/orrery-reply`, shown to that player only.
6. **Unlink by game.** The in-game `unlink` handler (`links.ts:31`) routes by the server's game: `unlinkFactorioPlayer` for Factorio, `unlinkPlayer` for Minecraft. A Factorio player can never remove a Minecraft link of the same name. In Discord, `/unlink` removes both of the user's links.

**Lookups by Discord user.** `Stats.linkedPlayer(serverId, discordId)` picks the table by the server's game. The chat relays use it: `discord.ts:224` and `web.ts:532`. `/playtime` uses it too.

### Discord posts: research and firsts

**Research.** The mod posts every `on_research_finished` where `by_script` is false, infinite levels included ("Research finished: Mining productivity 12"). Verified on x64: lab research gives `by_script=false`; `tech.researched = true` and `research_recursive` give `by_script=true`, one event per technology. Skipping `by_script` keeps a mod's `on_init` unlocks and cheat commands from flooding the channel. Space Age trigger technologies must arrive with `by_script = false` (S26). If not, the filter becomes "skip if more than 5 research events finish in the same tick". In 2.1 the trigger is on `tech.prototype.research_trigger` (verified).

**Firsts, per force.** One post each: the first rocket launched (`on_cargo_pod_finished_ascending` with `launched_by_rocket`); the first space platform in orbit (`on_space_platform_changed_state` leaving `starter_pack_on_the_way`, S28); the first landing on each planet, naming the player (`on_cargo_pod_finished_descending` with a `player_index`, or `on_player_changed_surface`, then `player.physical_surface.planet`, S7 and S27). Kept in `storage.firsts[force][kind][planet]`. The force name is shown only when it is not `player`.

**Seeding on install.** `on_init` seeds `storage` from the current state, so adding `orrery` to an existing save posts no stale firsts: rockets from `force.rockets_launched > 0`; platforms from `next(force.platforms) ~= nil` (`force.platforms` is keyed by global platform index, so `#` is wrong); landings from Nauvis plus every planet a player's character is on.

**Formatting.** `format.ts` escapes `text`, `player` and `force` of a `milestone` with `md()` and caps `text` at 200 characters. Chat content is truncated to 2000 characters after escaping, both on the webhook (`discord.ts:177`) and in `formatEvent` (`format.ts:91`). A name is added to `refusedNames` (`discord.ts:184`) only when Discord's error is about the username, not about the content.

### Development tags before the cut

- Before the cut, each milestone is accepted by automated tests plus a local dev loop: a local hub, the agent and the `linux64` headless build on the owner's laptop. Where Podman is available there, it runs from the same Quadlet file under a test prefix.
- Platform checks (M1) run early on the VM. They need `agent-v0.x` and `factorio-v0.x` dev tags, because the setup script installs release assets. Setup runs with `--no-hub`, and the agent's `check` mode runs without a hub.
- The full smoke list runs on production after the cut, in release order. Failures are fixed forward with patch releases.

---

## Protocol additions

All additions are additive. The Mod port and the Forge mod are unchanged, so there is no `PROTOCOL_VERSION` bump. `agentHello.protocol` shares `PROTOCOL_VERSION`. They change `hub/src/protocol.ts` (`SCHEMAS`, plus `parseAgentLine`), `hub/src/types.ts`, and a new "Agent connection" section in `docs/protocol.md`. The agent imports the types with `import type` from `hub/src/types.ts`.

**Field limits** (new in `SCHEMAS`, enforced on both ports): player names 64 characters; chat and notice messages 1 KiB; `players[]` 200 entries; `output[]` 500 lines of 1 KiB; `reply.data` 256 KiB as serialised JSON; `log` and `journal` replies 1000 lines of 1 KiB; `saves[]` 500 entries; `mods[]` 500 entries; `detail` 2 KiB. Unknown fields are dropped, not copied into events.

### Agent port handshake (port 25584)

The peer address is checked before any line is read. Then:

| First line | Accepted when | Reply |
|---|---|---|
| `agentHello { protocol, agentId, token, agentVersion }` | The id is in config, the token matches, the protocol is in range. A second connection replaces the first. | `welcome` / `reject` |
| `hello { protocol, serverId, token, modVersion }` (existing) | `token` is that agent's token, `serverId` is its `server`, and its agent connection is up. `modVersion` is the `orrery` Factorio mod's version. | `welcome` / `reject` |

### Agent connection: agent to hub

| type | fields | when |
|---|---|---|
| `ping` | none | every 10 s |
| `bye` | none | before a planned exit |
| `hostSample` | `sample` (HostSample) | every 60 s |
| `serviceState` | `unit`, `active`, `sub`, `since` (number), `result` | on change and on connect |
| `saves` | `saves` (`{name, size, mtime, kind, current}[]`), `free` (number) | on change and on connect |
| `installed` | `factorio` (string), `mods` (`{name, version}[]`) | on connect and after an update |
| `updateStep` | `id`, `step` (PackStep), `state`, `detail` | during an update |
| `updateDone` | `id`, `outcome`, `from`, `to`, optional `backup` | at the end of an update |
| `deployResult` | `tag`, `outcome`, `log` | after reconnecting, from `deploy-status.json` |
| `reply` | `id`, `ok` (boolean), optional `error`, optional `data` | answer to an RPC |

### Agent connection: hub to agent

All carry an `id` and are answered by `reply` (30 s timeout unless noted).

| type | fields | effect |
|---|---|---|
| `serviceAct` | `id`, `action` (`start`/`stop`/`restart`) | `systemctl <verb> --no-block` on its own unit only |
| `journal` | `id`, `unit` | the last 200 lines of that unit's log file |
| `logs` | `id` | lists `factorio-current.log`, `factorio-previous.log`, `agent.log` |
| `log` | `id`, `name` | the last 1000 lines of a listed name; otherwise an error |
| `restore` | `id`, `name` | a listed save only, with the unit inactive |
| `update` | `id`, `factorio {version,url,sha256}`, `mods [{name,version,sha1,url}]` | starts an update after validation; `reply` means accepted |
| `updateResume` / `updateCancel` | `id` | continue after stop, or cancel before swap |
| `deploy` | `id`, `tag` | starts the deploy unit; `reply` means started |

### Game connection additions

| direction | type | fields | notes |
|---|---|---|---|
| game to hub | `heartbeat` | adds optional `paused` (boolean) | additive; `tps` is ignored while paused |
| game to hub | `milestone` | `kind` (`research`/`rocket`/`platform`/`landing`), `text`, optional `player`, optional `force` | new; stored in the Chat feed |
| game to hub | `link` | existing; `uuid` is `""` for Factorio | documented, no schema change |
| hub to game | `notice` | `message` | system broadcast (countdowns); Minecraft keeps `cmd say` |
| hub to game | `save` | none | the agent makes `orrery-<time>`, then sends `backup {ok, detail}` |

Reused unchanged: `started`, `stopping`, `chat`, `join`, `leave`, `death` (the mod sends `cause`, the killing entity's internal name, and `killer` when a player did it, as in the UDP table below; the hub composes the sentence, S30), `unlink`, `linkResult`, `cmdResult`, `backup`, `say`, `cmd`. No `cmdLate` is sent.

New lifecycle event: `lost` (hub-internal, silent; see Liveness).

### Factorio mod to agent (local UDP, not in `docs/protocol.md`)

Documented in `factorio/CLAUDE.md`. Each packet comes from `127.0.0.1:34198` and is at most 4 KiB:

```json
{"seq":1,"t":"chat","player":"…","message":"…"}
{"seq":2,"t":"join","player":"…"}
{"seq":3,"t":"leave","player":"…","reason":"quit"}
{"seq":4,"t":"death","player":"…","cause":"medium-biter","killer":"…"}
{"seq":5,"t":"milestone","kind":"landing","text":"…","player":"…","force":"player"}
{"seq":6,"t":"link","player":"…","code":"ABC234"}
{"seq":7,"t":"unlink","player":"…"}
```

---

## Config

Hub `config.json`:

```json
{
  "servers": [
    { "id": "gtnh", "name": "GT: New Horizons", "dir": "/home/opc/gtnh", "service": "gtnh" },
    {
      "id": "factorio", "name": "Factorio: Space Age", "game": "factorio",
      "service": "factorio", "dailyRestart": "06:00",
      "backupMaxAgeHours": 12, "backupMinFreeGB": 5, "lagTps": 50, "lagMinutes": 2
    }
  ],
  "integrations": {
    "minecraft": { "listenPort": 25580, "tokens": { "gtnh": "…" } },
    "systemd": [
      { "id": "gtnh", "unit": "gtnh.service" },
      { "id": "factorio", "unit": "factorio.service" }
    ],
    "agents": {
      "listen": { "host": "100.101.102.103", "port": 25584 },
      "agents": [{
        "id": "factorio-vm", "name": "Factorio VM", "token": "<at least 32 random chars>",
        "address": "100.90.80.70", "server": "factorio",
        "host": { "memoryMaxPercent": 90, "memoryMinutes": 10, "diskMinFreeGB": 5 }
      }]
    },
    "discord": { "channels": { "gtnh": "…", "factorio": "<new channel id>" } }
  }
}
```

The link between a server and its agent is written once, as `agents[].server`. The server's `service` is then agent-backed. `backupMaxAgeHours: 12` gives the 6 h save schedule one missed slot of slack; the watchdog skips the check when nobody has played since the newest save.

Validation:

- `game` defaults to `minecraft`. A Minecraft token is required only for `minecraft` servers.
- A `factorio` server has no `dir`, is exactly one agent's `server`, and has a `service`.
- `lagTps` is 1 to 20 for Minecraft and 1 to 60 for Factorio. The Factorio default is 50.
- Agent ids follow `^[a-z][a-z0-9-]{0,31}$` and must not clash with the hub host's id.
- Agent tokens are at least 32 characters and unique across all tokens.
- `address` is an IPv4 address. `listen.host` is an IPv4 address; `listen.port` must differ from the Minecraft and web ports.

Hub host secrets: `/etc/orrery-factorio-account.env` (root, 600) holds `FACTORIO_USERNAME` and `FACTORIO_TOKEN`, read only by `orrery-hub.service`.

Agent config on the VM, `/etc/orrery-agent/config.json` (root-owned, mode 644, no secrets):

```json
{
  "id": "factorio-vm",
  "hub": { "host": "100.101.102.103", "port": 25584 },
  "server": {
    "id": "factorio", "unit": "factorio.service",
    "install": "/opt/factorio", "data": "/srv/factorio",
    "rconPort": 27015, "factorioUdpPort": 34198, "agentUdpPort": 34199
  },
  "mounts": ["/"]
}
```

The save interval (6 h) and retention (20 named, 3 world files) are constants in `saves.ts`, not settings. `auto_pause` is read from `server-settings.json`.

`/etc/orrery-agent/image.json` (written by setup): `{ "image": "<name>@sha256:<digest>", "glibc": "2.39" }`.

Secrets on the VM:

- `/etc/orrery-agent.env` (root, 600): `ORRERY_AGENT_TOKEN`. In the S11 fallback only, also `FACTORIO_USERNAME` and `FACTORIO_TOKEN`.
- `/etc/orrery-factorio.env` (root, 600): `RCON_PASSWORD`. systemd reads it for both units.

---

## Changes per part

### hub/

- `src/config.ts`: `game` on `ServerEntry` and `ServerSettings` (`:8-43`); the `AgentsIntegration` type; the Minecraft token rule per game (`:298-300`); the `lagTps` limit per game (`:251`); the `dir` rules (`:256-259`); service validation that allows agent-backed services (`:326-333`).
- `src/agents.ts` (new, hub core `Agents`): the listener with bind retry; the peer-address check at accept; the capped line reader and rate limit; the handshake; the registry, `ping` silence and `bye`; typed RPCs with ids and timeouts; the events `agentLost`, `agentBack`, `serviceState`, `saves`, `installed`, `updateStep`, `updateDone`, `deployResult`; handing game connections to `ServerHub`.
- `src/servers.ts`:
  - `start()` for the hung and grace timers; `listen()` keeps the socket only (`:123-136`).
  - `attach(socket, serverId, modVersion)` for authenticated game connections, added to `#sockets`.
  - Events copy only schema fields (`:333`).
  - `game` on `ServerState`, `ServerCard` and `ServerConfig` (`:31`).
  - The intents `broadcast` and `backup`; the `/` strip only for Minecraft (`:211`).
  - The agent-lost rule, `lost`, and the 5 s settle (`:265-279`).
  - `#checkHung` (`:337-346`) suppressed only while the agent is lost.
  - `milestone` and `paused` handling.
- `src/protocol.ts`, `src/types.ts`: the new schemas with field limits, `parseAgentLine`, `milestone` on `ModMsg` and `GameMsg`, `lost` in `Lifecycle` (`types.ts:69`), `DeployPart` gains `'agent'`, the `agentLost` and `agentBack` announcements.
- `src/links.ts`: `redeem(code, game, player, uuid)`; failed attempts keyed by game and name; Factorio rows in `factorio_links`; the `unlink` handler by game (`:31`); Discord `unlinkDiscord` clears both.
- `src/db.ts`: the `factorio_links` table and its index; `linkFactorio`, `unlinkFactorioPlayer`, `factorioLinkByDiscord`, `factorioLinkByName`; `lost` mapped to `unknown` in `LIFECYCLE_STATES` (`:21-29`).
- `src/restarts.ts`: `hub.broadcast` replaces `say` (`:76`, `:128`); a per-game `fire` that calls `services.now` (`:131-141`).
- `src/services.ts`: a backend per service, local `Run` or agent (`:7`, `:91-161`); `now(id, verb, by)` with no countdown.
- `src/host.ts`: split into `record(sample)` and a local timer (`:48-141`); one monitor per host id.
- `src/stats.ts`: per-server `backupSource` and `logSource` (`:74-128`); no crash logs for agent servers; `linkedPlayer(serverId, discordId)` (`:171-172`).
- `src/backups.ts`: the watchdog armed for agent servers, skipping the age check when nobody played since the newest save (`:105-121`).
- `src/restore.ts`: a `RunRestore` per server (`:11`, `:99-114`), using the agent RPC.
- `src/game-updates.ts` (new, `GameUpdates`): owns and closes its own `pack_updates` rows; redacts query strings from `detail`.
- `src/factorio.ts` (new, `FactorioCatalog`): catalog, dependency resolution, name and version checks, link resolving with the env token.
- `src/packs.ts`: the interrupted sweep (`:322-330`) only for servers with packs.
- `src/deploys.ts`: the `agent` part in `TAG` (`:59`) and `FLOOR` (`:67`, `:238`); `agentBusy` (`:171-192`) and `answer()` with `agent: { latest, releases, hosts }` (`:195-217`); agent deploys follow `#deployMod` (`:411-445`); `mod.servers` lists Minecraft servers only (`:208`); `packing` becomes `updating` (`:234-237`); a running agent deploy is failed on hub restart (`:139-149`).
- `src/lag.ts`: the rate maximum (`:9-11`); skip and don't record while paused (`:46-60`).
- `src/format.ts`: rate bands and labels; `milestone` per kind with `md()` and a cap; chat truncated to 2000 characters (`:91`); `lost` silent (`:122-123`); agent notices; `deployed()` for agents.
- `src/live.ts`: `milestone` in `STORED` (`:6`); drop the latest TPS on `lost` (`:44`).
- `src/web.ts`:
  - Features per server (`:141-155`, `:350`, `:377`).
  - `GET /api/hosts` and `GET /api/hosts/:id/samples`, keeping `/api/host` for one release (`:326-333`).
  - The restore route created whenever any server has a restore source (`:394-406`).
  - `POST /api/deploys` accepts `agent` with a `host` (`:289`).
  - `/backup` through the intent (`:552`); chat author through `linkedPlayer(serverId, …)` (`:532`).
  - The game update routes (catalog, start, cancel, history) registered before the `/servers/:id/*` online check (`:519`), like the Pack routes.
- `src/api.ts`: `Features` gains only `console` and `update` (`:145`); the rate label and maximum come from `game` on the card; `Integrations.agents` (`:69`) and `HostNow[]` (`:85`); `DeploysAnswer.agent` (`:109-120`) and `DeployRequest.host` (`:129`); `DeploysAnswer.packing` fed by `updating` (`:119`); game update request and answer types.
- `src/discord.ts`: neutral command wording (`:54-102`); `mc-heads` avatars only for Minecraft (`:169`); chat truncation and the narrower `refusedNames` rule (`:177`, `:184`); `linkedPlayer(serverId, …)` (`:224`); `/backup start` through `hub.backup(id, by)` (`:326`); the `/link` hint per game (`:256`); `agentLost` and `agentBack` to `alertsChannel`.
- `src/start.ts`: wiring (`:80-138`, `:167-207`); `hub.start()` always; the late `services` lookup for `fire`; `updating` for every busy check.
- `src/check-config.ts`: the new rules.

### agent/ (new)

- `src/index.ts`: wiring, and the `check` subcommand for first boot.
- `src/config.ts`.
- `src/hub.ts`: both connections, reconnect with backoff, `ping`, `bye`, the `connected` file.
- `src/rcon.ts`: Source RCON client, length-prefixed reads across TCP chunks, non-zero ids, no sentinels.
- `src/events.ts`: UDP listener on `127.0.0.1:34199`; the source-port filter; the `Opening socket` log check; `seq` gaps; online-name check for `link` and `unlink`; maps to `chat`, `join`, `leave`, `death`, `milestone`, `link`, `unlink`.
- `src/status.ts`: the `/orrery-status` poll, UPS, `paused`, heartbeat.
- `src/service.ts`: `systemctl <verb> --no-block -- factorio.service` through `execFile`, no shell; the `stopping` rule.
- `src/host.ts`: HostSample from `/proc` and `statfs`.
- `src/saves.ts`: list with kinds, make, the 6 h schedule, prune, restore by copy from an `O_NOFOLLOW` handle with a fresh mtime.
- `src/logs.ts`: list and tail by name only, `O_NOFOLLOW`; strips URL query strings from its own log.
- `src/update.ts`: input validation, host allowlist, own hash checks, `.incoming/` staging, the glibc pre-check, `mod-settings.dat` carry-over, `state/update.json`, rollback.
- `src/deploy.ts`.
- `src/check.ts`: the first-boot checks that need no hub, printed as a report.
- `test/`: a fake RCON server, fake `systemctl` on `PATH`, a fake hub, UDP injection (from the right and wrong source ports), a fake ELF with `GLIBC_2.x` strings, symlinked saves, a hostile `update` message.
- `package.json` with `engines` node `>=24`, `npm test`, `npm run typecheck`.
- `CLAUDE.md`.

### factorio/ (new)

- `info.json`: `name: "orrery"`, `factorio_version: "2.1"`, `dependencies: ["base", "? space-age"]`.
- `control.lua`:
  - commands registered in the main chunk: `orrery-say`, `orrery-notice`, `orrery-status`, `orrery-save`, `orrery-reply` (console only), `orrery-link`, `orrery-unlink` (players only);
  - every handler wrapped in `pcall`;
  - rich-text neutralising in `orrery-say`;
  - `storage` set up and seeded in `on_init` and `on_configuration_changed`; nothing game-side in `on_load`;
  - handlers for `on_console_chat`, `on_player_joined_game`, `on_player_left_game`, `on_player_died`, `on_research_finished`, `on_cargo_pod_finished_ascending`, `on_cargo_pod_finished_descending`, `on_space_platform_changed_state`, `on_player_changed_surface`;
  - `storage.firsts[force][kind][planet]` and `storage.seq`.
- `locale/en/orrery.cfg`, `changelog.txt`, `CLAUDE.md`.

### web/

- `src/app/host/host.ts:123-131`: a host picker over `/api/hosts`.
- `src/app/host/release-rows.ts:23-41`: `agent:<host>` rows and `why()`.
- `src/app/host/releases.ts:91,146,152`: the `agent` part.
- `src/app/servers/server.ts:15-24`: Console on `features.console`, a Game tab on `features.update`. Backups and Logs keep their existing gates (`d.backups.configured`, `d.logs`).
- `src/app/servers/game.ts` (new): version and mod picker with unresolved dependencies, reusing the step card and history from `pack.ts`.
- `src/app/servers/overview.ts:53`, `history.ts:82`, `row.ts:28`: the rate label and maximum from `game`.
- `src/app/servers/changes.ts:4`: `lost` in `CARD_EVENTS`; the history and attention texts for `lost`.
- `src/app/servers/players.ts:27`: "Player name".
- `src/app/servers/backups.ts`: "Save" wording for Factorio, kind marks and "current world".
- `src/app/servers/chat.ts:14`: `milestone` in `CHAT_TYPES`.

### deploy/

- New: `setup-agent-host.sh` and `test-setup-agent-host.sh`; `deploy-agent.sh` and `test-deploy-agent.sh`; `factorio.container` (template); `orrery-agent.service`, `orrery-agent-deploy@.service`; `60-orrery-agent.rules`.
- `orrery-hub.service` gains `After=tailscaled.service` and `EnvironmentFile=-/etc/orrery-factorio-account.env`. Its header documents the tailnet join (`tag:orrery-hub`, `--accept-dns=false`) and the firewalld zone `tailnet` with the source-restricted rich rule.

### .github/

- `release.sh:3,8`: the parts `agent` and `factorio`.
- `changes.sh` and `test-changes.sh`: `agent` and `factorio` columns; `hub/src/types.ts` sets `agent=true`; the new deploy tests under `deploy`.
- `notes.sh`: the usage comment.
- `factorio-zip.sh` (new): refuses unless there is exactly one `info.json` with `name == "orrery"`.
- `test-release.sh`: the new parts, a first release from 0.0.0, zip naming, the portal call fields.
- `workflows/ci.yml`: `agent` and `factorio` jobs (Lua lint if luacheck is available, then the zip), and the new deploy tests.
- `workflows/release.yml`: tags `agent-v*` and `factorio-v*`; assets `orrery-agent-vX.Y.Z.tar.gz` with `.sha256`, and `orrery_<ver>.zip`; the portal step.

### docs

- `docs/protocol.md`: the Agent connection section, field limits, and the empty `uuid` for Factorio links.
- `docs/adr/0004-remote-hosts-through-an-agent.md` (new): dials out, Tailscale, token plus address, no TLS, no SSH from the hub, a shared protocol version, Podman on the remote host, the hostile-input rules.
- `docs/adr/0001`: the `agent-v*` and `factorio-v*` lines; the agent shares the Mod protocol version.
- `docs/ROADMAP.md`: a release row (spec: this local note), and the "A hub on a different machine" Later item replaced.
- Root `CLAUDE.md`:
  - parts, Verify, Releases (order hub, web, agent, Factorio mod), by-hand steps (the VM's setup re-run, the hub's firewalld zone and tailnet);
  - "Changing the wire protocol": add the agent (`agent/src/hub.ts`, types through `import type`) and, for game-connection messages, the Factorio mod's `control.lua` and its UDP table; state that `agentHello.protocol` shares `PROTOCOL_VERSION`;
  - Secrets: `/etc/orrery-factorio-account.env` (`FACTORIO_USERNAME`, `FACTORIO_TOKEN`, hub unit only) and the `FACTORIO_API_KEY` repo secret.
- `hub/CLAUDE.md`: an agent bullet under Trust boundaries; `factorio_links` in the `db.ts` row.
- `web/CLAUDE.md`.
- `CONTEXT.md`: Agent (new), Host (rewritten: other Hosts are measured by their Agent), Server (a `game`), Service (may run a container), Mod (the Factorio mod is a separate part), Save (new), Backup, Restore, Game update (new), Link, Release, Deploy, Rollback.
- After the release: the personal site (`index.html:76,93-98`, `orrery.html`).

---

## Setup on the friend's VM (Podman on OL9)

### Why a container

Verified: the 2.1.24 `linux-arm64` headless binary needs GLIBC_2.38 (`fmod`, `__isoc23_*`), 2.36 and 2.35. It links only libc, libm and libresolv. OL9 aarch64 ships glibc 2.34. There is no older ARM64 headless build (the first is 2.1.18). A container gives Factorio its own glibc without touching the VM's.

### Image

- First choice: `container-registry.oracle.com/os/oraclelinux:10-slim` (glibc 2.39; the tag and its `arm64` variant are S17).
- Fallback: `docker.io/library/debian:trixie-slim` (glibc 2.41). Same mounts, same unit.
- Setup pulls by full name, then pins the image by digest in the Quadlet file.
- No Containerfile and no image build. The image provides only glibc, a shell and basic files.
- No `AutoUpdate=`. The image changes only when the friend re-runs setup with `--refresh-image`, ideally while the server is stopped.
- Setup records the image's glibc version in `/etc/orrery-agent/image.json` (`rpm -q --qf '%{VERSION}' glibc` in the Oracle image, or `dpkg-query -W -f='${Version}' libc6` in Debian, in a one-off container).

### Rootful system Quadlet

The file is `/etc/containers/systemd/factorio.container`. Quadlet generates the system unit `factorio.service`. Rootful, because the agent then controls it with plain `systemctl` and polkit; a rootless user unit would need lingering, subuid ranges, a user journal and `systemctl --user`. Rootful does not mean root in the container: `User=` and `Group=` run Factorio as the host's `factorio` uid and gid.

**User mapping.** `User=<uid>` and `Group=<gid>` are numeric, from `id -u factorio` and `id -g factorio`. The image has no `factorio` user. There is no user namespace, so every file Factorio writes is owned by `factorio` on the host. `HOME` is `/srv/factorio` (S25).

**Bind mounts, same paths inside and outside.**

- `/opt/factorio:/opt/factorio:ro,z`: releases and the `current` symlink. Read-only, so the game cannot change the binaries the agent swaps (S6).
- `/srv/factorio:/srv/factorio:z`: config, saves, mods, script-output, logs.
- `/srv/orrery-agent` is never mounted. It holds the agent's code and state.

**SELinux: `:z`, not `:Z`.** `:Z` gives a private label per container, and Quadlet's `--rm` containers would relabel the whole tree on each start and cut off setup's one-off containers. `:z` gives the shared `container_file_t` label. Setup also adds `semanage fcontext -a -t container_file_t '/opt/factorio(/.*)?'` and the same for `/srv/factorio`, then runs `restorecon`. If the relabel on each start is slow, drop `:z` and rely on the rules (S23). The agent runs unconfined and can read and write those files. **Never stage in `/tmp`**: `mv` keeps the `tmp_t` label, which the container cannot read.

**Network.** `Network=host`. Factorio binds only unprivileged ports and needs no capabilities.

### Podman version

Quadlet key support, checked in Podman's `quadlet.go` per tag: `Group`, `ReadOnly`, `NoNewPrivileges`, `DropCapability` and `PodmanArgs` exist in 4.4.1. `Tmpfs` and `LogDriver` arrive by 4.5.1, and `Pull` in 4.6.0. `StopTimeout` first appears in 5.0.0 and `StopSignal` by 5.2.2. OL9 has shipped Podman 4.0 to 4.9.4, then 5.2 to 5.8.

So the file uses `PodmanArgs=--stop-signal=SIGINT --stop-timeout=170` instead of the `StopSignal` and `StopTimeout` keys, and setup requires **Podman 4.6 or newer**. It never upgrades Podman. On an older Podman it refuses and tells the friend to update Podman himself. The Quadlet dry run stays as a guard.

`--stop-timeout=170` is the part that matters: without it Podman's default 10 s would SIGKILL Factorio in the middle of a save on a large map. `--stop-signal=SIGINT` is optional, because SIGTERM also saves and exits 0 (verified on x64).

### The Quadlet file

Setup fills the angle-bracket values; `<arch>` is `arm64` on the VM and `x64` in the laptop test loop.

```ini
# /etc/containers/systemd/factorio.container
# Managed by orrery deploy/setup-agent-host.sh. Do not edit: re-run the script.
[Unit]
Description=Factorio server (orrery)
Wants=network-online.target
After=network-online.target

[Container]
ContainerName=factorio
Label=orrery.managed=true
Image=container-registry.oracle.com/os/oraclelinux:10-slim@sha256:<digest>
Pull=never
Network=host
User=<uid>
Group=<gid>
Environment=HOME=/srv/factorio
Volume=/opt/factorio:/opt/factorio:ro,z
Volume=/srv/factorio:/srv/factorio:z
ReadOnly=true
Tmpfs=/tmp
NoNewPrivileges=true
DropCapability=ALL
LogDriver=journald
PodmanArgs=--stop-signal=SIGINT --stop-timeout=170
Exec=/opt/factorio/current/bin/<arch>/factorio \
  --start-server-load-latest \
  --config /srv/factorio/config/config.ini \
  --server-settings /srv/factorio/config/server-settings.json \
  --server-adminlist /srv/factorio/config/server-adminlist.json \
  --mod-directory /srv/factorio/mods \
  --port 34197 \
  --rcon-bind 127.0.0.1:27015 --rcon-password ${RCON_PASSWORD} \
  --enable-lua-udp 34198

[Service]
EnvironmentFile=/etc/orrery-factorio.env
Restart=on-failure
RestartSec=10
TimeoutStartSec=300
TimeoutStopSec=200

[Install]
WantedBy=multi-user.target
```

Notes:

- **Stop timing.** Podman's stop timeout (170 s) must be lower than systemd's `TimeoutStopSec` (200 s).
- **RCON password.** systemd expands `${RCON_PASSWORD}` when it runs the generated `ExecStart`, so the password is not in the generated unit file (S21). It is in the argv of podman, conmon and factorio, and every local user can read it with `ps` (see Risks). Factorio has no option to read it from a file (`--help` lists only `--rcon-password PASSWORD`). Factorio's own log shows it as `<private>` (verified). Fallback for S21: `EnvironmentFile=` in `[Container]` and `Exec=/bin/sh -c 'exec … --rcon-password "$RCON_PASSWORD" …'`.
- **No `enable`.** Generated units cannot be enabled. The `[Install]` section makes Quadlet create the boot link.
- **Logs.** Factorio's stdout goes to the journal under `factorio.service` (S22). The agent reads `/srv/factorio/factorio-current.log`.
- **Resources.** No memory or CPU cap by default. `--memory-max <size>` adds `MemoryMax=` to `[Service]`.

### Coexisting with the friend's other software

Setup and the agent touch only: the user and group `factorio`; `/opt/factorio`, `/srv/factorio`, `/srv/orrery-agent`, `/usr/local/lib/orrery`, `/etc/orrery-agent/`, `/etc/orrery-agent.env`, `/etc/orrery-factorio.env`; `/etc/containers/systemd/factorio.container`, `/etc/systemd/system/orrery-agent.service`, `/etc/systemd/system/orrery-agent-deploy@.service`, `/etc/polkit-1/rules.d/60-orrery-agent.rules`; the SELinux file-context rules for its own folders; one image and one container named `factorio`; ports 34197/udp (public), 27015/tcp, 34198/udp and 34199/udp (loopback); one firewalld port, `34197/udp`, in the public interface's zone.

It never: runs `dnf update`, enables or switches a dnf module, or upgrades Podman; installs a system-wide Node; edits `registries.conf`, `storage.conf` or `containers.conf`; runs `podman system prune`, `reset` or anything that touches other containers, images, networks or volumes; enables, starts or reconfigures firewalld; changes SELinux booleans or modes; adds `factorio` to `systemd-journal` or any other group.

Unit, polkit, `.container` and shell files it writes start with `Managed by orrery deploy/setup-agent-host.sh`, and it refuses to overwrite one without it. JSON files are written only when missing, or when still equal to the script's own previous default (kept under `/usr/local/lib/orrery/defaults/`). `server-settings.json` also carries a `"_comment"` key naming the script.

### The friend's part before the script

1. The VM is on the tailnet as `tag:factorio`, and the tailnet policy is in place (`factorio-friend-setup.md`).
2. In the OCI console, add an ingress rule for **UDP 34197** to the VM.
3. Have the agent token ready. The owner sends it over a private channel.
4. Have the in-game admin names ready (the owner's and the friend's Factorio names).
5. Optional: mount `/proc` with `hidepid=2` so other local users cannot read process argv (see Risks).

### Running it

The friend downloads the script at a release tag and runs it:

```sh
curl -fsSLO https://raw.githubusercontent.com/Edward-Pratt/orrery/agent-vX.Y.Z/deploy/setup-agent-host.sh
sudo bash setup-agent-host.sh --agent-id factorio-vm --hub 100.101.102.103:25584 --admins Alice,Bob
```

Optional flags: `--factorio <version>`, `--image <name>`, `--refresh-image`, `--memory-max <size>`, `--world <path>`, `--no-hub` (the M1 run before the hub listens: the hub check becomes a warning and the agent starts in offline mode).

The token is read with `read -rs` from a prompt, never from argv. On a re-run, the existing token is kept unless `--new-token` is given.

The script follows `add-server.sh`: `set -euo pipefail` and `die`; `umask 077`; every argument checked against a plain character set; `put()` writes only when the content differs, so a re-run finishes a half-failed run; the marker-line rule; root-owned copies of itself and `deploy-agent.sh` in `/usr/local/lib/orrery`. Its few `dnf install` calls sit in one marked section, an explicit exception to the "no `dnf`" rule, because it targets one known OS.

### Steps

1. **Preflight.** It refuses and explains when:
   - it is not run as root;
   - `/etc/os-release` is not `ol` 9.x or 10.x;
   - `uname -m` is not `aarch64`;
   - `podman` is missing (step 2 installs it) or older than 4.6;
   - `/usr/libexec/podman/quadlet` is missing;
   - SELinux is enforcing but `container-selinux` is missing;
   - `tailscale ip -4` is empty ("join the tailnet first");
   - a TCP connect to the hub on 25584 fails ("check the tailnet policy and that the hub runs"); with `--no-hub` this is a warning;
   - any of `34197/udp`, `34198/udp`, `34199/udp`, `27015/tcp` is in use, unless held by its own container or agent;
   - a user `factorio` exists that is not a system user with home `/srv/factorio` and shell `nologin`;
   - a container named `factorio` exists without the `orrery.managed` label;
   - `factorio.service` or `orrery-agent.service` exist without the marker line;
   - the root filesystem has less than 10 GB free.
2. **Packages** (the marked `dnf` section). `dnf install -y` only what is missing, from: `podman`, `container-selinux`, `policycoreutils-python-utils`, `tar`, `xz`, `curl`.
3. **Node (private).** Download the pinned `node-v24.x.y-linux-arm64.tar.xz`, check the pinned sha256, extract to `/usr/local/lib/orrery/node-v24.x.y/`, and point `/usr/local/lib/orrery/node` at it. Label its `bin/` as `bin_t` (S16). Nothing goes on the system `PATH`.
4. **User.** `useradd --system --user-group --home-dir /srv/factorio --shell /sbin/nologin factorio`, unless it exists and passed preflight.
5. **Layout.** `/opt/factorio/{releases,.incoming}` and `current`; `/srv/factorio/{config,saves,mods,script-output,.incoming}`; `/srv/orrery-agent/{releases,state}` and `current`. All owned by `factorio`.
6. **SELinux** (only under `selinuxenabled`). The `semanage fcontext` rules, then `restorecon -R /opt/factorio /srv/factorio /srv/orrery-agent /usr/local/lib/orrery`.
7. **Image.** Pull by full name (or `--image`), read the digest, check glibc 2.38 or newer by running Factorio in it (step 8), and record glibc and digest in `/etc/orrery-agent/image.json`. With `--refresh-image`, pull again and rewrite the digest; remove the old image only if no container uses it, by its exact id.
8. **Factorio.** Read the version from `api/latest-releases` (or `--factorio`). Download `get-download/<ver>/headless/linux-arm64` into `/opt/factorio/.incoming/` and check it against `download/sha256sums/`. Extract to `/opt/factorio/releases/<ver>/` and point `current` at it. Run `podman run --rm --network=none --user <uid>:<gid> -v /opt/factorio:/opt/factorio:ro,z <image> /opt/factorio/current/bin/arm64/factorio --version`. A `GLIBC_2.38 not found` error stops the script and names the fallback image.
9. **Configuration** (in `/srv/factorio/config/`, kept on re-run unless still the script's default):
   - `config.ini`: `[path]` `read-data=/opt/factorio/current/data`, `write-data=/srv/factorio` (S6).
   - `server-settings.json`: `visibility` `{public: false, lan: false}`, no `username`, `password` or `token`, `require_user_verification: true`, `auto_pause: true`, `autosave_interval: 10`, `autosave_slots: 5`, `non_blocking_saving: false`, `allow_commands: "admins-only"`.
   - `server-adminlist.json`: the `--admins` names.
   - `/srv/factorio/mods/mod-list.json`: `base`, `space-age`, `quality`, `elevated-rails`, `recycler`, `orrery` (S29).
10. **The orrery mod.** Download the newest `factorio-v*` asset `orrery_<ver>.zip` from GitHub into `mods/`. The friend's other mods come later through a Game update.
11. **World.** If `saves/` is empty, copy `--world <path>` in, or create one in a one-off container with `--create /srv/factorio/saves/world.zip`.
12. **Agent.** Download the newest `agent-v*` tarball and its `.sha256`, extract to `/srv/orrery-agent/releases/<tag>`, point `current` at it, and write `/etc/orrery-agent/config.json`.
13. **Secrets.** Write `/etc/orrery-agent.env` (`ORRERY_AGENT_TOKEN`) and `/etc/orrery-factorio.env` (`RCON_PASSWORD`, 32 random characters) with `install -m 600 -o root`. Both are kept on a re-run.
14. **Units.** Write the Quadlet file from the template. Dry-run it: `QUADLET_UNIT_DIRS=<tmp copy> /usr/libexec/podman/quadlet -dryrun`; refuse on any error or unknown key (S18). Write `orrery-agent.service` (`User=factorio`, `ExecStart=/usr/local/lib/orrery/node/bin/node /srv/orrery-agent/current/src/index.ts`, `EnvironmentFile=/etc/orrery-agent.env /etc/orrery-factorio.env`, `After=network-online.target tailscaled.service`, `Restart=always`, `RestartSec=5`) and `orrery-agent-deploy@.service` (oneshot, `User=factorio`).
15. **Polkit.** `/etc/polkit-1/rules.d/60-orrery-agent.rules` (ES5): user `factorio` may start, stop and restart `factorio.service`; restart `orrery-agent.service`; only start `^orrery-agent-deploy@agent-v\d+\.\d+\.\d+\.service$`.
16. **firewalld.** If it is running, add `34197/udp` to the zone of the default-route interface, permanently and at runtime, without a reload (a reload drops the runtime rules of the friend's other software). If not, skip. Either way, print the OCI ingress reminder.
17. **Start.** `systemctl daemon-reload`, `systemctl start factorio.service`, `systemctl enable --now orrery-agent.service`.
18. **First-boot report.** Run `node … check` as `factorio`, print the report and save it to `/srv/factorio/first-boot.txt`. The friend sends it to the owner.

### Tests

**`deploy/test-setup-agent-host.sh`**, following `test-add-server.sh`:

- `SETUP_ROOT` prefixes `/etc`, `/opt`, `/srv` and `/usr/local`.
- Fakes on `PATH` log calls: `dnf`, `rpm`, `useradd`, `id`, `systemctl`, `firewall-cmd`, `selinuxenabled`, `semanage`, `restorecon`, `tailscale`, `uname`, `runuser`, `ss`, `podman`, the Quadlet generator, and `curl` serving local fixtures. `tar` and `sha256sum` are real.
- Cases: idempotence across two runs; a half-failed run finished by the next; symlinks cannot steer writes; both secret files mode 600 and the token in no log, argv or generated file; the Quadlet file has numeric `User`/`Group`, the label, the pinned digest, `:z` (never `:Z`), the `PodmanArgs` stop options, no `StopSignal`/`StopTimeout` keys and no password; a hand-edited JSON config is kept; `podman` never called with `prune`, `system`, `--all` or `rm` of another container; `dnf` never called with `update`, `upgrade` or `module`; no `systemctl enable factorio.service`; `--no-hub` warns instead of refusing.
- A `refuses()` table: not root, x86_64, Podman 4.5, no Quadlet, no tailnet IP, hub unreachable (without `--no-hub`), each port busy, a foreign `factorio` user, a foreign `factorio.service`, a foreign container, a bad agent id, a bad hub address, a sha mismatch, the dry run failing, the `--version` run failing with `GLIBC_2.38`.

**`deploy/test-deploy-agent.sh`** follows `test-deploy.sh`: fake `systemctl`, a fake release server, `DEPLOY_GATE_*` overrides, a fake `connected` file, rollback, pruning, the status JSON.

---

## Build plan

One release, cut at the end (M8). Each milestone lists its tasks, the acceptance checks that must pass before moving on, and its smoke test. Smoke tests marked **(VM, early)** run on the friend's VM during development. The others run on production after the cut, in release order. All of `CLAUDE.md`'s Verify commands pass at the end of every milestone.

### M0: Prerequisites (owner and friend, by hand)

- [x] Owner: the hub host joins the friend's tailnet as `tag:orrery-hub`, with `--accept-dns=false` (no `--ssh`). Done 2026-10-31: `orrery-hub`, 100.101.102.103.
- [x] Owner: firewalld zone `tailnet` with interface `tailscale0`, no open ports, and the rich rule for 25584/tcp from the VM's tailnet IP only (100.90.80.70; done 2026-10-31). Write the commands into the `deploy/orrery-hub.service` header.
- [ ] Owner: `After=tailscaled.service` in the installed hub unit.
- [ ] Owner: a factorio.com API key with "Publish Mods" and "Upload Mods", stored only as the repo secret `FACTORIO_API_KEY`.
- [ ] Owner: `/etc/orrery-factorio-account.env` with `FACTORIO_USERNAME` and `FACTORIO_TOKEN` (used from M6).
- [x] Owner: a new Discord channel for Factorio in the same guild: `#factorio`, id `1566211046257991700` (`discord.channels.factorio`).
- [ ] Friend: OCI ingress rule for UDP 34197.

Acceptance: `firewall-cmd --zone=tailnet --list-all` shows no ports and the one rich rule; `tailscale status` on the hub host shows the VM.

Smoke **(VM, early)**: S13 (port scan with the policy temporarily widened; a temporary `nc -lk <hub-ts-ip> 25584` (without `-k` ncat exits after the first probe) stands in for the listener).

### M1: Factorio running in Podman on the VM, no hub yet

- [ ] `deploy/factorio.container` (template).
- [ ] `deploy/setup-agent-host.sh`, all of the setup section, with `--no-hub`.
- [ ] `deploy/test-setup-agent-host.sh`; add it to `.github/changes.sh`, `.github/test-changes.sh` and the CI `deploy` job.
- [ ] `deploy/orrery-agent.service`, `deploy/orrery-agent-deploy@.service`, `deploy/60-orrery-agent.rules`.
- [ ] `agent/` skeleton: `package.json`, `src/config.ts`, `src/rcon.ts`, `src/check.ts`, `src/index.ts` (the `check` subcommand and an offline mode that only logs when no hub is reachable); `agent/CLAUDE.md`.
- [ ] `factorio/` skeleton: `info.json`, `control.lua` with `/orrery-status` (in `pcall`) and the UDP `seq` hello, `locale/en/orrery.cfg`, `changelog.txt`.
- [ ] `.github/factorio-zip.sh`; the `agent` and `factorio` parts in `release.sh`, `release.yml` (assets and the portal step), `ci.yml`, `test-release.sh`.
- [ ] Cut dev tags `agent-v0.1.0` and `factorio-v0.1.0` (see Still open 1).

Acceptance:

- `bash deploy/test-setup-agent-host.sh` passes, including every `refuses()` case.
- `cd agent && npm test && npm run typecheck`.
- `bash .github/test-release.sh` covers both new parts and the portal call fields.
- On the laptop: the `linux64` build in Podman from the same Quadlet file (test prefix) answers `/orrery-status` over RCON.

Smoke **(VM, early)**: the friend runs `setup-agent-host.sh --no-hub` and sends `/srv/factorio/first-boot.txt`. It covers S1–S6, S8, S16–S18, S20, S21, S25, S29 on ARM64. The friend also reports S19, S22, S23. The owner and friend join once: S10, S24. S9 from the `factorio-v0.1.0` upload.

### M2: Agent connects; status, UPS, second Host

- [ ] Hub: `src/config.ts` (game, agents), `src/check-config.ts`, `src/agents.ts` (accept-time address check, line cap, rate limit), `src/protocol.ts` (`parseAgentLine`, field limits), `src/types.ts` (`lost`), `src/servers.ts` (`start()`, `attach`, schema-only events, agent-lost rule, `paused`), `src/db.ts` (`lost`), `src/live.ts`, `src/lag.ts`, `src/host.ts` split, `src/web.ts` (`/api/hosts`), `src/api.ts`, `src/start.ts`, `src/format.ts` (rate labels, agent notices, `lost`), `src/discord.ts` (agent notices).
- [ ] Agent: `src/hub.ts`, `src/status.ts`, `src/host.ts`, `src/service.ts` (state push only).
- [ ] Web: host picker, rate labels, `lost` in `changes.ts`, history and attention.
- [ ] `docs/protocol.md`: the Agent connection section.

Acceptance:

- Hub tests: a connection from the wrong address is closed with zero bytes read, for both hello kinds; a 100 MB line and a chat flood each close the connection and the hub stays up; unknown fields never reach events; handshake (bad token, wrong server, game hello before agent hello); bind retry on `EADDRNOTAVAIL`; the three outage rules and `lost` recorded as `unknown` with no post; paused heartbeats skip lag and `tps` rows but not hung detection; a frozen agent while paused is reported hung; one `HostMonitor` per id; hung detection with `agents` but no `minecraft`.
- Existing Mod-port fixtures still parse under the new field limits.
- Agent tests against a fake hub and fake RCON: reconnect with backoff, `bye` on SIGTERM, UPS math, `paused` from player count, `tick_paused` and Δtick.
- Local loop: the laptop server shows online with UPS, and "Paused" with nobody on.

Smoke (production): the server shows online with UPS, and "Paused" with nobody on. The VM appears on the Host page. `systemctl stop orrery-agent` gives no notice and `unknown`. `kill -9` of the agent, or blocking the tailnet for 60 s, gives exactly one `agentLost`, then `agentBack`, and no "not responding". S15.

### M3: Chat, events, milestones, linking

- [ ] Factorio mod: all handlers in `pcall`; `orrery-say` with rich-text neutralising, `orrery-notice`, `orrery-reply`, `orrery-link`, `orrery-unlink`; `storage` seeding; the research filter.
- [ ] Agent: `src/events.ts` (source-port filter, `Opening socket` check, online-name check); `say`, `notice`, `linkResult` to RCON.
- [ ] Hub: `milestone` in `types.ts`, `protocol.ts`, `live.ts`, `format.ts` (with `md()` and caps); chat truncation and the `refusedNames` rule; the `broadcast` intent; `links.ts` (redeem and unlink by game), `db.ts` (`factorio_links`), `stats.ts` `linkedPlayer(serverId, …)`, `discord.ts` (`/link` hint, avatars, wording, `:224`), `web.ts:532`.
- [ ] Web: `milestone` in `chat.ts`.
- [ ] `docs/protocol.md`: empty `uuid` for Factorio links.

Acceptance:

- Hub tests: a Factorio link writes only `factorio_links`; Discord `/unlink` clears both; a link replaces the user's and the name's earlier link; failed attempts keyed per game; a Factorio `unlink` never removes a Minecraft link of the same name; chat relays name the author per game; a 3000-character message posts truncated and does not add the name to `refusedNames`; an older-hub reading test (the `links` table unchanged).
- Agent tests: packets from a wrong source port are dropped; events are dropped when the `Opening socket` line is missing; `link` for an offline name is dropped; UDP `seq` gaps logged; RCON strings escaped; `link` sent with `uuid: ""`.
- Mod: luacheck clean (if available); a test string with `[color=red]` prints literally. On the laptop: chat both ways, a death with cause, a research post, the `/orrery-link` round trip.

Smoke (production): chat both ways, from Discord and the dashboard. Join, leave and death with cause (S30). A research is posted. The first rocket, first platform and first landing on a planet post once each, and not again. Adding the mod to an existing save posts no stale firsts. A player typing `/orrery-say` does nothing. Plain console text is not echoed to Discord. A Discord message with `[color=red]x[/color]` shows literally in game. `/link` then `/orrery-link CODE` links; `/playtime` finds the Factorio name. S7, S14, S26, S27, S28.

### M4: Service control, countdowns, console, logs

- [ ] Hub: `services.ts` agent backend and `now()`; `restarts.ts` per-game `fire` and `broadcast`; the late `services` lookup in `start.ts`; `web.ts` features per server; `stats.ts` `logSource`; `servers.ts` no `/` strip for Factorio.
- [ ] Agent: `src/service.ts` (`serviceAct` with `--no-block`, the `stopping` rule), `src/logs.ts`.
- [ ] Web: Console on `features.console`.

Acceptance:

- Hub tests: `Services.act` on an agent service sends `serviceAct`; a countdown with players; a daily restart with a player online gives exactly one countdown and one `restart`, never `stop`.
- Agent tests with fake `systemctl`: only its own unit, argv `[verb, '--no-block', '--', 'factorio.service']`; `stopping` sent only for agent-started stops; a crash passing through `deactivating` is reported as a crash.

Smoke (production): Stop with a player online: one countdown in game and in Discord, then saved and stopped. Start, and Restart. The daily restart fires once. Console `/players` shows output. `kill -9` of the Factorio process gives "went down unexpectedly" and systemd restarts it. `/quit` from the dashboard Console gives "Server stopped" and it stays down (S19 end to end); try the in-game `/quit` once and record whether a player can run it.

### M5: Saves, Backups, restore

- [ ] Agent: `src/saves.ts` (list with kinds and current world, make with a bounded wait, 6 h schedule, retention, restore by handle copy with a fresh mtime).
- [ ] Hub: `save` intent and `backup` answer; `stats.ts` `backupSource`; `backups.ts` watchdog for agent servers, aware of play; `restore.ts` per server; `web.ts` restore route; `discord.ts:326` through `hub.backup`.
- [ ] Web: `backups.ts` "Save" wording, kind marks, "current world".

Acceptance:

- Agent tests: the 6 h save only after play; pruning keeps 20 named and 3 world files, never the current world or a save a running update needs; restore refuses while active, refuses a symlinked save, copies and never overwrites, and stamps the copy newest; a save that never appears times out after the bounded wait.
- Hub tests: the restore route exists with only an agent restore source; the watchdog stays quiet after 24 h with no sessions, and fires when someone played and saves are stale; Discord `/backup start` on Factorio sends `save`.

Smoke (production): Save now gives a `backup` notice. The list shows autosaves and the current world marked. Pruning works past 20. Restoring an older save loads it (S3 end to end). The watchdog fires when saves are stale after play.

### M6: Game updates

- [ ] Hub: `src/factorio.ts` (catalog, dependency resolution, validation, link resolving), `src/game-updates.ts`, `src/packs.ts` sweep limit, `updating` in every busy check, `web.ts` routes before the online check, `api.ts` types.
- [ ] Agent: `src/update.ts` (validation, host allowlist, own hash checks, `.incoming/` staging, glibc pre-check, `mod-settings.dat`, swap, gate, rollback, `state/update.json`).
- [ ] Web: `servers/game.ts`, the Game tab with unresolved dependencies.

Acceptance:

- Hub tests: catalog filtering by `factorio_version`; transitive required dependencies resolved, `base` limits honoured, `!` incompatibilities refused, unresolved ones shown; bad names and versions from the portal rejected; resolved links contain no credentials; incoming `detail` is redacted; cancel before swap; an update starts on a stopped server; a hub deploy, a daily restart and a restore are refused during a game update; "interrupted" on hub restart, and `Packs.start` leaves game update rows alone.
- Agent tests: a `version` of `../../x`, a mod name with `..`, an `http` URL and an unlisted host are each refused; a hash that differs from factorio.com's list fails prepare; a fake ELF needing a newer glibc fails at prepare; `mod-settings.dat` survives a swap and a rollback; a gate failure rolls back to the old release, `mods.prev` and the pre-update save; a restart mid-swap rolls back from `state/update.json`; a planted `/srv/factorio/update.json` is ignored; a failing download leaves no query string in step details or `agent.log`.
- Local loop: an update to the same game version with one added mod and its dependency.

Smoke (production): add the friend's light mods. Bump `orrery`; a client re-downloads it. Force a gate failure with an incompatible mod: rolled back, pre-update save loaded (S31). Cancel during the countdown. S11 settles the token location before the first update.

### M7: Agent deploys and release lines

- [ ] Hub: `deploys.ts` `agent` part, `FLOOR`, `answer()`, `agentBusy`; `web.ts:289` accepts `agent` with `host`; `api.ts`; `format.ts` `deployed()`.
- [ ] Agent: `src/deploy.ts`, the `connected` file, `deployResult`.
- [ ] `deploy/deploy-agent.sh` and `deploy/test-deploy-agent.sh`.
- [ ] Web: `release-rows.ts`, `releases.ts` for the `agent` part.

Acceptance:

- `bash deploy/test-deploy-agent.sh`: ok, rollback, pruning, status JSON, bad tags refused.
- Hub tests: `POST /api/deploys` with `agent` and a `host` is accepted; refused during update, restore or countdown; "interrupted" on hub restart; `ok` only on a matching `agentVersion`.

Smoke (production): the first agent patch release after the cut is deployed from the dashboard: `ok`, no crash alert. Rollback is proven by the automated test only.

### M8: Docs and the cut

- [ ] `CONTEXT.md`, `docs/adr/0004-…`, `docs/adr/0001`, root `CLAUDE.md` (including "Changing the wire protocol" and Secrets), `hub/CLAUDE.md`, `web/CLAUDE.md`, `docs/ROADMAP.md`.
- [x] Wait until #143 (Packs v2 smoke test) is done on the same host. Done 2026-10-31: the owner ran it, it works.
- [ ] Cut and deploy `hub-vX.Y.0` **with the old `config.json`**. Confirm the deploy is `ok`.
- [ ] Then, by hand: add `agents`, the `factorio` server and the Discord channel id to `config.json`; install `/etc/orrery-factorio-account.env` and the new `orrery-hub.service`; `systemctl daemon-reload`; restart the hub. Note: a later rollback below this release needs those config sections removed first, because the old hub rejects them.
- [ ] Cut and deploy `web-vX.Y.0`.
- [ ] Cut `agent-v1.0.0`. The friend re-runs `setup-agent-host.sh` at that tag (without `--no-hub`), which updates the units, the polkit file and the agent.
- [ ] Cut `factorio-v1.0.0`; it reaches the portal; install it on the server through a Game update.
- [ ] Run the smoke tests of M2 to M7 in that order.
- [ ] Update `docs/ROADMAP.md` (shipped), then the personal site (`index.html:76,93-98`, `orrery.html`).

Acceptance: every Verify command in `CLAUDE.md` passes on the tagged commits; every smoke check below is recorded as passed or replaced by its fallback.

---

## First-boot smoke checks (every unverified fact)

Each check names how it runs: **check** (automatic in `agent check`, setup step 18), **friend** (a short step the friend does and reports), **owner** (from the hub side), or **player** (needs a client). "Verified on x64" means `factorio-smoke-x64.md` already showed it on Factorio 2.1.24 linux64; the ARM64 run on the VM still confirms it. If a check fails, its fallback applies.

### Factorio behaviour

- **S1.** RCON answers while auto-paused with 0 players, and `/orrery-save` writes its file then. Verified on x64. check (the save must appear within 60 s). Fallback: while paused, skip the named save and record the newest existing save (the headless server saves when the last player leaves).
- **S2.** A custom command issued over RCON has a nil `player_index`. Verified on x64. check. No fallback is needed. A secret command argument must never be used: command parameters are replicated to every peer.
- **S3.** `--start-server-load-latest` loads the newest mtime, autosaves included. Verified on x64 (1 s granularity). check: stop; copy the older save as `restored-*` with a fresh mtime; start; compare the loaded file (the `Loading map` line) and the `/orrery-status` tick. Fallback: start with `--start-server <file>` through a small state file read by `ExecStartPre`.
- **S4.** `--enable-lua-udp 34198` binds `127.0.0.1:34198` and is the source port of `send_udp`; no listener means no error; payloads under 60,000 bytes arrive. Verified on x64. check: `ss -Hlnu` shows Factorio on `127.0.0.1:34198`; the log has the `Opening socket` line; a test event arrives from port 34198. Then player, for loss under load. Fallback: `write_file` tail.
- **S5.** SIGINT through Podman saves and exits 0 within 170 s; a crash exits non-zero. Verified on x64 without Podman (SIGINT and SIGTERM exit 0; Lua error 255; SIGKILL 137). check. Fallback: raise the timeouts; for exit codes see S19.
- **S6.** `read-data`/`write-data` with `--config` and `--mod-directory` puts saves, mods, logs and script-output under `/srv/factorio`, and nothing is written under `/opt/factorio`. check. Fallback: mount the release read-write.
- **S7.** `on_player_changed_surface` does not fire on remote view, or the landing check ignores it. player.
- **S8.** RCON replies of any size arrive in one packet. Verified on x64 (5 MB). check with a large mod list.
- **S26.** Space Age trigger technologies raise `on_research_finished` with `by_script = false`. player. Fallback: the same-tick burst filter.
- **S27.** A player landing raises `on_cargo_pod_finished_descending` with `player_index`, and `physical_surface.planet` is set then. player.
- **S28.** A first platform leaves `starter_pack_on_the_way` through `on_space_platform_changed_state`. player. Fallback: `on_surface_created` with `surface.platform`.
- **S29.** `mod-list.json` in the format setup writes loads Space Age, Quality, Elevated Rails, Recycler and `orrery`. check: `/orrery-status` lists them all.
- **S30.** A death cause can be named from `cause.name`, `cause.type` and `cause.player`. player. Fallback: "Alice died" with no cause.
- **S31.** A save made by a newer Factorio will not load in an older one (verified only for 2.0 to 2.1). owner, at M6's forced rollback.
- **S32.** An admin's in-game pause with players online sets `game.tick_paused`, or at least stops the tick between polls. player. Fallback: the Δtick rule alone.

### Mod portal and credentials

- **S9.** The portal zip layout (`orrery_<ver>/` top folder) and `changelog.txt` format. The first `factorio-v` upload succeeds and the portal shows the changelog, licence and category.
- **S10.** Players auto-download `orrery` from the portal on join; the server needs no Space Age licence, but every player does. player.
- **S11.** ✅ Checked 2026-10-31 by the owner: `HTTP/2 302` to **`dl-mod.factorio.com`**, whose only query key is `secure` (a signed link; no `username`, no `token`). So the token stays on the hub host and the agent's allowlist is `www.factorio.com`, `dl.factorio.com`, `dl-mod.factorio.com`. Was: The authenticated mod download answers with a 302 to a signed CDN URL with no credentials in it. owner, with `curl -sI` on the hub host. It also names the CDN host for the agent's allowlist.
- **S12.** The scope of the factorio.com service token (multiplayer login or hosting as the owner?). owner. Matters only in the S11 fallback.
- **S14.** Research and planet names read well when prettified. owner, from the first Discord posts. Fix: a small override table in the mod.

### Hub host and network

- **S13.** Tailscale's netfilter rules do not bypass the firewalld zone on `tailscale0`. friend and owner, following `factorio-friend-setup.md`: the friend temporarily saves `s13-widened.hujson` (grant `ip: ["*"]`); the owner lists every non-loopback listener on the hub host (`ss -tlnH` and `ss -ulnH`); from the VM, over IPv4 and IPv6, each of those ports must be refused, time out, or get 'No route to host' (IPv4) or 'Permission denied' (IPv6), and 25584 must answer over IPv4 only (the rich rule is IPv4-only). Then the owner runs `systemctl restart tailscaled` and the scan is repeated. Then the friend puts the policy back and runs the live tests (`live-tests.json` must return `{}`). Fallback: `tailscale up --netfilter-mode=off` on the hub host.
- **S15.** SELinux on the hub host lets the hub bind 25584 on the tailnet IP. owner, from the hub's log. Fallback: `semanage port -a -t unreserved_port_t -p tcp 25584`, or the needed type.

### The VM: Podman, Quadlet, SELinux

- **S16.** Node from `/usr/local/lib/orrery/node` starts under systemd with SELinux enforcing (no `203/EXEC`), and the nodejs.org arm64 build runs on glibc 2.34. check. Fallback: a broader `bin_t` rule.
- **S17.** `oraclelinux:10-slim` exists with an `arm64` variant and glibc 2.38 or newer; Factorio `--version` runs in it. setup step 8. Fallback: `debian:trixie-slim`.
- **S18.** The friend's Podman (4.6 or newer) accepts every key in the Quadlet file. setup step 14 dry run.
- **S19.** conmon passes Factorio's exit code to the unit. friend: `/quit` from the dashboard Console (RCON) leaves `factorio.service` `inactive` with `Result=success`, and it stays down; also try `/quit` in game once and record whether it works. Then `kill -9` of the Factorio process from the host gives `failed` and a restart after 10 s. Also look for `ExecStopPost` in the `quadlet -dryrun` output, and check that a crash is not reported as a stop. Fallback: `SuccessExitStatus=` tuning, or an `ExecStopPost=` that records the exit code for the agent.
- **S20.** `systemctl restart factorio.service` saves before the new container starts. check.
- **S21.** systemd expands `${RCON_PASSWORD}` in the Quadlet `Exec=`, and the password is not in `/run/systemd/generator/factorio.service`. check. Fallback: the `sh -c` form.
- **S22.** `journalctl -u factorio.service` shows Factorio's stdout with `LogDriver=journald`. friend.
- **S23.** No SELinux denials for the container's ports or the `:z` mounts; the `:z` relabel does not make start slow. friend. Fallback: drop `:z` and rely on the `semanage fcontext` rules.
- **S24.** Factorio in the slim image reaches `auth.factorio.com` for user verification (DNS and CA certificates). player. Fallback: bind-mount the host's CA bundle read-only, without `:z`.
- **S25.** Factorio runs as a numeric uid with no passwd entry and `HOME=/srv/factorio`. check. Fallback: bind-mount a one-line passwd file.

---

## Risks

- **A hostile peer on the Agent port.** The hub now reads input from another person's network. The accept-time address check, the source-restricted firewalld rule, the line cap, the field limits and the rate limit bound this. A bug here could still take down the whole hub, so the M2 tests include a 100 MB line and a flood.
- **Shared user, less-trusted container.** Factorio and the agent share the uid `factorio`. A compromised game process can write anything under `/srv/factorio`. The agent keeps its state outside it, takes no paths or names from it, and opens files there with `O_NOFOLLOW`. The container's `/proc` is its own, so it cannot read the agent's environment. Lua mods have no `io`. Accepted.
- **RCON password on the command line.** It is in the argv of podman, conmon and factorio, so every local user and service on the VM can read it with `ps`, not only the friend. The VM runs the friend's other software, so this is a real exposure: with RCON, a local attacker gets full admin (`/c` Lua, bans, world edits, fake `/orrery-*` replies). Factorio has no option to read the password from a file. Mitigations: RCON is loopback only; the agent treats all RCON output as untrusted; the friend can mount `/proc` with `hidepid=2`.
- **Local processes on the VM can send UDP.** Only packets from Factorio's own port 34198 are accepted, and only after Factorio is seen to have bound it. A local process running as `factorio` could still forge events; that already implies a compromise of the uid.
- **The friend controls the tailnet.** He administers the tailnet the hub host joined. The firewalld rule, the token and the peer-address check bound what that exposes.
- **The friend's VM is shared.** His other software could take one of our ports later, or fill the disk. The start fails, or the agent's UDP check or the disk notice fires; the hub shows each.
- **Image ageing.** The pinned image gets no security updates until the friend re-runs setup with `--refresh-image`. Factorio is the only process in it and runs unprivileged.
- **A future Factorio needs a newer glibc than the image.** The update pre-check refuses it at prepare. The fix is a setup re-run with a newer image.
- **Podman upgrades on the VM.** The friend's own `dnf update` may change Podman. The file uses only keys present from 4.6 on, plus `PodmanArgs`, but a change could still need a setup re-run.
- **A mod dependency the catalog gets wrong.** The gate catches it and the update rolls back; the cost is a restart and a lost countdown.
- **Release cadence.** Every `orrery` mod release makes every player update. Keep its releases rare.
- **Release order.** The release must follow #143 on the same host. A hub rollback below this release needs the new config sections removed first.

---

## Still open

1. **Dev tags before the cut.** M1 needs `agent-v0.x` and `factorio-v0.x` tags, because the setup script installs release assets. A `factorio-v0.x` tag uploads `orrery` 0.x publicly to the portal. Is that fine, or should M1 wait and use a non-portal install path?
2. **Memory cap.** Does the friend want `--memory-max` for the container, to protect his other software?
3. **Where this note lives.** It stays local for now. Commit it later (for example under `docs/`) so `docs/ROADMAP.md` can link it?
4. **Image refresh.** Only by a setup re-run (as designed), or later an agent-driven step with a countdown? That would need root, so it is not in this release.
5. ~~**The friend-setup firewall commands.**~~ Settled 2026-10-31: the hub's `tailnet` zone holds `tailscale0` with only the rich rule for the VM (100.90.80.70).
6. ~~**The friend's Podman version.**~~ Settled 2026-10-31: Podman 5.8.2 on OL 9.8 (see `factorio-friend-setup.md`, VM facts). Docker also runs on the VM; it coexists (host networking, setup never touches it).
7. Smoke checks whose fallback would change the design: S11 (token location), S19 (exit codes and the `stopping` rule), S26 (research filter), and the ARM64 reruns of S1 and S4.

---

## Appendix: Review log

Each reviewer finding, checked against the code or source it cites. 36 applied, 3 rejected.

1. **Unbounded line length and field sizes on the Agent port.** Applied: `servers.ts:239` has no line cap and `:333` spreads `msg`; added a 64 KiB line cap, field limits, schema-only events and a rate limit.
2. **Agent state in container-writable `/srv/factorio`.** Applied: bookkeeping moved to `/srv/orrery-agent/state`; no names from `/srv/factorio`; `O_NOFOLLOW`, `isFile()`, `st_dev` and handle copies for saves and mods.
3. **Hub-supplied update URLs, hashes, versions and names.** Applied: the agent validates versions and names, allowlists https hosts, and checks hashes against factorio.com and the public portal API itself; the catalog applies the same checks.
4. **Peer-address check only on `agentHello`; firewalld open to the whole tailnet.** Applied: the address is checked at accept for both hello kinds before any byte is read; a source-restricted rich rule replaces the open port.
5. **Unauthenticated loopback UDP channel.** Applied: x64 smoke showed the source port is the `--enable-lua-udp` port, so only `127.0.0.1:34198` is accepted, after the `Opening socket` log line; `link`/`unlink` only for online names.
6. **RCON password on the command line.** Applied: `--help` shows no file option; Risks now names other local users, RCON output is treated as untrusted, and `hidepid=2` is offered.
7. **S13 scans only loopback ports.** Applied: S13 now scans every non-loopback listener with the policy widened, and repeats after a `tailscaled` restart.
8. **Discord text renders as Factorio rich text.** Applied: `mcText` strips only `§` codes; the mod inserts U+200B after every `[` in `orrery-say`.
9. **In-game unlink is game-agnostic.** Applied: `links.ts:31` deletes by name from the Minecraft table; the handler now routes by the server's game.
10. **Long chat exceeds Discord's limit and disables the webhook name.** Applied: `discord.ts:177` and `format.ts:91` do not truncate and `:184` adds the name on any form error; content is truncated to 2000 characters and only username errors add a refused name; milestones get `md()` and a cap.
11. **`FACTORIO_TOKEN` in the shared `/etc/orrery.env`.** Applied: both deploy units load that file and `deploy-hub.sh:83` runs `npm ci`; the token moves to `/etc/orrery-factorio-account.env`, read only by the hub unit.
12. **Signed URLs may leak through step details.** Applied: the agent strips query strings from details, errors and its log; the hub redacts `token=`, `secure=` and `username=`.
13. **The S2 fallback secret would reach every client.** Applied: S2 is verified on x64 (nil `player_index` over RCON), so the secret-argument fallback is deleted and S2 says never to use one.
14. **Updates drop `mod-settings.dat`.** Applied: the 2.1 changelog confirms the file lives in the mods folder; prepare copies it into `mods.next`, and rollback restores it with `mods.prev`.
15. **No dependency resolution or `base` limits.** Applied: the catalog resolves required dependencies transitively, honours `base` limits and `!` incompatibilities, and shows unresolved ones before an update starts.
16. **`server_save` may not run while auto-paused.** Rejected: x64 smoke run `s1` (auto-pause on, 0 players) wrote the save in about 50 ms; S1 still rechecks it on ARM64 and the wait is bounded.
17. **Quadlet key support misdated; Podman 4.x refuses.** Applied: Podman's source confirms `StopTimeout` from 5.0 and `StopSignal` by 5.2, and that 4.4.1 also lacks `Pull`, `Tmpfs` and `LogDriver`; stop options go in `PodmanArgs` and the floor is Podman 4.6.
18. **The RCON password is probably in `factorio-current.log` and the journal.** Rejected: the x64 smoke log shows `"--rcon-password" <private>`, and a grep for the real password found 0 matches.
19. **The S3 check cannot work as written.** Applied: a restart saves into the loaded file first; S3 now stops, copies with a fresh mtime, then starts.
20. **In-game `/quit` may not be runnable by a player.** Applied: S19 and the M4 smoke use `/quit` from the dashboard Console, and try the in-game form once.
21. **Portal first-publish fields on the wrong call.** Applied: the Mod publish API (and `factorio-facts.md`) puts `description`, `category`, `license` and `source_url` on the `finish_upload` post; `init_publish` takes only `mod`.
22. **UDP addresses assumed to be IPv4 loopback.** Rejected: x64 smoke shows Factorio binds `127.0.0.1:<lua port>` and the listener received IPv4 datagrams from it; S4 still checks the bind with `ss` on ARM64.
23. **Admin pause with players online raises a false lag alert.** Applied: `tick_paused` is in `/orrery-status` and `paused` also covers a stalled tick with players online; smoke showed `tick_paused` stays false under auto-pause, so the player-count rule stays and S32 checks admin pause.
24. **The save Factorio is playing is never listed or pruned.** Applied: every `*.zip` is listed with a kind, the loaded file is marked current from the `Loading map` line, and world files have their own small retention.
25. **A per-game `fire` calling `Services.act` starts a second countdown.** Applied: `restarts.ts:134-136` and `services.ts:97-101` confirm it; `fire` calls a new `Services.now`, looked up late.
26. **The M1 VM smoke cannot run because preflight needs the hub.** Applied: `--no-hub` makes the hub check a warning for M1.
27. **The silent agent outage has no event path.** Applied: `Lifecycle` has no member for it and `recordLifecycle` drops unknown types; a new silent `lost` lifecycle is added across hub and web.
28. **Hung detection off while paused hides a hang.** Applied: `#checkHung` is suppressed only while the agent is lost; heartbeats continue while paused because RCON answers then.
29. **The backup watchdog ignores play.** Applied: `backups.ts:105-121` has no player input; agent servers skip the age check when no session opened since the newest save.
30. **Game updates miss the busy checks; `Packs.start` closes their rows.** Applied: `deploys.ts:234`, `start.ts:99` and `packs.ts:322-330` confirm it; one `updating()` check replaces `packing`, and the sweep is limited to pack servers.
31. **Minecraft-only call sites missing from the change list.** Applied: `discord.ts:224`, `:326`, `web.ts:532` and `links.ts:31` are now listed and made game-aware.
32. **`deactivating` treated as a planned stop.** Applied: `stopping` is sent only for agent-started stops; other changes wait for a final state and `Result`; S19 looks for `ExecStopPost`.
33. **The M2 smoke expects a notice from a planned stop.** Applied: M2 now expects no notice from `systemctl stop`, and one `agentLost`/`agentBack` from `kill -9` or a blocked tailnet.
34. **Hung detection and grace timers start only in `listen()`.** Applied: `servers.ts:129-131` and `start.ts:119` confirm it; the timers move to `ServerHub.start()`, and attached sockets join `#sockets`.
35. **Web routes left out.** Applied: `web.ts:289` refuses parts other than hub, web and mod, and `:519` requires the server online; both are now listed.
36. **M8 does not order the config edit and the hub deploy.** Applied: `config.ts:298-300` requires a token per server; M8 deploys with the old config first, then edits and restarts.
37. **Root `CLAUDE.md` "Changing the wire protocol" not updated.** Applied: the docs changes now add the agent and the Factorio mod to that section.
38. **Config written by hand for fixed or derivable values.** Applied: the agent link is written once, `host.mounts` leaves the hub config, save interval and retention are constants, `auto_pause` is read from `server-settings.json`, and Features adds only `console` and `update`.
39. **`serviceAct` without `--no-block`.** Applied: `services.ts:95` uses `--no-block`; the agent does the same, with a test on the argv.

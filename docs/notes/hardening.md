# Hardening pass: fix what could become an issue

Status: planned, nothing built. Date: 2026-11-06. Based on `main` at `ee75690` (production: `hub-v2.22.0` and
`web-v0.21.0` deployed; `web-v0.21.1` cut, its deploy failed; `agent-v1.4.0` cut, its deploy unchecked). File and line
references are at that commit. This note is the reference for the goal that builds it: each section says what is
wrong today, what changes, and what proves it done.

The owner asked for a refactor and, after a review, decided (2026-11-06):

- **No Bun.** Node 24 stays the runtime for the hub and the Agent (type stripping, no build step). **pnpm replaces
  npm** as the installer, in CI and on the hub's host.
- **The Agent stays Node/TypeScript.** The owner offered to supersede ADR 0004 for a compiled Agent and then decided
  the Agent is fine. ADR 0004 stands, not superseded; a compiled Agent would add a build step to CI and re-prove every
  trust boundary in `agent/CLAUDE.md` for no measured gain (the hub host has 24 GB and the Agent has no runtime deps).
- **The hub stays TypeScript, the dashboard Angular, the Mod Java.** The protocol version does not change.
- **Performance is fine.** PR CI is ~2 min wall-clock and the local loop 12 s. CI changes here are for robustness;
  the release gate (§8) and pnpm make tag-to-release faster as a side effect.
- **The Staging environment goes** (§11): the owner is doing away with it. The pack-update staging folders and the
  `failed in staging` outcome are a different thing and stay.
- **`hub.db` stays on the host.** Off-host backups are a later piece of work, after this one.
- **The Agent's Node version becomes visible** (§10): the hub notices when the friend's Host runs a Node behind its
  line, and the friend re-runs setup. Root on his Host stays his (ADR 0004). To confirm: this is the variant the
  note proposes; the owner asked for the item without picking one.

Contents: [What was measured](#what-was-measured), [1 Dependencies](#1-dependencies-and-their-updates),
[2 Test timeouts](#2-test-timeouts-and-job-limits), [3 Flaky tests](#3-flaky-tests),
[4 Types for the runtime we run](#4-types-for-the-runtime-we-run), [5 The CI map guard](#5-the-ci-map-guard),
[6 Installs wait for the release](#6-installs-wait-for-the-release), [7 pnpm](#7-pnpm),
[8 Release gate](#8-release-gate), [9 Lint](#9-lint), [10 Node on the Agent's Host](#10-node-on-the-agents-host),
[11 Remove the Staging environment](#11-remove-the-staging-environment), [12 Long files](#12-long-files),
[Build order](#build-order), [Release and deploy](#release-and-deploy), [By hand, the owner](#by-hand-the-owner),
[Docs to update](#docs-to-update), [Out of scope](#out-of-scope).

---

## What was measured

| What | Value |
|---|---|
| hub `npm test`, local / CI | 12 s / 34 s (596 tests, 44 files; `packs.test.ts` alone 11 s) |
| agent `npm test`, local | 4 s (216 tests) |
| web `npm test` + `npm run build`, local | 6 s + 3 s |
| web `npm ci` in CI | 44 s, the largest single step of any job |
| `test-setup-agent-host.sh`, local / CI | 16 s / 58 s |
| PR CI wall-clock | ~2 min; a full run is bounded by the slowest job (web 82 s, deploy 89 s, mod 92 s) |
| hub node 26 leg, one run | 908 s in `npm test`, then passed (a hang; no test timeout exists) |
| release workflow, tag to published release | 70 to 150 s (it re-runs the part's CI first) |
| hub deploy on the host | 33 s, 30 s of it the gate |
| hub host | aarch64, 4 cores, 24 GB; hub at 139 MB, 0 restarts, no warnings in 2 days |
| hub coverage | 96.7 % lines, 93.2 % branches; no file under 70 % |
| `npm audit --omit=dev` | hub 3 (hono, `@hono/node-server`, undici via discord.js), web 3 (`@angular/router`, zod, fast-uri), agent 0; all with fixes |
| strict typescript-eslint dry run, hub + agent | 0 floating promises; 5 misused-promise sites, each guarded; 3 non-exhaustive switches; 14 unused vars; 10 `async` without `await` |
| source files over 300 lines, not exempt | 36 (§12); tests over 1800 lines: `start.test.ts` 2109, `packs.test.ts` 1856 |

## 1 Dependencies and their updates

**Today:** three advisories in the hub's production deps and three in the dashboard's, each with a fix available
(hub: hono and `@hono/node-server`'s `serveStatic` double-decode, which the hub does not use, Caddy serves files;
undici DoS through discord.js. web: `@angular/router` SSR DoS, unused here; zod; fast-uri). No Dependabot or Renovate,
so advisories are found by hand. Actions are pinned by major tag (`@v4`).

**Change:**

- Update to versions without advisories. `pnpm audit --prod` (after §7) reports 0 in `hub/`, `web/` and `agent/`.
- `.github/dependabot.yml`: `npm` in `/hub`, `/web`, `/agent`; `gradle` in `/mod`; `github-actions` in `/`.
  Weekly, minor and patch grouped per part, majors as their own PRs. Ignore majors of `@types/node` (§4). Dependabot
  reads pnpm lockfiles, so this lands with or after §7.
- Pin every `uses:` in `.github/workflows/*.yml` to a 40-hex commit SHA with a `# vX.Y.Z` comment; Dependabot keeps
  them current.

**Acceptance:** audits clean; the first Dependabot run opens PRs for the three parts; every `uses:` is a SHA.

## 2 Test timeouts and job limits

**Today:** `node --test` runs with no per-test timeout, so a test waiting on a socket or timer that never fires hangs
the job until the runner's 6-hour limit (the 908 s run was that, cut short only by the test eventually completing).
No CI job has `timeout-minutes`.

**Change:** `--test-timeout=30000` in `hub/package.json`'s and `agent/package.json`'s `test` script (per test; the
longest test today is well under a second); `timeout-minutes: 15` on every job in `ci.yml` and `release.yml`. The
hub's node 26 leg stays (prod runs 24.21; 26 is the canary) but only on pushes to `main`, not on pull requests.

**Acceptance:** a test that never resolves fails in 30 s naming itself; a job that hangs fails in 15 min.

## 3 Flaky tests

**Today:** two tests fail now and then and pass on re-run: the dashboard's mod-browser "does nothing on Load more…"
and `deploy/test-deploy.sh`'s hub gate (locally the latter also needs `GIT_CONFIG_GLOBAL=/dev/null`).

**Since:** the mod-browser one was fixed on 2026-11-18 in `a2ce7d3` (its `setup()` ran change detection after the
10 ms wait, so on CI the first read sometimes had not started). The 50-run check still applies to it; the
`test-deploy.sh` gate is still open.

**Change:** reproduce each in a loop (50 runs), find the race, fix the test or the code it races (`agent/CLAUDE.md`'s
test rules apply: wait for what the code shows, never race its timers). The `test-deploy.sh` gate's fake `systemctl`
and its `DEPLOY_GATE_SECONDS`/`DEPLOY_GATE_POLL` are the first place to look. Make `test-deploy.sh` set
`GIT_CONFIG_GLOBAL=/dev/null` itself.

**Acceptance:** 50 consecutive local runs green for each, and no re-run needed in CI for the rest of this work.

## 4 Types for the runtime we run

**Today:** `hub/` and `agent/` have `@types/node ^26` with `engines.node >=24`; production runs 24.21 and the Agent's
Host 24.22. The typecheck admits an API that exists in 26 and not in 24.

**Change:** `"@types/node": "~24.x"` (the newest 24 line) in both; Dependabot ignores its majors (§1). Raise it when
`engines` does.

**Acceptance:** `pnpm run typecheck` passes in both with the 24 types.

## 5 The CI map guard

**Today:** `.github/changes.sh` decides which parts CI runs from a hand-kept list: `hub/src/api.ts` and
`hub/src/types.ts` trigger the web and agent jobs, and `protocol.ts`, `updates/factorio.ts`, `agents/agents.ts`
trigger the agent's, because those are what the dashboard's build and the agent's tests load. Its own comment says
"if api.ts or types.ts ever import another hub file, add it here": nothing checks that, so a new import there would
silently skip the web and agent jobs. (Today `api.ts` imports only `./types.ts`, `types.ts` nothing, and the
dashboard reaches the hub only through `@hub/api`, so the map is right at this commit.)

**Change:** extend `.github/test-changes.sh` with two checks against the live tree: the relative imports of
`hub/src/api.ts` and `hub/src/types.ts` are within the set `changes.sh` maps to `web=true`; and every `hub/src/…`
path imported at runtime (not `import type`) by `agent/src/*.ts` or `agent/test/*.ts` is in the set it maps to
`agent=true`. Direct imports only; transitive ones are the hub's own tests' job, as the map's comment argues.

**Acceptance:** adding `import { x } from './config.ts'` to `api.ts` fails `test-changes.sh` until `changes.sh`
lists it; the check runs in the `changes` job, which already runs `test-changes.sh`.

## 6 Installs wait for the release

**Today:** `release.yml` creates the GitHub release as a draft with `gh release create … <files>`, uploads the assets,
then publishes; for `web-v0.21.1` that took 100 s (created 19:46:05, published 19:47:47). The hub lists only
published releases (`deploys.ts`, tested in `deploys.test.ts`: drafts are refused), but a deploy started by hand on
the host (`systemctl start orrery-deploy-web@web-v0.21.1.service`, the by-hand path `docs/RELEASING.md` gives)
ran `install-web.sh`'s `gh release download` (line 28) before the release existed and failed with gh's "release
not found". Production is still on `web-v0.21.0` because of it. `deploy-agent.sh`'s curl retries transient
errors only (`--retry 2`), never a 404.

**Change:** a bounded wait in the two scripts that fetch a release asset: `install-web.sh` retries
`gh release download` every 10 s for up to 3 min while gh reports the release or asset missing, and
`deploy-agent.sh` does the same around its tarball and checksum fetch on a 404. Each logs every wait. The hub side
does not change.

**Acceptance:** `test-install-web.sh` with a fake `gh` that fails twice then succeeds installs; one that always
fails ends "failed" after the budget, with the waits in the log. `test-deploy-agent.sh` the same with its fake curl.

## 7 pnpm

**Today:** npm everywhere: `package-lock.json` in `hub/`, `web/`, `agent/`; `npm ci` in CI (web: 44 s) and in
`deploy-hub.sh` on the host (`npm ci --omit=dev`); `web/angular.json` says `"packageManager": "npm"`. The host has
neither pnpm nor corepack.

**Change:**

- `pnpm import` in each part, `pnpm-lock.yaml` committed, `"packageManager": "pnpm@<pinned 12.x>"` in the three
  `package.json`s, `web/angular.json` `cli.packageManager` `pnpm`. Scripts keep their names (`pnpm test`,
  `pnpm run typecheck`, `pnpm run build`). If the Angular build or vitest trips on pnpm's strict `node_modules`, a
  `web/.npmrc` with `node-linker=hoisted` is the fallback, and the note says so here rather than someone finding out.
- CI: `pnpm/action-setup` (reads `packageManager`), `actions/setup-node` with `cache: pnpm`,
  `pnpm install --frozen-lockfile`.
- `deploy-hub.sh`: `pnpm install --frozen-lockfile --prod` in place of `npm ci --omit=dev`, after a
  `command -v pnpm` check that fails the deploy with a clear line before cloning. `test-deploy.sh` fakes `pnpm`
  instead of `npm`. The Agent's Host is untouched: the Agent has no runtime deps and its tarball carries no
  `node_modules`; `setup-agent-host.sh` and `deploy-agent.sh` never run npm.
- **Sequencing, because `deploy-hub.sh` runs from the running release's copy** (its header says why): the first
  hub release with pnpm is deployed by the old script, which runs `npm ci` and needs `package-lock.json`. So that
  release keeps `hub/package-lock.json` in sync with `pnpm-lock.yaml` (both generated from the same
  `package.json`; CI checks `npm ci --omit=dev` still works in that release). The owner installs pnpm on the host
  (by hand, below). The next hub release deletes `package-lock.json`; its deploy runs the pnpm-era script.
- Every `npm …` command in the five `CLAUDE.md` files, `docs/RELEASING.md` and the unit headers becomes `pnpm …`.

**Acceptance:** CI green on pnpm with web's install well under 44 s; `test-deploy.sh` green with the fake pnpm; the
first hub release deploys through the old script (observed `ok` in `deploy-status.json`), the second through the
new one.

## 8 Release gate

**Today:** `release.yml` runs the whole of `ci.yml` for the tagged commit before publishing, although that commit
already passed CI on `main` (`release.sh` refuses to tag anything but an up-to-date, clean, pushed `main`). The
artifacts (`mod-jar`, `web-dist`, `agent-dist`, `factorio-zip`) come out of those CI jobs. `release.sh` checks that
HEAD equals `origin/main`, not that `main`'s CI run finished.

**Change:** `release.yml` gets a `gate` job that finds the `CI` run for `github.sha` on `main`
(`gh api …/actions/workflows/ci.yml/runs?head_sha=…&branch=main`): none, fail ("push main and let CI pass first");
running, `gh run watch --exit-status` it (up to the job's `timeout-minutes`); failed, fail. Then four build-only
jobs replace the `ci` call: web (`pnpm install --frozen-lockfile`, `pnpm run build`, upload), agent
(`agent-tarball.sh`), mod (`./gradlew assemble` and `mod-jars.sh`; spotless and tests already ran on `main`),
factorio (`factorio-zip.sh`). `ci.yml` loses `workflow_call` and its tag branch in `changes.sh` (a tag no longer
runs it); `test-changes.sh`'s tag cases go with it.

**Acceptance:** the first release after this lands in under 60 s from tag push to published release, observed; a
tag pushed on a commit whose `main` run failed produces no release. `test-release.sh` covers `release.sh`, not the
workflow, so the observation is the proof; say so when reporting.

## 9 Lint

**Today:** no linter in `hub/` or `agent/` (the dashboard has Prettier only). The dry run above found nothing that
crashes a running hub, and the class it would catch (a rejected promise nobody awaits, in a bot that runs for weeks)
is the one worth a gate.

**Change:** eslint with typescript-eslint in `hub/` and `agent/`, flat config, type-aware:
`recommendedTypeChecked` plus `no-floating-promises`, `no-misused-promises` (with `checksVoidReturn` for arguments
and attributes), `switch-exhaustiveness-check`, `no-unused-vars` (underscore-prefixed allowed). Turn off the rules
the dry run showed are noise for this code (`restrict-template-expressions`, `no-unnecessary-condition`,
`use-unknown-in-catch-callback-variable`). Fix the hits: the three switches become explicit about the message
types they ignore; unused vars go; `async` without `await` loses `async` or gains the await it meant. `pnpm lint`
in both, run in the hub and agent CI jobs after `typecheck`. The dashboard is out (angular-eslint on 15k lines is
its own piece of work; Dependabot does not fix lint).

**Acceptance:** `pnpm lint` clean in both parts and in CI; the five guarded misused-promise sites either pass the
rule's options or carry a one-line reason.

**Built (2026-11-21):** oxlint with oxlint-tsgolint instead (the owner's pick: typescript-eslint supports TypeScript
below 6.1 only, and the hub is on 7), `.oxlintrc.json` in `hub/` and `agent/`: the `correctness` category plus the
rules above. A switch with a `default:` that handles the rest counts as exhaustive (`considerDefaultExhaustiveForUnions`):
the three hits forward or name what the default takes. Off, each with its reason in the config: `require-await` (every
hit was async to fit a Promise-typed slot, or so a throw is a rejection), and `no-control-regex`, `no-base-to-string`,
`require-array-sort-compare`, `no-misused-spread`, `no-meaningless-void-operator`, `unbound-method`. The
misused-promise hits: three in `deploy-rows.ts` and the Agent's sample interval wrap the call in `() => void f()`, and the
Agent's `StartGate` start listener voids the promise it stores.

## 10 Node on the Agent's Host

**Today:** `setup-agent-host.sh` installs Node from a tarball at its pinned `NODE_VERSION` (24.22.2) under
`/usr/local/lib/orrery/node-v…` and only a re-run of setup by the friend, as root, changes it. An Agent deploy cannot
(it runs as `factorio` and writes only `/srv/orrery-agent`). Nothing tells the owner that Host's Node is behind, so
security releases of Node 24 reach it only when someone remembers.

**Change (additive, no protocol bump):**

- `agentHello` gains an optional `node` (the Agent's `process.version`, matched to `^v\d+\.\d+\.\d+$`, at most 32
  characters). The four protocol places change together (`protocol.ts`'s schema, the Agent's hello in `hub.ts`,
  `docs/protocol.md`; the Factorio mod produces no hello, so nothing there). `Agents` keeps it per Agent; the hub's
  Hosts read for the dashboard carries it; the Host card shows "Node v24.22.2" for an Agent's Host (nothing for an
  older Agent that sends none).
- `daily.ts`'s nightly run fetches `https://nodejs.org/dist/index.json` through the hub's `get` (size-capped, the
  JSON checked field by field: untrusted input), takes the newest release of each Agent's own major, and when an
  Agent's Node is behind raises the same kind of notice the portal-mod update check raises, naming the Host, its
  version, the newest, and what to do. A fetch failure keeps the last answer and is logged once.
- `docs/RELEASING.md` gains "Updating Node on an Agent's Host": bump `NODE_VERSION` in `setup-agent-host.sh`, cut an
  Agent patch (the script is fetched at the Agent's tag), ask the friend to re-run setup; setup already fetches a
  missing version and flips the `node` symlink, keeping the rest.

**Acceptance:** hub tests: a hello with and without `node`; a fake index where the Agent is behind raises the
notice, one where it is current raises none, a malformed index raises none and logs; `test/wire.test.ts` and
`test-changes.sh` still pass (`LIMITS` does not change: the field's cap lives in the schema). Agent test: the hello
carries `process.version`. The dashboard shows the version in `host.spec.ts`.

## 11 Remove the Staging environment

**Today:** a second Environment was built for `staging.orrery.run` (ROADMAP, #91): `deploy/orrery-hub-staging.service`,
`orrery-deploy-staging@.service`, `orrery-deploy-web-staging@.service`, the Caddyfile's `staging.orrery.run` site,
`orrery-hub.rules`' Staging block, `hub/config.staging.example.json`, config's `environment` field and `ENVIRONMENTS`
(`config.ts`, a label only), `GET /api/environment` and `EnvironmentInfo` (`api-public.ts`), the dashboard's
`environment.ts` (`Environment`, `StagingBadge`), the badge in `app.ts` and `login.ts`, the "orrery (staging)" tab
title, their specs, and CONTEXT.md's Environment term. On the host: the `orrery-staging` user and `/srv/orrery-staging`
remain; the units, `/var/www/orrery-staging` and `/etc/orrery-staging.env` are already gone, the host's Caddyfile never
had the site, and `orrery-hub-staging.service` is inactive. Production's `config.json` has no `environment` key.

**Not this:** the word "staging" also names a pack update's working folder (`pack-paths.ts`'s `.orrery-update`, the
older `.orrery-staging`, `game-run.ts`, `game-stop.ts`, `game-job.ts`, the Agent's `update.ts`) and the `failed in
staging` outcome (`protocol.ts`, `types.ts`, `format.ts`, the dashboard's `update-steps.ts` and specs), `backups.ts`'s
"staging files", `restore-backup.sh`'s "unpacks to staging" and `test-install-web.sh`'s "staging folders". All of that
stays.

**Change:** delete the three units, the example config, the Caddyfile site, the polkit block and the comments in
`orrery-deploy@.service` and `orrery-deploy-web@.service` that point at the staging copies; remove `environment`,
`ENVIRONMENTS` and `Environment` from `config.ts` (`validateConfig` checks the key only when present, line 206, and
the loader passes unknown keys through, line 495: a config still carrying it starts, the key unread; prod has none)
and its uses in `start-deploys.ts` and `start.ts` (`webApi`'s deps), the route and type from `api-public.ts`, `environment.ts` and every use of
`StagingBadge` and the title
effect from the dashboard, and their tests (`app.spec.ts`'s badge test goes; `app.routes.spec.ts`'s "Minecraft off"
test stays with its text reworded). `DeployTargets` and `integrations.github.deploys` stay: they are the
production targets in config, not a staging feature. Docs: the lines in the root `CLAUDE.md` (`/etc/orrery-staging.env`,
"Staging has no Agent"), `deploy/CLAUDE.md`, `docs/RELEASING.md`, CONTEXT.md (the Environment term and
"(production or staging)" under Deploy), ADR 0003 (a dated line: the staging layout was removed), ROADMAP (#91's rows
marked removed). Notes under `docs/notes/` are history and keep their wording.

**Acceptance:** `grep -rni staging --exclude-dir=node_modules --exclude-dir=archive --exclude-dir=notes .` matches
only the pack, backup and install-web meanings listed above plus ROADMAP's and the ADR's history lines; hub, web and
deploy tests green; the dashboard against a hub without `/api/environment` shows no badge and the plain title.

## 12 Long files

**Today:** `.github/check-file-length` fails only a changed file over 300 lines that *grew*, so 36 source files sit
over the cap with no `modular-exempt` reason, and two test files are over 1800 lines. CLAUDE.md's rule (touching a
long file, extract first, then change) means §6, §9, §10 and §11 each start with a split anyway.

**Change:** one behaviour-preserving pass. Split by responsibility, each new module named for it and headed by the
one-comment contract `agent/CLAUDE.md` describes; tests move with their code; a commit that only moves code is
separate from one that changes behaviour (CLAUDE.md). Contracts and parsers get `modular-exempt: <reason>` instead:
`hub/src/api.ts` (the dashboard's contract, compiled alone by `tsconfig.api.json`), `hub/src/types.ts`,
`hub/src/protocol.ts` (one parser) and `agent/src/wire.ts` (the Agent's copy of the contract). Then
`check-file-length` changes from growth-only to "any changed file over the cap without the marker", so the state
holds. Files §6, §9, §10 and §11 touch are split first, in that order, then the rest by size.

| File | Lines | Verdict |
|---|---|---|
| `hub/src/packs/packs.ts` | 1370 | split: the update job runner, the scan and manifest, the library glue |
| `agent/src/update.ts` | 1311 | split: checks and download, prepare and unpack, swap and rollback, bookkeeping |
| `agent/src/check.ts` | 971 | split: one check group per file, the report in one |
| `hub/src/stats/db.ts` | 761 | split by table group: lifecycle and sessions, feed, deploys, packs and library, maintenance |
| `hub/src/updates/game-updates.ts` | 755 | split: the job state machine, the catalog, the messages |
| `agent/src/settings.ts` | 703 | split: the fixed option table and validation, the files, the commands |
| `web/src/app/servers/pack.ts` | 689 | split by section of the page |
| `agent/src/hub.ts` | 679 | split: the two connections, the message dispatch |
| `hub/src/agents/agents.ts` | 678 | split: the listener and address check, the per-Agent state, the dispatch |
| `hub/src/api.ts` | 675 | exempt: the contract |
| `hub/src/updates/factorio.ts` | 653 | split: the catalog fetch, the version rules |
| `hub/src/updates/deploys.ts` | 651 | split: the GitHub reader, the deploy rows and watch, the release rules |
| `hub/src/web/web.ts` | 639 | split: sessions, the server, the route wiring |
| `hub/src/packs/library.ts` | 613 | split: entries, the Java runtimes, the Actions artifacts |
| `hub/src/servers/servers.ts` | 607 | split: the socket and lines, the per-server state, the public API |
| `web/src/app/servers/settings.ts` | 596 | split: the form, its rules, the apply flow |
| `agent/src/saves.ts` | 591 | split: listing and pruning, restore, uploads |
| `web/src/app/servers/game.ts` | 577 | split by section of the page |
| `agent/src/events.ts` | 552 | split: the UDP gate, the event checks, the link flow |
| `hub/src/discord/discord.ts` | 532 | split: the client and intents, commands, the bridge |
| `hub/src/discord/format.ts` | 501 | split by message family |
| `hub/src/config.ts` | 496 | split: the types, the validation, the defaults |
| `hub/src/types.ts` | 480 | exempt: the shared types |
| `hub/src/start.ts` | 402 | split: one wiring function per integration |
| `web/src/app/library/library.ts` | 399 | split by section |
| `web/src/app/servers/mod-browser.ts` | 395 | split: the search, the list, the install flow |
| `hub/src/protocol.ts` | 388 | exempt: the parser |
| `agent/src/unpack.ts` | 373 | split: the tar reader, the path rules |
| `agent/src/wire.ts` | 354 | exempt: the contract copy |
| `hub/src/servers/game-settings.ts` | 310 | split: the rules, the apply |
| `web/src/app/servers/server.spec.ts` | 929 | split by the page's sections |
| `web/src/app/servers/game.spec.ts` | 735 | same |
| `web/src/app/servers/pack.spec.ts` | 542 | same |
| `web/src/app/host/host.spec.ts` | 394 | same |
| `web/src/app/servers/mod-browser.spec.ts` | 308 | same |
| `web/src/app/servers/settings.spec.ts` | 307 | same |
| `hub/test/start.test.ts` | 2109 | split: one file per integration it starts |
| `hub/test/packs/packs.test.ts` | 1856 | split along `packs.ts`'s new modules |
| other `hub/test` and `agent/test` files over 300 | 13 | split along their module's split, or exempt with a reason when one scenario needs them together |

The verdicts are a starting point: the builder reads the file's header comment and splits along its stated
responsibilities; a different cut that reads better is fine. The exemptions are not.

**Acceptance:** `bash .github/check-file-length main` passes in its new mode on every branch of this work; a
move-only commit leaves every suite's test count where it was (596 hub, 216 agent, 302 web at this commit; §10 adds
tests and §11 removes some, in their own commits); no public API of `ServerHub`, `Stats`, `Agents`, `Deploys` or
the web routes changes.

**Built (2026-11-21):** as six PRs instead of one, part by part: #196 and #197 (hub source), #198 (the Agent), #199
(the dashboard: its inline templates cut into section child components with `display: contents` hosts, specs
untouched), #200 (hub tests), then the markers and the mode change. Every file a split touched ended at 300 lines or
less. Besides the four exemptions above, the owner exempted four files outside the table: `deploy/setup-agent-host.sh`
(fetched and run as one file), its test, `factorio/control.lua` (a split means a portal release for nothing) and
`web/libs/ui/utils/src/lib/hlm.ts` (spartan/ui generated). `check-file-length` now fails any changed file over the cap
without a marker, a shrunk one too, and `.github/test-check-file-length.sh` tests it (run first in its CI job).

## Build order

Each step is a branch and a PR, green on its own, in this order:

1. §2 timeouts and job limits, §4 the types pin (tiny; protects everything after).
2. §7 pnpm, with `package-lock.json` kept for the hub, and §1's dependency updates, Dependabot and SHA pins in the
   same PR (Dependabot needs the pnpm lockfile).
3. §8 the release gate and build-only release jobs.
4. §3 the two flakes.
5. §12 splits of the files §6, §9, §10, §11 touch (`install-web.sh` and `deploy-agent.sh` are shell, no split;
   `agents.ts`, agent `hub.ts`, `config.ts`, `deploys.ts`, `start.ts`, `web.ts`), then §9 lint and §5 the map guard.
6. §11 the Staging environment removal (hub, dashboard, deploy, docs).
7. §10 the Node version notice (protocol places, hub, Agent, dashboard, RELEASING.md).
8. §12 the rest of the splits by size, and the `check-file-length` mode change last.

## Release and deploy

Hub, dashboard and Agent release, in that order each time; the Mod and the Factorio mod do not.

1. **Hub release A** after step 3: pnpm scripts and lockfile, both lockfiles present, timeouts, dependency updates,
   the release gate. Deployed by the running release's `npm ci` script. The owner then installs pnpm on the host.
2. **Hub release B** after step 8: `package-lock.json` deleted, lint, staging gone, the Node notice, the splits.
   Deployed by release A's pnpm script. Then the dashboard (`/api/environment` is gone from the hub first; the old
   dashboard treats its 404 as Production), then the Agent (its hello carries `node`; an older Agent keeps working).
3. The first tag after step 3 proves §8 by observation; say so in its report.

## By hand, the owner

None of these is run by the goal. Deleting is irreversible; the host's user and folder are the only Staging remnants.

- Redeploy the dashboard now: `sudo systemctl start orrery-deploy-web@web-v0.21.1.service` on the host (the release
  is published), or the dashboard's deploy.
- Before hub release B: `sudo npm install -g pnpm@<the pinned version>` on the host, so `command -v pnpm` finds it
  as `opc`; `pnpm --version` checked.
- After §11 ships: `sudo userdel -r orrery-staging` and `sudo rm -rf /srv/orrery-staging`; copy the new
  `orrery-hub.rules` over `/etc/polkit-1/rules.d/`; delete the `staging.orrery.run` record in Cloudflare if one
  exists; delete the Staging Discord application if #91 made one.
- Check the `agent-v1.4.0` deploy on the friend's Host (its `deployResult` in the dashboard's deploy history).

## Docs to update

Root `CLAUDE.md` (commands to pnpm, the two Staging lines, the verify list's new lint and the mode of
`check-file-length`), `hub/CLAUDE.md`, `web/CLAUDE.md`, `agent/CLAUDE.md` (commands; the agent's hello),
`deploy/CLAUDE.md` (Staging out, pnpm on the host, the install waits), `docs/RELEASING.md` (the gate, pnpm, Node on
an Agent's Host, by-hand deploys wait for the release), `docs/protocol.md` (`agentHello.node`), CONTEXT.md
(Environment term out), ADR 0003 (dated line), ADR 0004 (a dated line: reconsidered 2026-11-06, kept), ROADMAP (this
note's row; #91 marked removed; mark shipped as releases cut).

## Out of scope

Bun; a compiled Agent; `hub.db` off the host (next piece of work); lint for the dashboard; major bumps Dependabot
will propose (ng-icons 36, TypeScript 7 in the dashboard, jsdom 31); a `PROTOCOL_VERSION` bump; the 30 s deploy
gate; Node updating itself on the friend's Host; the Android app (`docs/notes/android-app.md`), which waits for this.

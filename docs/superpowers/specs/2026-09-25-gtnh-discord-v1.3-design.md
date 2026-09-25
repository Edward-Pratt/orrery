# GTNH Discord v1.3 — Design

Date: 2026-09-25 · Status: approved in chat (grilling session), pending spec review
Builds on: the v1–v1.2b specs in this folder. Decisions: `docs/adr/0001-monorepo-independent-versions.md`.
Terms: `CONTEXT.md` (Hub, Server, Mod, Protocol version, Backup, Restore, Pre-restore world).

## Goal

Operations: make the project releasable and the server recoverable.

1. **Versions and releases:** the hub and the mod are versioned and released independently, from git tags.
2. **CI:** hub tests on Node 24 and 26; mod build with JUnit; the restore script's test.
3. **Restore:** `deploy/restore-backup.sh` puts a backup back in place of a stopped server's world.
4. **Backup disk space:** a free-space warning, plus size and growth in `/backup status` and the daily summary.
5. **`hub.db` upkeep:** prune old TPS samples; a nightly copy of the database.
6. **Liveness ping:** an external check that alerts when the hub (or the whole host) goes silent.
7. **`npm run check-config`:** validate `config.json` offline, with the same rules as startup.

**Out of scope:** a restore button or any restore from Discord (v2), and everything from v2 on in
`docs/ROADMAP.md`.

## Versions and releases (ADR-0001)

- Tags: `hub-vX.Y.Z` and `mod-vX.Y.Z`. A mod for another Minecraft version later gets its own prefix.
- Past releases are tagged with both prefixes on their merge commits: `1.0.0` → `17fc0e1`, `1.1.0` → `07823d6`,
  `1.2.0` → `6bdce14` (v1.2a + v1.2b). Tags only, no GitHub releases for these.
- **Mod version:** GTNH's gradle plugin takes the nearest tag of *any* prefix, so a hub tag could leak into the
  mod's version. Instead the mod's version comes from `git describe --tags --match 'mod-v*' --dirty` with
  `mod-v` stripped: `1.3.0` on the tag, `1.3.0-2-g<hash>` after it, `-dirty` for uncommitted changes, and
  `0.0.0-<hash>` if no mod tag exists. Mechanism: `gtnh.modules.gitVersion = false` in `gradle.properties` and
  `project.ext.modVersion` set in `build.gradle.kts` (the plugin's documented escape hatch). The planning step
  must confirm the plugin reads `modVersion` late enough; if it doesn't, fall back to setting the `VERSION`
  environment variable from the tag in the release workflow. This version is also the hello's `modVersion`.
- **Hub version:** the tag only. The hub is deployed with `git checkout hub-vX.Y.Z` on the server; nothing
  in the hub reads its own version.

### Protocol version range

`servers.ts` accepts `MIN_PROTOCOL <= hello.protocol <= PROTOCOL_VERSION` (both `1` for now), and rejects
otherwise with `protocol <n> not supported (hub speaks <MIN>–<MAX>)`. Policy, stated in `protocol.ts` and the
spec's Protocol section: the hub supports the current and the previous protocol version, so servers can update
their mods one at a time. How the hub avoids sending newer messages to an older mod is designed with protocol
2; v1.3 only changes the check.

## CI and releases (`.github/workflows/`)

- **`ci.yml`**, on push to `main`, pull requests and `workflow_call`:
  - `hub`: matrix Node 24 and 26; `npm ci`, `npm test`, `npm run typecheck`.
  - `mod`: JDK 25 (Temurin, matching `mod/.java-version`); `./gradlew spotlessCheck build` (runs JUnit).
    Checkout with `fetch-depth: 0` so `git describe` sees tags.
  - `deploy`: `bash deploy/test-restore-backup.sh`.
  The `mod` job uploads `mod/build/libs/gtnhdiscord-<version>.jar` (not `-dev` or `-sources`) with
  `actions/upload-artifact`, so a calling workflow can use it.
- **`release.yml`**, on push of tags `hub-v*` and `mod-v*`, with `permissions: contents: write` (the default
  token can't create releases): calls `ci.yml`, and only if it passes creates the GitHub release with
  `gh release create <tag> --notes-file notes.md`. The notes are `git log --oneline <previous tag with the
  same prefix>..<tag> -- hub/` (or `-- mod/`), so they cover only that part's history. (`--generate-notes`
  can't filter by path, and this repo mostly merges locally, not through PRs.) Checkout with
  `fetch-depth: 0`.
  - `mod-v*`: downloads the jar artifact from the `ci.yml` run and attaches it.
  - `hub-v*`: notes only, nothing attached.

## Restore (`deploy/restore-backup.sh`)

Run as `opc` on the server. Settings from the environment with defaults: `GTNH_DIR=/home/opc/GTNH`,
`BACKUP_DIR=$GTNH_DIR/backups`, `GTNH_SERVICE=gtnh`.

```
deploy/restore-backup.sh             # list backups (newest first, with sizes) and existing pre-restore worlds
deploy/restore-backup.sh latest      # restore the newest backup
deploy/restore-backup.sh <name>.zip  # restore that backup
```

In order, stopping at the first failure with a clear message and nothing changed:

1. Refuse to run as root (root-owned world files would break a server running as `opc`).
2. Resolve the backup: `latest` is the newest name matching the backup pattern (names are timestamps);
   otherwise the name must match the pattern and exist in `BACKUP_DIR`. Refuse paths.
3. Refuse unless `systemctl show -p ActiveState --value $GTNH_SERVICE` is `inactive` or `failed`
   (`Restart=always` means only `systemctl stop` keeps it down).
4. World folder name: `level-name` from `$GTNH_DIR/server.properties`, default `World`.
5. Require `unzip`.
6. Free space: the zip's uncompressed total (`unzip -Zt`) plus 10 % must fit in `df` free space for
   `GTNH_DIR`. Moving the current world aside costs nothing (same filesystem).
7. Show the plan (backup name and age, world folder, pre-restore folder name) and ask `y/N`.
8. Unpack into a staging folder `$GTNH_DIR/.restore-<time>` (same filesystem, so the swap is a rename).
   Find `level.dat`: at the staging root, or in exactly one subfolder. Otherwise delete staging and fail.
9. Check the service state again, as in step 3: the prompt and the unzip can take minutes, and someone may
   have started the server meanwhile. If it's no longer stopped, delete staging and fail.
10. Swap: rename the world to `<world>.pre-restore-<time>`, then the unpacked world to `<world>`. If the second
   rename fails, rename the first back. Remove what's left of staging.
11. Print the next step (`sudo systemctl start gtnh`) and every pre-restore world with its size. Pre-restore
    worlds are never deleted automatically.

`<time>` is `date +%Y-%m-%d-%H-%M-%S`, the same style as backup names.

**Test** (`deploy/test-restore-backup.sh`, no root, runs in CI): a temp `GTNH_DIR` with a fake world and two
zips (one with `World/` at the root, one with `level.dat` at the root), and a `systemctl` stub on `PATH`
returning the state under test. Checks: refuses when `active`/`activating`; refuses when the stub says `inactive` on the first check
and `active` on the second (world untouched, staging gone); refuses unknown names and paths;
restores both zip layouts; the old world ends up as `World.pre-restore-*` untouched; a corrupt zip leaves the
world untouched. Answers the prompt by piping `y`.

## Backup disk space (`backups.ts`, `format.ts`, `summary.ts`)

| Key (per server) | Meaning | Default |
|---|---|---|
| `backupMinFreeGB` | warn when free space on the backup folder's filesystem drops below this | `10` |

- **Warning:** `BackupWatcher`'s existing 10-minute check also reads free space with `statfs` (`node:fs`) on
  the backup folder: `bavail * bsize`. Below the limit it notifies `⚠️ Low disk space for backups: <free> free
  (limit <n> GB)` once, and re-arms once free space is back above the limit. It runs only where the watchdog
  already runs (a backup folder is known); `backupMinFreeGB` also turns it on without `backupMaxAgeHours`.
- **Growth:** newest backup size minus the oldest backup's size, divided by the days between them:
  `+<size>/day` (or `−`). Omitted if the oldest backup is less than 1 day older than the newest. (Uses the
  oldest backup rather than a fixed window, because ServerUtilities' retention on the server decides how far
  back backups go.)
- **`/backup status`** gains fields *Free disk* and *Growth*.
- **Daily summary** gains one line: `Backups: <count>, <total>, <free> free`, plus growth when known. Only for
  servers with a backup folder.

## `hub.db` upkeep (`db.ts`)

Nightly at a fixed 04:00 local (a constant, via `everyDay`), `Db.maintain(now)`:

1. `DELETE FROM tps WHERE ts < now − 90 days`. Other tables are kept forever: `sessions` and `events` feed
   all-time playtime, `/top` and uptime, and every table but `tps` stays small.
2. `VACUUM INTO '<dbPath dir>/db-backups/hub-<YYYY-MM-DD>.db'` (local day), after removing a file of that name
   if one exists. Creates the folder if needed.
3. Keep the 7 newest `hub-*.db` in that folder; delete the rest.

The copies hold the `links` table (Discord IDs ↔ player UUIDs), and with the default `dbPath` the folder is
`hub/db-backups/` inside the git checkout, which `hub/*.db*` in `.gitignore` doesn't cover. `.gitignore` gains
`hub/db-backups/`.

Like every `Db` write, a failure is logged and never throws.

## Liveness ping

| Key (top level) | Meaning | Default |
|---|---|---|
| `healthcheckUrl` | URL to GET every 60 s (e.g. healthchecks.io) | no ping |

Every 60 s, if Discord is connected, `fetch(healthcheckUrl, { signal: AbortSignal.timeout(10_000) })`;
errors are logged, never thrown. Not pinging while Discord is disconnected is deliberate: a hub that can't
post is as silent as a dead one. The pinger lives in `index.ts` wiring and takes an `isReady: () => boolean`
from `startDiscord`, so hub core still doesn't import `discord.js`. "Connected" means every gateway shard's
status is `Ready` (`client.ws.shards`), not `client.isReady()`: in discord.js 14 that only checks the
manager's status, which is set to `Ready` once and stays there through disconnects and reconnects. There is no per-server ping: the hub
already reports game-server outages.

## `check-config` (`config.ts`, `check-config.ts`)

- `config.ts`: the `Config` type (moved from `index.ts`) and `validateConfig(raw: unknown): string[]` that
  returns **every** error, each prefixed with its location (`server "gtnh": …`). `loadConfig(path)` reads,
  parses and validates, and throws one error listing them all. `index.ts` uses `loadConfig`; the checks now in
  `index.ts` and `restarts.ts` move here.
- Checks: valid JSON; required fields present with the right types (`listenPort`, `dbPath`, `guildId`,
  `adminRoleId`, `servers[]` with `id`, `name`, `token`, `channelId`); Discord IDs are 17–20 digits; server
  `id`s unique; tokens ≥ 16 characters and unique; `dailyRestart`/`dailySummary` are `HH:MM`; `quests` in
  `QUEST_MODES`; `lagTps` 1–20; `lagMinutes` an integer ≥ 1; `backupMaxAgeHours`, `backupMinFreeGB` > 0;
  `healthcheckUrl` an `http(s)` URL; `dir`, and `backupDir` if set, are existing directories.
- `npm run check-config [path]` → `node src/check-config.ts`: prints `config.json OK` or the errors, exit code
  0/1. Needs no `DISCORD_TOKEN` and makes no network calls.
- Startup now also fails on a missing `dir`. The default `<dir>/backups` is not required to exist.

## Docs

- `docs/ROADMAP.md`: v1.3 row wording (prune TPS samples, not events/sessions; free-space warning; per-part
  releases; protocol range); move v1.3 to done when it ships.
- `hub/CLAUDE.md`: modules table (`config.ts`, `check-config.ts`); `mod/CLAUDE.md`: versioning from `mod-v*`.
- Root `CLAUDE.md`: releases section (tag formats, what each release contains); "Changing the wire
  protocol" gains `MIN_PROTOCOL` and the support-current-and-previous policy.
- `.gitignore`: `hub/db-backups/`.
- `deploy/`: a header comment in `restore-backup.sh` like the unit files'.

## Testing

- Hub (`node:test`): `validateConfig` (each rule, and that all errors are reported together); protocol range
  (accepts 1, rejects 0 and 2 with the new message) via the fake mod in `servers.test.ts`; `Db.maintain`
  (prunes only old `tps`, writes a copy, keeps 7) on a temp directory; growth calculation and free-space
  warn/re-arm with injected `list` and `statfs`; the summary's backup line.
- Mod: the build proves versioning; tag a throwaway commit locally to check the jar name, then delete the tag.
- Restore: `deploy/test-restore-backup.sh` (above).

**Manual smoke test on the server** (can't be checked elsewhere):
1. `npm run check-config` against the real `config.json`.
2. Restore: `systemctl stop gtnh`, run the script with no argument, then `latest`; start the server, join,
   confirm the world is the backup's; check `sudo ausearch -m AVC -ts recent` shows no new SELinux denials.
3. Healthcheck: the check goes green; stop `gtnh-hub` and confirm it alerts.
4. After 04:00: a `db-backups/hub-<day>.db` exists and opens.
5. First real release: push `mod-v1.3.0` and `hub-v1.3.0`; the mod release has `gtnhdiscord-1.3.0.jar`.

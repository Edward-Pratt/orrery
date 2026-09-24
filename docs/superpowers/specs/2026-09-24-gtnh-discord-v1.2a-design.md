# GTNH Discord v1.2a — Design

Date: 2026-09-24 · Status: approved in chat, pending spec review
Builds on: the v1 and v1.1 specs in this folder. Everything there still holds unless changed here.
Roadmap context: `docs/ROADMAP.md` (v1.2 is split into v1.2a, this spec, and v1.2b).

## Goal

1. Nicer-looking bot output: embeds for everything except chat.
2. Player stats: playtime, last seen, top players, daily peak, and a daily summary post.
3. Backups from Discord: start one, see when it finishes, list backups with count and total size, and
   get warned when scheduled backups stop appearing.
4. `/cmd` works with commands that reply asynchronously, such as spark (today: "(no output)").
5. Fix the v1.1 deferred minors, and the v1 mod minor.

**Constraint:** no protocol change (still v1), so the hub and mod can be updated independently. This
release does ship a new mod jar (items 4 and 5).

**Out of scope:** everything listed for v1.2b and later in `docs/ROADMAP.md`, including backup restore.

## Config

New optional fields per entry in `servers[]` (`config.example.json` shows them):

| Field | Meaning | Absent → |
|---|---|---|
| `dailySummary` | `HH:MM`, 24-hour, hub host's local time: when to post yesterday's summary | no summary |
| `backupDir` | ServerUtilities' backup folder | `<dir>/backups`; no backup features if `dir` is also absent |
| `backupMaxAgeHours` | alert if the newest backup is older than this | no watchdog |

As with `dailyRestart`, an invalid `dailySummary` fails startup with a clear error.

## Embeds

Plain text stays plain text for chat, join, leave, death and achievement: those are conversation, and
embeds would make the channel noisy. Everything else posts as an embed (`APIEmbed` objects built in
`format.ts`):

| Message | Colour | Content |
|---|---|---|
| Server started / responding again | green `0x2ecc71` | title only |
| Server stopped | grey `0x95a5a6` | title only |
| Went down unexpectedly | red `0xe74c3c` | title, plus a line saying crash logs are attached (the files ride on the same message) |
| Not responding | orange `0xe67e22` | title only |
| Restart scheduled / cancelled / restarting / failed | blue `0x3498db` (failed: red) | title + "by …" |
| Backup finished / missing / overdue | green / orange / orange | name, size, duration or age |
| `/status` | by state | title = server name + state; fields TPS, Players, Uptime 24 h, Uptime 7 d |
| `/list` | blue | player names (or "Nobody online") |
| `/playtime`, `/top`, `/backup status`, `/backup list`, daily summary | blue | see below |

`formatEvent(e)` now returns `{ content } | { embeds: [APIEmbed] } | null`. Posting sends whichever it
gets. Webhook chat is unchanged.

## Player stats

### Tracking (`playtime.ts`, hub core)

`PlaytimeTracker(hub, db)` polls `hub.list()` every 10 s. That's the source of truth, and it also covers
hub restarts and missed join/leave events:

- For each server, `online players − open sessions` → `db.openSession(serverId, player, now)`, and
  `open sessions − online players` → `db.closeSession(…, now)`.
- A server that isn't online closes all its open sessions.
- At hub start, `db.closeDanglingSessions(lastAlive)` ends every session left open, at the hub's last
  `last_alive` stamp (or now, if there is none).
- Daily peak: `db.recordPeak(serverId, localDay, count)` keeps the maximum per `YYYY-MM-DD` (local
  time), updated on every poll.

Accuracy is ±10 s, which is fine for playtime.

### Storage (`db.ts`)

```sql
CREATE TABLE IF NOT EXISTS sessions (server_id TEXT NOT NULL, player TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER);
CREATE INDEX IF NOT EXISTS sessions_server_player ON sessions (server_id, player);
CREATE TABLE IF NOT EXISTS peaks (server_id TEXT NOT NULL, day TEXT NOT NULL, peak INTEGER NOT NULL, PRIMARY KEY (server_id, day));
```

Queries count only the overlap with the requested window, and treat a session with no end as ending now.
Player names are matched case-insensitively. Like `record`, every write logs errors instead of throwing.

- `playtime(serverId, player, from, to) → ms`
- `lastSeen(serverId, player) → ms | null`: `null` = never seen; `Infinity` = online now
- `top(serverId, from, to, limit) → [{ player, ms }]`
- `unique(serverId, from, to) → number`
- `peak(serverId, day) → number | null`
- `countEvents(serverId, reason, from, to) → number`, for restarts and crashes

### Commands

- `/playtime player:<name>`: total, last 7 days, last seen (`online now` / `3 h ago` / `never`).
- `/top period:<day|week|all>` (default `week`): top 10 by playtime in the period.

### Daily summary (`summary.ts`, hub core; posting in `discord.ts`)

At `dailySummary` local time, post an embed for **yesterday** (local midnight to midnight) with:

- uptime %
- peak players
- unique players
- total playtime
- top 3 players
- number of starts (`started` events) and crashes (`crashed` events)

`buildSummary(db, serverId, dayStart, dayEnd)` returns a plain object, and `format.ts` turns it into the
embed.

## Backups (`backups.ts`, hub core)

ServerUtilities names backups `YYYY-MM-DD-HH-MM-SS…` in its backup folder, and uses `.su-save-*.tmp`
while staging. Backups can be zip files or folders.

- `listBackups(dir) → Backup[]` (newest first): entries whose name matches
  `^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}`, excluding `.tmp`. Each is `{ name, size, mtimeMs }`, where a
  folder's size is the recursive sum. Symlinks are not followed. A missing folder → `[]`.
- **`/backup start`** (admin):
  1. `runCommand(id, 'backup start', by)` replies with ServerUtilities' own answer ("started" /
     "already running").
  2. On success, `BackupWatcher` polls every 10 s for a backup newer than the start time whose size is
     unchanged across two polls.
  3. It then notifies `✅ Backup finished: <name> (<size>, <m>m <s>s)`. If none appears within 60 min:
     `⚠️ No finished backup appeared within 60 minutes`.
  4. One watch per server at a time.
- **`/backup status`** (admin): newest backup's name, age and size, backup count and total size.
- **`/backup list`** (admin): the 10 newest, with sizes, plus count and total size.
- **Watchdog** (`backupMaxAgeHours`): every 10 min, if the newest backup is older than the limit,
  notify `⚠️ No new backup for <n> h` once. The alert re-arms after a newer backup appears.

`/backup` is one command with subcommands and `default_member_permissions: "0"`, like `/cmd`.

## Mod

### Asynchronous command output

Spark (and any other mod that answers later) replies from a worker thread after `executeCommand`
returns. Today the mod sends the result straight away and misses those replies.

- A new pure Java class, `CommandOutput`, holds the captured lines in a thread-safe list, plus the start
  time and the time of the last line.
- `ready(now)` is true when either:
  - 1500 ms have passed with no new line (counting from the start, if there are no lines yet); or
  - 8000 ms have passed since the start (below the hub's 10 s command timeout).
- `GameEvents` keeps the pending outputs and checks them on each server tick. When one is ready, it
  sends `cmdResult` and drops it.
- The capturing sender's `addChatMessage` appends to the `CommandOutput` from any thread.

Costs: every `/cmd` now takes about 1.5 s. Output that arrives after 8 s (e.g. the results of
`spark profiler --timeout 30`) is still not captured.

### Stale outbox

`HubClient`'s outbox holds `JsonObject`s instead of strings, serialized when written. When a connection
ends, everything except `started`/`stopping` is dropped (`dropNonLifecycle`), so lines queued during the
failure are never replayed hours later.

## Hub minors (v1.1 deferred)

| Minor | Fix |
|---|---|
| `daily()` twice leaks the first timer | New `daily.ts`: `everyDay(time, leadMs, fn) → cancel`, which holds `parseDaily`/`nextDaily` and the early-fire fix. `RestartScheduler.daily` cancels any previous timer before arming; the summary uses it too. |
| Crash-log search follows symlinks | `findCrashLogs` uses `lstat`; symlinks are skipped. |
| `/restart` audit lacks the user id | Scheduler `by` is `discord:<name> (<id>)` for audit; the notice text uses the display name. `schedule(serverId, minutes, by, byName?)`: `byName` defaults to `by`. |
| Webhook-refused names retried per message | A `Set` of player names that got a 50035 (invalid form body) from the webhook: those skip straight to a bot post. |
| Topic warning always blames Manage Channels | The warning prints the error; it only says "needs Manage Channels" for error 50013 (Missing Permissions). |

## Error handling

Same rules as v1.1: every Discord call and filesystem scan is best-effort and logged. Stats and backup
code never throw into the hub's event handlers or timers.

## Testing

- `daily.test.ts`: `everyDay` fires at the target (the DST tests move here from `restarts.test.ts`),
  cancel works, and re-arming doesn't double-fire.
- `restarts.test.ts`: calling `daily()` twice leaves one timer; the audit `by` goes to `stop`.
- `db.test.ts`:
  - session open/close;
  - playtime overlap with windows and open sessions;
  - `lastSeen`, `top`, `unique`, peaks, `countEvents`;
  - `closeDanglingSessions`;
  - writes after `close()` don't throw.
- `playtime.test.ts`: a fake hub's player lists over a few polls produce the right sessions and peaks;
  an offline server closes its sessions.
- `summary.test.ts`: `buildSummary` over seeded data.
- `backups.test.ts`:
  - `listBackups` over a temp folder (zip and folder backups, `.tmp` ignored, a symlink skipped);
  - `BackupWatcher` with mock timers: finishes on a stable size, times out, one watch per server;
  - the watchdog alerts once and re-arms.
- `crashlogs.test.ts`: a symlink is skipped.
- `format.test.ts`: embed builders for events, status, playtime, top, backups and the summary.
- `discord.test.ts`: `/backup` in `COMMANDS` with hidden defaults; `/playtime`, `/top`.
- Mod JUnit:
  - `CommandOutputTest`: quiet window, max window, lines from another thread;
  - `HubClientTest`: `dropNonLifecycle`.
- Manual (real server):
  - `/cmd spark tps` shows spark's output;
  - `/backup start` → "Backup finished"; `/backup status`, `/backup list`;
  - `/playtime`, `/top`, the embeds' look;
  - the daily summary, by setting the time a few minutes ahead.

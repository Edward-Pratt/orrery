# GTNH Discord v1.2b — Design

Date: 2026-09-24 · Status: approved in chat, pending spec review
Builds on: the v1, v1.1 and v1.2a specs in this folder (v1.2a and v1.2b ship together: one hub update, one mod jar).

## Goal

1. **Lag:** per-dimension tick times, lag alerts that name the slowest dimension, and `/tps` with history.
2. **Quests:** BetterQuesting completions posted to Discord (main quests at once, the rest batched).
3. **Account linking:** `/link` in Discord plus `/discord link <code>` in game. A linked person's Discord
   chat appears in game under their Minecraft name, and `/playtime` accepts a Discord user.
4. **Backups:** exact backup events from ServerUtilities (every backup's success or failure), replacing
   v1.2a's folder polling after `/backup start`.
5. **Long commands:** `/cmd` replies that arrive after the first result (e.g. spark profiler links) are
   posted as follow-ups.

**Out of scope:** whitelist gating, and everything from v1.3 on in `docs/ROADMAP.md`.

## Protocol: still v1, additive only

Both sides already ignore message types they don't know (the hub's `parseModLine` returns `null` after the
handshake; the mod ignores unknown hub messages), and extra fields are ignored. So everything below is
additive and `PROTOCOL_VERSION` stays `1`: an old mod still works with the new hub, and a new mod with the old hub.

| Direction | Message | Fields |
|---|---|---|
| mod → hub | `heartbeat` (extended) | optional `dims`: up to 5 of `{ id: number, name: string, ms: number }`, slowest first |
| mod → hub | `quest` | `player: string`, `quests: { name: string, main: boolean }[]` (at least 1) |
| mod → hub | `link` | `player: string`, `uuid: string`, `code: string` |
| mod → hub | `unlink` | `player: string` |
| mod → hub | `backup` | `ok: boolean`, `detail: string` |
| mod → hub | `cmdLate` | `id: string`, `output: string[]` |
| hub → mod | `linkResult` | `player: string`, `ok: boolean`, `message: string` |

`parseModLine` gains three field kinds: `boolean`, `optional dims` and `quests`. Each is validated fully:
arrays of objects with typed fields, `dims` at most 5 entries, `quests` 1–50 entries, strings non-empty.

## Mod

### Per-dimension tick times

`heartbeat()` adds `dims`: for each entry in `MinecraftServer.worldTickTimes` (Forge,
`Hashtable<Integer, long[]>`, nanoseconds), mean ms =
`MathHelper.average(times) * 1.0E-6`. The name comes from
`DimensionManager.getWorld(id).provider.getDimensionName()` (`"DIM <id>"` if unloaded). Send the 5 slowest.

### Quest completions (`QuestEvents.java`, loaded only if BetterQuesting is installed)

- `compileOnly` dependency on the GTNH BetterQuesting dev jar
  (`com.github.GTNewHorizons:BetterQuesting:<version>-GTNH:dev`, the version the server runs, confirmed from
  its `mods/` before building). It's registered only if `Loader.isModLoaded("betterquesting")`. The class that
  references BetterQuesting types is loaded only in that case, so servers without BetterQuesting are unaffected.
- `@SubscribeEvent(priority = LOWEST)` on `betterquesting.api.events.QuestEvent`, only `Type.COMPLETED` with a
  non-empty `getQuestIDs()` (BetterQuesting also posts empty sets).
- For each quest id: `QuestDatabase.INSTANCE.get(id)`, skipping `null` and `NativeProps.SILENT` quests.
- `main` = `NativeProps.MAIN`.
- The name is resolved server-side. BetterQuesting's `QuestTranslation` uses the client-only `I18n`, so it
  can't be used on a dedicated server. The first that exists wins:
  1. the translation of key `betterquesting.quest.<encoded id>.name`, where the id is encoded with BQ's
     `UuidConverter.encodeUuidStripPadding`, using `StatCollector.canTranslate` / `translateToLocal`;
  2. the translation of `NativeProps.NAME`;
  3. `NativeProps.NAME` itself if it isn't a key;
  4. `"a quest"`.
- Player name: `QuestingAPI.getAPI(ApiReference.NAME_CACHE).getName(playerId)`, falling back to the online
  player whose questing UUID matches.
- Sends one `quest` message per event.

### In-game `/discord link <code>` and `/discord unlink`

A `CommandBase` registered in `FMLServerStartingEvent`, usable by every player (permission level 0) and by
players only. It sends `link { player, uuid, code }` or `unlink { player }`. The reply comes back as
`linkResult` and is shown to that player (if online) in chat. If the hub is disconnected, the player is told
"Discord bridge offline, try again later" immediately.

### Backup events (`BackupLogWatcher.java`)

- A log4j2 `AbstractAppender` attached in `preInit` to the `Server Utilities` logger (`ServerUtilities.LOGGER`).
  Detection is by message text:
  - `Backup done in …` → `backup { ok: true, detail: "<seconds> s, <size>" }`
  - `Error while backing up` → `backup { ok: false, detail: <exception message or "unknown error"> }`
- The appender only enqueues (`HubClient.send` is thread-safe). If ServerUtilities isn't installed, the logger
  never logs those lines and nothing happens.

### Late `/cmd` output

`CommandOutput` gains a second phase. After the first `cmdResult` is sent:

- the output stays registered for 5 minutes;
- lines that arrive afterwards are sent as `cmdLate { id, output }` batches, each once replies go quiet for
  1.5 s;
- after 5 minutes it's dropped.

`flushPending` on shutdown sends any unsent late lines too.

## Hub

### TPS history, lag alerts and `/tps` (`lag.ts`, hub core)

- **Storage:** table `tps (server_id, ts, tps, worst_name, worst_ms)`, with one sample per server per minute
  from the latest heartbeat. Samples are written only while the server is online and not hung.
- **Lag detection:** `LagMonitor` evaluates each sample.
  - Lag: `lagTps` (default 15) not met for `lagMinutes` consecutive samples (default 2) → notify
    `🐢 Lag: <tps> TPS; slowest: <name> (DIM <id>) <ms> ms/tick` (orange).
  - Recovery: one sample at or above `lagTps` → `✅ TPS back to normal (<tps>)`.
  - It's off with `lagAlerts: false`, and nothing is reported while offline or hung, because those have
    their own alerts.
- **`/tps` embed:**
  - now;
  - 1 h average and minimum, 24 h average;
  - a sparkline of the last 60 samples (`▁▂▃▄▅▆▇█` scaled 0–20 TPS);
  - the 5 slowest dimensions with ms/tick.

### Quests (`quests.ts`, hub core)

`QuestAnnouncer(mode, emit)`, with `mode` from config `quests`: `batched` (default), `main`, `all` or `off`.
`emit(batch)` receives `{ serverId, player, quests: { name, main }[], count }`, where `count` is the total
number of quests in a batched line.

| Mode | Main quests | Other quests |
|---|---|---|
| `batched` | posted at once | counted per player; every 10 min, one line per player |
| `main` | posted at once | not posted |
| `all` | posted at once | posted at once |
| `off` | not posted | not posted |

- Immediate posts (plain text, like chat): `📜 **<player>** completed **<quest>**`, with several quests from
  one event joined as `**A**, **B**` (at most 5 names, then `and N more`).
- The batched line is `📜 **<player>** completed <n> quests (latest: **<quest>**)`, or with `n = 1`,
  `completed **<quest>**`.
- The announcer works on plain data; `discord.ts` formats each batch into the text above.

### Account linking (`links.ts` + `db.ts`, hub core)

- **Table:** `links (discord_id TEXT PRIMARY KEY, player TEXT NOT NULL, uuid TEXT NOT NULL, linked_at INTEGER)`,
  with a unique index on `player COLLATE NOCASE`. One Discord account ↔ one Minecraft name, hub-wide (every
  server).
- **Codes:** `Links.issue(discordId, discordName) → code`: 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
  (no look-alikes), valid 10 minutes. A new code replaces the user's previous one. Codes are kept in memory
  only.
- **In-game link:** `Links.redeem(code, player, uuid) → { ok, message, discordId? }`.
  - Unknown or expired code → `{ ok: false, "That code is unknown or expired. Use /link in Discord for a new one." }`.
  - Otherwise it's stored (replacing any earlier link of that Discord user or that player) and the code is used
    up.
  - The hub replies `linkResult` and posts the notice `🔗 <player> linked to <@discordId>`. Pings are disabled
    globally, so the mention doesn't ping.
- **Unlinking:** `unlink` from the mod removes the player's link and replies. `/unlink` in Discord removes the
  user's link.
- **Lookups:** `db.linkByDiscord(id)`, `db.linkByPlayer(name)`.
- **Discord → game chat:** if the author is linked, the in-game name is their Minecraft name.
- **`/playtime`:** takes `player` (string) **or** `user` (Discord user). With `user`, the linked player is used;
  if there's none: "<user> hasn't linked a Minecraft account (use /link)".
- **Discord commands:**
  - `/link`: replies privately with the code and "In game, type `/discord link <code>` within 10 minutes".
  - `/unlink`: private reply.

### Backup events

- `backup` messages → notices:
  - `✅ Backup finished (<detail>)` (green), for every backup, including scheduled ones;
  - `❌ Backup failed: <detail>` (red).
- `BackupWatcher.watch` (v1.2a's polling after `/backup start`) is removed: the event covers it.
- `/backup start` replies with ServerUtilities' own answer as before.
- The missing-backup watchdog and `/backup status`/`list` stay.

### Late `/cmd` output

`ServerHub.runCommand(id, command, by, onLate?)`:

- `onLate(lines)` is called for each `cmdLate` with that command's id, for 15 minutes after the first result;
  the entry is then dropped.
- `discord.ts` passes an `onLate` that calls `interaction.followUp(formatOutput(lines))`.
- Follow-up errors (the interaction expired) are logged.

## Config

Per server, all optional:
- `lagTps` (default 15)
- `lagMinutes` (default 2)
- `lagAlerts` (default true)
- `quests` (`batched` | `main` | `all` | `off`, default `batched`)

Invalid values fail startup with a clear error.

## Error handling

Same rules as before:
- best-effort Discord calls;
- database writes never throw;
- hub-core modules send plain text;
- mod handlers never throw into the game loop (the quest listener and the appender catch everything and log).

## Testing

- **Hub** (`node:test`):
  - `protocol.test.ts`: every new message validates (`dims` over 5 entries, empty `quests`, a non-boolean
    `ok`, extra fields ignored) and old heartbeats still parse;
  - `servers.test.ts`: new game messages reach events; `onLate` round-trip and expiry;
  - `lag.test.ts`: lag after N low samples, recovery, off while offline or hung, the `lagAlerts: false` switch;
    sparkline;
  - `quests.test.ts`: each mode; batching per player with mock timers; the 5-name cap;
  - `links.test.ts`: issue/redeem, expiry (mock timers), replacement on both sides, unlink, the code alphabet;
  - `db.test.ts`: the links and tps tables;
  - `format.test.ts`: the `/tps` embed, quest lines, the link notice;
  - `discord.test.ts`: `/tps`, `/link`, `/unlink` and `/playtime user` in `COMMANDS`.
- **Mod** (JUnit):
  - `CommandOutputTest` covers the late phase: lines after the first result come out as batches, and nothing
    after 5 min;
  - `BackupLogWatcherTest` feeds log events to the appender and gets the right `backup` messages;
  - `QuestNamesTest` covers the name fallback order, on a pure helper that takes lookups as functions.
- **Manual** (real server):
  - lag: `/tps` output, and a lag alert (e.g. by loading chunks);
  - quests: completing a quest (main at once, others after 10 min);
  - linking: `/link` then `/discord link`, chat under the MC name, `/unlink`;
  - backups: a scheduled backup posts "Backup finished";
  - late output: `/cmd spark profiler --timeout 30` posts the profiler link as a follow-up.

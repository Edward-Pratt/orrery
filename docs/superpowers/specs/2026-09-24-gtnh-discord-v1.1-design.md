# GTNH Discord v1.1 — Design

Date: 2026-09-24 · Status: approved in chat, pending spec review
Builds on: `2026-09-24-gtnh-discord-design.md` (v1). Everything there still holds unless changed here.

## Goal

Make the bot nicer to live with and safer to operate, with a hub-only update:

1. Chat from the game posts with each player's name and skin head.
2. Live status visible without typing a command (bot presence + channel topic).
3. Safe restarts: an admin-scheduled countdown, plus an optional daily restart time.
4. Crash details land in Discord automatically.
5. Clear the deferred v1 review minors that live in the hub.

**Success:** all of the above works on the existing server by updating the hub and granting the bot two
permissions. No protocol change, no new mod jar.

**Out of scope:** the mod-side stale-outbox fix (next mod release); everything in the v1.2/v2 roadmap.

## Architecture

Unchanged: mods → `ServerHub` → frontends. The new logic is split the same way:

- **Hub core** (reusable by the future web dashboard): `restarts.ts`, `crashlogs.ts`.
- **Discord frontend**: `discord.ts` (client, events, commands) and `format.ts` (pure text functions).

| File | Change |
|---|---|
| `hub/src/restarts.ts` | New. `RestartScheduler`. |
| `hub/src/crashlogs.ts` | New. `findCrashLogs`. |
| `hub/src/format.ts` | New. `md`, `formatEvent`, `formatStatus`, `formatPlayers`, `formatOutput` move here from `discord.ts`, plus `formatPresence`, `formatTopic`, `topicDue`, `formatCountdown`. |
| `hub/src/discord.ts` | Webhook chat, presence, topics, crash uploads, `/restart`, command visibility, `shouldRelay`. Returns `{ client, post }`. |
| `hub/src/servers.ts` | Emoji-safe `mcText`; `close()` destroys every socket, including pre-handshake ones. |
| `hub/src/db.ts` | `record`/`touch` log errors instead of throwing. |
| `hub/src/index.ts` | Config fields, scheduler wiring. |

## Config

`servers[]` gains two optional fields (`config.example.json` shows both):

```json
{ "id": "gtnh", "name": "GTNH", "token": "…", "channelId": "…",
  "dir": "/home/opc/GTNH", "dailyRestart": "06:00" }
```

- `dir`: the server's folder, used to find crash logs. Absent → no crash uploads for that server.
- `dailyRestart`: `HH:MM`, 24-hour, the hub host's local time. Absent → no daily restart. An invalid value
  fails hub startup with a clear error (`server "gtnh": dailyRestart must be HH:MM`).

Bot permissions: add **Manage Webhooks** and **Manage Channels** to the bot's role (README updated).
If either is missing, that feature logs one warning and falls back (see below); nothing else breaks.

## Features

### 1. Webhook chat

- On `ClientReady`, for each linked channel: fetch its webhooks, reuse one the bot owns named
  `GTNH Relay`, else create it. Keep them in a `Map<serverId, Webhook>`.
- A `chat` event is sent through the webhook: `username` = player name, `avatarURL` =
  `https://mc-heads.net/avatar/<player>/64`, `content` = `md(message)`, `allowedMentions: { parse: [] }`.
- Everything else (join, leave, death, achievement, lifecycle alerts) still posts as the bot.
- If there is no webhook (missing permission, or creation failed) or a webhook send fails, the message
  posts as the bot in the v1 format. Chat is never dropped because of webhooks.
- Our own webhook posts are not echoed back into the game: `MessageCreate` already ignores `webhookId`.

### 2. Presence and channel topic

- **Presence**: every 30 s, `formatPresence(hub.list())`; `setPresence` only when the text changed.
  Custom status, one segment per server, `" | "`-joined, capped at 128 characters:
  `GTNH: 3 online · 20 TPS` / `GTNH: not responding` / `GTNH: offline`.
- **Topic**: every 60 s, per linked channel, `formatTopic(state)`:
  `🟢 Online · 3 players: Steve, Alex, Bob · 19.8 TPS` (names truncated to fit 1024 characters),
  `🟠 Not responding`, `🔴 Offline`. Edited only when `topicDue(last, text, now)`: text differs from the
  last edit **and** at least 5 minutes have passed since it (Discord allows 2 topic edits per 10 minutes).
  A failed edit (missing permission) logs one warning per channel and is not retried until the text changes.

### 3. Restarts (`RestartScheduler`, hub core)

API:

```ts
new RestartScheduler(hub: Pick<ServerHub, 'runCommand' | 'on' | 'get'>, notify: (serverId: string, text: string) => void)
schedule(serverId: string, minutes: number, by: string): void   // throws if offline, already pending, or minutes not an integer 0–60
cancel(serverId: string, by: string): boolean                    // false if nothing pending
pending(serverId: string): { at: number; by: string } | undefined
daily(serverId: string, time: string): void                      // arm the daily restart
stop(): void                                                    // clear all timers
```

- `schedule`: `minutes` is 0–60. Warnings go in-game via `runCommand(id, 'say Server restarting in <x>', 'restart')` at
  10 min, 5 min, 1 min, 30 s and 10 s before, for those that fit inside the delay. Then `runCommand(id,
  'stop', by)`. `Restart=always` in `gtnh.service` brings it back up. `minutes = 0` → `stop` straight away.
- `notify` posts to the server's Discord channel: `🔄 Restart in 10 min (by <by>)` when scheduled,
  `❎ Restart cancelled (by <by>)` when cancelled, `🔄 Restarting now` when `stop` is sent.
- A pending restart is cancelled when the server emits `stopped` or `crashed` before it fires, with
  notify `❎ Restart cancelled (server went down)`. The pending entry is cleared *before* the scheduler
  sends its own `stop`, so the resulting `stopped` event doesn't count as a cancellation.
- A failed `say` is logged and the countdown continues. A failed `stop` is logged and notified
  (`❌ Restart failed: <reason>`).
- `daily(id, "06:00")`: arms a timer for the next 05:50 local time, which calls `schedule(id, 10, 'daily')`,
  then re-arms for the next day. If `schedule` throws (offline, or already pending) it is logged and
  skipped; the next day is still armed.
- Discord: `/restart in minutes:<0–60>` and `/restart cancel`, admin role only, like `/cmd`.

### 4. Crash uploads (`findCrashLogs`, hub core)

- `findCrashLogs(dir: string, sinceMs: number): Promise<string[]>`: the newest `crash-reports/*.txt` and
  the newest `hs_err_pid*.log` in `dir`, each only if modified at or after `sinceMs` and at most 8 MB.
  0–2 paths. A missing directory or read error → `[]`, logged.
- On a `crashed` event for a server with `dir`: `findCrashLogs(dir, now − 10 min)`, and attach the files to
  the "💥 Server went down unexpectedly" post.

### 5. Deferred v1 minors (hub)

| Minor | Fix |
|---|---|
| A SQLite error in `record`/`touch` crashes the hub | Both catch, log `[db]` and return. |
| Discord system messages ("thread created") relayed as chat | `shouldRelay(m)`: not a bot, not a webhook, not `m.system`. |
| `.slice` can split an emoji (surrogate pair) | Truncate by code points in `mcText` and `formatOutput`. |
| `/cmd` visible to non-admins | `/cmd` and `/restart` get `setDefaultMemberPermissions(0)`: hidden until the admin role is allowed under Server Settings → Integrations. The role check stays. |
| Hub `close()` waits up to 5 s for pre-handshake sockets | `ServerHub` tracks every accepted socket and destroys all of them in `close()`. |

## Error handling

Every Discord API call (webhook, presence, topic, attachments) is best-effort: failures are logged and
never affect the relay, the TCP server or the scheduler. Timers are cleared on shutdown (`scheduler.stop()`,
the presence/topic intervals).

## Testing

`node:test`, same style as v1:

- `restarts.test.ts` with `t.mock.timers` (`setTimeout`, `Date`):
  - warning schedule for 10, 2 and 0 minutes;
  - cancel;
  - cancel on `crashed`;
  - rejects when offline or already pending;
  - a failed `stop` notifies;
  - `daily` fires at T−10 min and re-arms.
- `crashlogs.test.ts` in a temp dir: picks the newest of each kind; ignores old files, files over 8 MB,
  other names, and a missing dir.
- `format.test.ts`: existing formatter tests move here, plus `formatPresence`, `formatTopic`,
  `topicDue`, and `formatOutput` truncating before an emoji without splitting it.
- `servers.test.ts`: `mcText` emoji boundary; `close()` resolves in under 1 s with a pre-handshake
  connection open.
- `db.test.ts`: `record`/`touch` after `close()` don't throw.
- `discord.test.ts`: `shouldRelay`; the command definitions (`cmd`/`restart` have
  `default_member_permissions: "0"`).
- Manual (real Discord): webhook chat with skins, the fallback when Manage Webhooks is removed, presence,
  a topic edit, `/restart in 1` with in-game warnings then an auto-restart, `/restart cancel`, a crash
  upload after `kill -9`.

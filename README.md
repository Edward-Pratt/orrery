# orrery

A hub for everything you run or ship, game servers first. Today it connects
GT: New Horizons servers to Discord: two-way chat, console commands, status,
and start/stop/crash alerts.

```
[GTNH server] ─ gtnhdiscord mod ─┐
[GTNH server] ─ gtnhdiscord mod ─┼─ TCP 127.0.0.1:25580 ─> orrery hub (Node) ─> Discord
                                 ┘                              └─ SQLite uptime log
```

| Directory | What | Toolchain |
|---|---|---|
| `mod/` | Server-side Forge 1.7.10 mod. Relays game events, runs commands. | JDK 25, Gradle wrapper |
| `hub/` | The bot. Owns server state and uptime, talks to Discord. | Node 24+ |
| `deploy/` | systemd units for running both on one server. | systemd |
| `docs/` | Wire protocol, roadmap, decisions (`adr/`), and archived v1 specs. | — |

## Setup

### 1. Discord application

1. <https://discord.com/developers/applications> → **New Application** → **Bot**.
   Copy the bot token.
2. On the **Bot** page enable **Message Content Intent**. Without it the bot
   receives empty messages and Discord → game chat does nothing.
3. **OAuth2 → URL Generator**: scopes `bot` and `applications.commands`;
   permissions *View Channels*, *Send Messages*, *Read Message History*,
   *Attach Files*, *Manage Webhooks* (player-skin chat) and *Manage Channels*
   (live status in the channel topic). Open the URL and add the bot to your
   Discord server. Without the last two, chat posts as the bot and topics
   stay unchanged; everything else works.
   Already added the bot? Give its role those permissions under
   Server Settings → Roles instead.
4. In Discord, enable *Settings → Advanced → Developer Mode*, then right-click
   to **Copy ID** of: your Discord server (guild), the channel for each game
   server, and the role allowed to use `/cmd`.
5. `/cmd` and `/restart` are hidden from everyone by default. Show them to the
   admin role under Server Settings → Integrations → your bot → each command.
   The admin-role check still applies either way.

### 2. Hub

```bash
cd hub
npm ci
cp config.example.json config.json
openssl rand -hex 24          # one token per game server
$EDITOR config.json           # servers[]: id, name; integrations.minecraft.tokens and
                              # integrations.discord (guildId, adminRoleId, channels), keyed by server id
echo 'DISCORD_TOKEN=<bot token>' > .env   # only needed with integrations.discord
echo 'DISCORD_CLIENT_SECRET=<OAuth secret>' >> .env   # only needed with integrations.web
set -a; . ./.env; set +a; npm start
```

`config.json` and `.env` are git-ignored. Each section under `integrations` is
optional: leave out `discord` to run without the bot (and without a token), or
`minecraft` to open no mod port. `web` serves the dashboard's API on
`127.0.0.1` (Discord login for admins; it needs `discord` for the guild and
admin role, and the OAuth app's redirect set to `<publicUrl>/api/callback`). A server needs a token when `minecraft` is on,
but a Discord channel is optional: one left out of `channels` just isn't
bridged to Discord. `npm run check-config` checks the file
offline. A config from before orrery 2.0 (with `listenPort`, `guildId` and each
server's `token`/`channelId` at the old places) is rejected, and `check-config`
lists each key and where it moves. To run it permanently, see
[Running on a server](#running-on-a-server).

### 3. Mod

```bash
cd mod
./gradlew build
```

Copy `build/libs/gtnhdiscord-<version>.jar` (not `-dev` or `-sources`) into the
server's `mods/` folder. Clients don't need it. Start the server once to create
`config/gtnhdiscord.cfg`, then set the server id and its token from the hub's
`config.json` (`integrations.minecraft.tokens`):

```
general {
    S:hubHost=127.0.0.1
    I:hubPort=25580
    S:serverId=gtnh
    S:token=<integrations.minecraft.tokens.gtnh from hub config.json>
}
```

Restart the server. The hub logs the connection, and the channel gets
"✅ Server started".

## Running on a server

`deploy/` has systemd units for running the hub and the GTNH server together on
one Linux machine. Edit `User=`/`SocketUser=` and the paths in the files first.

```bash
sudo install -m 600 -o root -g root hub/.env /etc/orrery.env   # bot token, root-only
sudo cp deploy/orrery-hub.service deploy/gtnh.service deploy/gtnh.socket /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now orrery-hub gtnh
```

These work with SELinux enforcing (the default on RHEL/Oracle Linux): the token
lives in `/etc` rather than `/home`, and the server runs without tmux, which
SELinux doesn't let services start. If `gtnh.socket` fails with "Permission
denied" (SELinux blocking systemd from its own console FIFO), install the small
policy module in `deploy/gtnh-fifo.te`, which allows exactly that and nothing else:

```bash
checkmodule -M -m -o /tmp/gtnh-fifo.mod deploy/gtnh-fifo.te
semodule_package -o /tmp/gtnh-fifo.pp -m /tmp/gtnh-fifo.mod
sudo semodule -i /tmp/gtnh-fifo.pp
```

- **Hub logs:** `journalctl -u orrery-hub -f`
- **Server console output:** `journalctl -u gtnh -f` (add yourself to the
  `systemd-journal` group to read it without sudo)
- **Server console input:** `echo "say hello" > /run/gtnh.stdin`, or `/cmd` from Discord
- **Stopping the server:** `sudo systemctl stop gtnh` stops it for maintenance.
  An in-game `/stop`, or `/cmd stop` from Discord, restarts it. So does a crash.
- **Start order doesn't matter:** the mod reconnects to the hub within about 30 s.

**Ports.** Only Minecraft needs to be reachable from outside:

- **Bot:** the bot only makes outbound connections to Discord (HTTPS), so it
  needs no inbound port.
- **Hub:** it listens on `127.0.0.1:25580`. **Don't open 25580**: that
  connection is only protected by its token.
- **Minecraft (25565/tcp)** on Oracle Cloud must be opened in two places:
  1. **OCI console:** VCN → Security List (or NSG) → an ingress rule for
     `0.0.0.0/0`, TCP 25565.
  2. **The host firewall:**
     `sudo firewall-cmd --permanent --add-port=25565/tcp && sudo firewall-cmd --reload`

## Using it

- Chat in the linked channel appears in game as `[Discord] <name> message`.
  In-game chat posts with each player's name and skin head; joins, leaves,
  deaths and achievements post as the bot.
- The bot's status and each channel's topic show who's online and the TPS.
  Topics update at most every 5 minutes (a Discord limit).
- `/status` shows online state, TPS, player count and 24 h / 7 d uptime.
  Alerts, status, stats and backups post as embeds; chat stays plain text.
- `/list` shows online players.
- `/playtime <player>` (or `user:@someone` who has linked) shows total
  playtime, the last 7 days and when they were last seen; `/top [day|week|all]`
  ranks players by playtime.
- `/tps` shows TPS now, the last hour and day, a trend line and the slowest
  dimensions. The channel gets `🐢 Lag` when TPS stays below 15 for 2 minutes
  (per server: `"lagTps"`, `"lagMinutes"`, `"lagAlerts": false`) and
  `✅ TPS back to normal` after.
- Quest completions (BetterQuesting): main quests post straight away; the rest
  are rolled up per player every 10 minutes. `"quests"` per server: `batched`
  (default), `main`, `all` or `off`.
- Account linking: `/link` gives you a code; type `/discord link <code>` in
  game within 10 minutes. Your Discord messages then show in game under your
  Minecraft name. `/unlink` (Discord) or `/discord unlink` (game) removes it.
- `/cmd` output that arrives later (e.g. `spark profiler` results) is posted as
  a follow-up, for up to 15 minutes.
- `/cmd <command>` runs a console command and shows its output. Admin role only.
  Every command is logged by the hub. The reply takes about 1.5 s: it waits for
  mods such as spark that answer a moment later.
- `/restart in <minutes>` restarts with in-game warnings at 10 / 5 / 1 min,
  30 s and 10 s; `/restart cancel` calls it off. Admin role only. Add
  `"dailyRestart": "06:00"` to a server in `config.json` for a daily restart
  at that local time (the countdown starts 10 minutes before).
- Alerts: started, stopped, went down unexpectedly (crash or kill), not
  responding (no heartbeat for 30 s), responding again. With `"dir"` set to
  the server's folder in `config.json`, a crash alert comes with the crash
  report and JVM error log (`hs_err_pid*.log`) attached.
- Every ServerUtilities backup, scheduled or not, posts `✅ Backup finished` or
  `❌ Backup failed`. `/backup start` starts one now; `/backup status` shows the newest backup, the count and the total
  size; `/backup list` shows the 10 newest. Admin role only. Backups are read
  from `"backupDir"`, or `<dir>/backups` if that isn't set. With
  `"backupMaxAgeHours": 26`, the bot warns once if no new backup appears for
  that long.
- `"dailySummary": "09:00"` posts yesterday's stats every day at that time:
  uptime, peak and unique players, total playtime, top players, starts and
  crashes.

Adding another game server: add an entry to `servers` in `config.json`, a token
for its id under `integrations.minecraft.tokens` and a channel under
`integrations.discord.channels`, restart the hub, and install the mod with that
id and token.

## Development

```bash
cd hub && npm test && npm run typecheck
cd mod && ./gradlew spotlessApply build   # build runs the JUnit tests
```

The wire protocol is in `docs/protocol.md`, the project's vocabulary in `CONTEXT.md`, and decisions in
`docs/adr/`. Specs and tickets are GitHub issues. What's planned next is in `docs/ROADMAP.md`.

## What's next

v2 makes orrery a hub for everything that runs or ships, not only GTNH. Discord, Minecraft
servers, the host, systemd services and HTTP checks become integrations you switch on in config, and a browser
dashboard (Angular) joins Discord as a way in. See
`docs/adr/0002-hub-with-integrations.md` and `docs/ROADMAP.md`.

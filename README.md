# gtnh-discord

Talk to your GT: New Horizons servers from Discord: two-way chat, console
commands, status, and start/stop/crash alerts.

```
[GTNH server] ─ gtnhdiscord mod ─┐
[GTNH server] ─ gtnhdiscord mod ─┼─ TCP 127.0.0.1:25580 ─> hub (Node) ─> Discord
                                 ┘                              └─ SQLite uptime log
```

| Directory | What | Toolchain |
|---|---|---|
| `mod/` | Server-side Forge 1.7.10 mod. Relays game events, runs commands. | JDK 25, Gradle wrapper |
| `hub/` | The bot. Owns server state and uptime, talks to Discord. | Node 24+ |
| `deploy/` | systemd units for running both on one server. | systemd |
| `docs/` | Design spec and implementation plan. | — |

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
$EDITOR config.json           # guildId, adminRoleId, and per server: id, name, token, channelId
echo 'DISCORD_TOKEN=<bot token>' > .env
set -a; . ./.env; set +a; npm start
```

`config.json` and `.env` are git-ignored. To run it permanently, see
[Running on a server](#running-on-a-server).

### 3. Mod

```bash
cd mod
./gradlew build
```

Copy `build/libs/gtnhdiscord-<version>.jar` (not `-dev` or `-sources`) into the
server's `mods/` folder. Clients don't need it. Start the server once to create
`config/gtnhdiscord.cfg`, then set the id and token from the hub's
`config.json`:

```
general {
    S:hubHost=127.0.0.1
    I:hubPort=25580
    S:serverId=gtnh
    S:token=<token from hub config.json>
}
```

Restart the server. The hub logs the connection, and the channel gets
"✅ Server started".

## Running on a server

`deploy/` has systemd units for running the hub and the GTNH server together on
one Linux machine. Edit `User=`/`SocketUser=` and the paths in the files first.

```bash
sudo install -m 600 -o root -g root hub/.env /etc/gtnh-discord.env   # bot token, root-only
sudo cp deploy/gtnh-hub.service deploy/gtnh.service deploy/gtnh.socket /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gtnh-hub gtnh
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

- **Hub logs:** `journalctl -u gtnh-hub -f`
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
- `/playtime <player>` shows total playtime, the last 7 days and when they were
  last seen; `/top [day|week|all]` ranks players by playtime.
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
- `/backup start` starts a ServerUtilities backup and posts when it has
  finished; `/backup status` shows the newest backup, the count and the total
  size; `/backup list` shows the 10 newest. Admin role only. Backups are read
  from `"backupDir"`, or `<dir>/backups` if that isn't set. With
  `"backupMaxAgeHours": 26`, the bot warns once if no new backup appears for
  that long.
- `"dailySummary": "09:00"` posts yesterday's stats every day at that time:
  uptime, peak and unique players, total playtime, top players, starts and
  crashes.

Adding another game server: add an entry to `servers` in `config.json`,
restart the hub, and install the mod with that entry's `serverId` and token.

## Development

```bash
cd hub && npm test && npm run typecheck
cd mod && ./gradlew spotlessApply build   # build runs the JUnit tests
```

The wire protocol and design are in
`docs/superpowers/specs/2026-09-24-gtnh-discord-design.md`. What's planned next is in `docs/ROADMAP.md`.

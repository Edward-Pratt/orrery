# orrery

A hub for everything its owner runs or ships (game servers first): it holds all state, and integrations plug it into the outside world (Discord, Minecraft servers via a thin mod, Agents on other hosts, this host). The dashboard is its browser frontend. Personal productivity (notes, tasks, finances) is out of scope.

## Language

### Parts

**Hub**:
The owner of all state. Integrations plug into it; the dashboard only talks to it.
_Avoid_: bot (for the whole system), backend, platform, core

**Integration**:
A built-in part of the hub that connects it to one outside system (Discord, Minecraft servers, Agents, the host). Each is switched on and configured in the hub's config; none is required.
_Avoid_: module, plugin, extension, mod

**Host**:
A machine that things the hub knows run on, identified by an `id`, with its CPU, memory and disk. The hub measures its own Host; every other Host is measured by its Agent, whose `id` is the Host's.
_Avoid_: box, node, server (a server is a game server)

**Agent**:
A small service on another Host that dials out to the hub and runs one server there: it controls the server's service, keeps its saves, measures the Host, carries out the server's game updates and its own deploys. The hub never logs in to that Host; it asks the Agent. Staging has none.
_Avoid_: daemon, worker, client, node

**Server**:
One game server known to the hub, identified by its config `id`. Each server is of one game (`minecraft` or `factorio`), which decides what it offers, such as its rate (TPS out of 20, or UPS out of 60). A factorio server is always run by one Agent. What the hub can see and do for it depends on how it is connected (a Minecraft server with the mod offers the most); not every server has chat, TPS or quests. A server runs as at most one service, linked in config; the two are separate things. Stopping a linked service while players are online first shuts the server down cleanly.
_Avoid_: instance, world (a world is what a server runs)

**Service**:
A long-running thing on a host that the hub watches and can start or stop (a systemd unit). Only services listed in config exist to the hub. Knows nothing about games: the GTNH server runs as the service `gtnh.service`, but the service has no players. A service may run a container (`factorio.service` runs Factorio in Podman); to the hub it is still the unit. The service of an Agent's server is watched and controlled through that Agent.
_Avoid_: app, process, daemon, unit (a unit is how systemd names it), container (a service may run one)

**Check**:
A URL the hub requests on a schedule to see whether it is up and how fast it answers. Stands on its own; may be linked to a service.
_Avoid_: monitor, probe, ping (the hub's own liveness ping is something else)

**Mod**:
The server-side Minecraft mod that connects a server to the hub. Each one is named by its target (the 1.7.10 mod) and versioned independently. The Factorio mod (`orrery` on the mod portal) is a separate part, never the Mod: it talks only to its server's Agent, and its releases reach the server through game updates, as a portal mod.
_Avoid_: adapter, plugin, client

**Dashboard**:
The browser app for managing everything the hub knows. A separate app from the hub, talking only to it; each integration adds its own pages. Not an integration itself.
_Avoid_: web UI, panel, site

**Protocol version**:
The number a Mod or an Agent announces when it connects, the same number for both. It is the only compatibility contract between the hub and either.

### Players

**Link**:
A Discord user's tie to their player names in game, made by typing a `/link` code in a game. One link per Discord user, holding a name per game; one code works in either game. Unlinking in game removes only that game's name; `/unlink` in Discord removes the whole link.
_Avoid_: pairing, binding, connection (a connection is a socket)

### Game settings

**Game settings**:
A factorio server's own settings: its name, description, player limit, game password, user verification, pausing, autosaves, idle kick, who may run Lua commands, and its admins. Changed in the dashboard's Settings tab; the server's `server-settings.json` and adminlist are their source, and some changes apply only at its next restart. Never a Minecraft server's, and never the hub's config.
_Avoid_: config (the hub's), server settings (`ServerSettings` is the hub's per-server config), options, preferences

**Admin**:
A player name a factorio server treats as an admin in game. Not a dashboard admin (a Discord member with the admin role). While user verification is off the name is not checked, so anyone with the game password can join under it. Changed in the Settings tab, and promoted and demoted from the Players tab too.
_Avoid_: operator, op, moderator

**Moderation**:
Kicking, banning, unbanning, promoting and demoting a factorio server's players from the Players tab, through Factorio's own commands, which the Agent builds.
_Avoid_: admin tools, mod actions

**Ban**:
A name on a factorio server's banlist, with an optional reason Factorio shows them. By name only, so it stops no one while user verification is off.

### Backups

**Backup**:
A copy of a server's world that the hub lists and can restore. For a Minecraft server, a ServerUtilities zip of its world, named by the time it was taken (configs and mods are not part of it); for a factorio server, a Save.
_Avoid_: snapshot, save (for a Minecraft backup)

**Save**:
A Factorio save file of a factorio server, kept on its Host and never copied off it: a named save orrery makes (on request, and every 6 h if anyone played since the last), one of Factorio's autosaves, or a world file. The file Factorio last loaded is the current world.
_Avoid_: savegame, map file, snapshot

**Restore**:
Putting one backup back for a stopped server. A Minecraft server's world is replaced with the backup's contents; a factorio server gets a new copy of the save, which its next start loads, so nothing is overwritten.
_Avoid_: rollback

**Pre-restore world**:
The world folder a restore moved aside, kept until someone deletes it by hand.
_Avoid_: old world, backup (it is not one)

### Packs

**Pack**:
The versioned base content a server runs: a modpack release (GTNH 2.7.4) or plain Minecraft. Not always GTNH. Each pack version is for one Minecraft version and loader (1.7.10 Forge), which decides the Mod build a server needs.
_Avoid_: modpack (for the general term), instance

**Extra**:
A third-party mod jar or config file the hub keeps for one server and puts in after every pack update, either at a new path or overwriting the pack's file there. Orrery's own mod is the Mod, never an extra: it reaches a server by a deploy, and a pack update puts back the Mod release the server already ran, the same way it puts back extras.
_Avoid_: addon, overlay, custom mod, mod (the Mod is orrery's own)

**Config edit**:
A find-and-replace the hub makes in one of the pack's own files after every pack update (heap size in the start script, pollution off). An edit that no longer matches anything stops the update.
_Avoid_: patch, tweak, override (a whole replaced file is an extra)

**Kept path**:
A file or folder in a server's folder that belongs to the server, not the pack: a pack update never deletes or overwrites it (the world, `server.properties`, `config/JourneyMapServer`).
_Avoid_: preserved, excluded, ignored

**Adopt**:
Telling the hub which pack version a server already runs, so it can take over pack updates for that server without changing anything on disk.
_Avoid_: import, register

**Pack update**:
Moving a server to another version of its pack, with its extras and config edits applied again. Going back to an older pack version is a pack update too, and so is applying changed extras or config edits onto the version already installed.
_Avoid_: upgrade, reinstall

**Game update**:
The factorio counterpart of a pack update: moving a factorio server to another Factorio version or set of portal mods. The hub picks the versions and their dependencies; the Agent carries it out (a backup, a countdown stop, the swap, a health gate, and a rollback if the gate fails). Adding a mod, or putting a new Factorio mod release on the server, is a game update too.
_Avoid_: pack update (a pack is Minecraft's), upgrade, patch

**Portal mod update**:
A newer release of a portal mod a factorio server runs that fits its Factorio. The Game tab marks it, the hub posts new ones at most once a day, and installing it is a game update.
_Avoid_: mod update (the Mod is the Minecraft one), upgrade

**Pack library**:
The pack versions an Environment's hub keeps, by pack name and version, for any of its servers to install or update to. A version is removed only by hand, and only while no server runs it.
_Avoid_: cache, store, repository

**Install**:
Putting a pack version from the library into a new server's empty folder: the first pack a server gets, as opposed to a pack update. Creating the server's systemd unit and config entry is not part of it: the host's owner does that by running the setup script, with the command the hub shows.
_Avoid_: provision, deploy (a deploy is a release of hub, dashboard, Mod or Agent)

**Pending server**:
A server the hub has installed but that isn't in config yet, because the host's owner hasn't run the setup script for it yet. It can't start. It becomes a server when the hub finds it in config, or disappears when it is discarded, folder and all.
_Avoid_: draft, new server, unconfigured server

**Java runtime**:
A Java build the hub keeps for its Environment's servers, named by vendor and full version (Temurin 21.0.8+9). Each server runs on the one it is set to, or on the host's own Java when none is set; a change applies at its next restart. A runtime is removed only by hand, and only while no server is set to it.
_Avoid_: JDK, JRE, Java version (a version is the number)

### Releases

**Release**:
A tagged version of one part (hub, Mod, dashboard, Agent or Factorio mod), e.g. `hub-v2.4.0`.
_Avoid_: build, version (a version is the number)

**Deploy**:
Putting one release of one part in place: the hub or dashboard onto an environment (production or staging), the Mod onto one server, an Agent onto its Host (from `agent-v1.1.0` on; an Agent on an older release is moved by its Host's owner re-running the setup). Each hub deploys only its own environment. Going back to an older release is a deploy too. The Factorio mod is not deployed: its releases reach its server through game updates.
_Avoid_: install, rollout, push, redeploy (deploying the running release is refused)

**Rollback**:
Returning by itself to what ran before, when a deploy's new release, an update's new version or a factorio server's new game settings fail to come up: to the release before it, to the files before it (for a game update, also to its pre-update save), or to the game settings of its last good start.
_Avoid_: revert, downgrade (choosing an older release is a deploy)

**Environment**:
One hub and its dashboard, with their own config, data and login: Production or Staging. A hub acts only on its own environment.

**Production**:
The hub and dashboard people really use, with the real servers.

**Staging**:
A second hub and dashboard for trying changes before production, with no game server of its own.
_Avoid_: pre-production, test, dev

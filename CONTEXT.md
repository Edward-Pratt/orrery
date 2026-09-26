# orrery

A hub for everything its owner runs or ships (game servers first): it holds all state, and integrations plug it into the outside world (Discord, Minecraft servers via a thin mod, hosts). The dashboard is its browser frontend. Personal productivity (notes, tasks, finances) is out of scope.

## Language

### Parts

**Hub**:
The owner of all state. Integrations plug into it; the dashboard only talks to it.
_Avoid_: bot (for the whole system), backend, platform, core

**Integration**:
A built-in part of the hub that connects it to one outside system (Discord, Minecraft servers, the host). Each is switched on and configured in the hub's config; none is required.
_Avoid_: module, plugin, extension, mod

**Host**:
A machine that things the hub knows run on, identified by an `id`, with its CPU, memory and disk. The hub only measures the host it runs on itself.
_Avoid_: box, node, server (a server is a game server)

**Server**:
One game server known to the hub, identified by its config `id`. What the hub can see and do for it depends on how it is connected (a Minecraft server with the mod offers the most); not every server has chat, TPS or quests. A server runs as at most one service, linked in config; the two are separate things. Stopping a linked service while players are online first shuts the server down cleanly.
_Avoid_: instance, world (a world is what a server runs)

**Service**:
A long-running thing on a host that the hub watches and can start or stop (a systemd unit). Only services listed in config exist to the hub. Knows nothing about games: the GTNH server runs as the service `gtnh.service`, but the service has no players.
_Avoid_: app, process, daemon, unit (a unit is how systemd names it)

**Check**:
A URL the hub requests on a schedule to see whether it is up and how fast it answers. Stands on its own; may be linked to a service.
_Avoid_: monitor, probe, ping (the hub's own liveness ping is something else)

**Mod**:
The server-side mod that connects a server to the hub. Each one is named by its target (the 1.7.10 mod) and versioned independently.
_Avoid_: adapter, plugin, client

**Dashboard**:
The browser app for managing everything the hub knows. A separate app from the hub, talking only to it; each integration adds its own pages. Not an integration itself.
_Avoid_: web UI, panel, site

**Protocol version**:
The number a mod announces when it connects. It is the only compatibility contract between the hub and a mod.

### Backups

**Backup**:
A ServerUtilities zip of a server's world, named by the time it was taken. Configs and mods are not part of it.
_Avoid_: snapshot, save

**Restore**:
Replacing a stopped server's world with the contents of one backup.
_Avoid_: rollback

**Pre-restore world**:
The world folder a restore moved aside, kept until someone deletes it by hand.
_Avoid_: old world, backup (it is not one)

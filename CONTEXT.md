# gtnh-discord

A Discord bridge for Minecraft modpack servers: a central hub that holds all state, and a thin mod on each game server that reports to it.

## Language

### Parts

**Hub**:
The Discord bot and the owner of all state. Game servers connect to it; frontends only talk to it.
_Avoid_: bot (for the whole system), backend

**Server**:
One game server known to the hub, identified by its config `id`.
_Avoid_: instance, world (a world is what a server runs)

**Mod**:
The server-side mod that connects a server to the hub. Each one is named by its target (the 1.7.10 mod) and versioned independently.
_Avoid_: adapter, plugin, client

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

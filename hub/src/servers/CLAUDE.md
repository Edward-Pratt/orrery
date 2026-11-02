# servers

A Server (CONTEXT.md), Minecraft or factorio, and what happens on one. `servers.ts` is `ServerHub`: the Mod port, the
Agents' game connections, and the public API every frontend calls. The rest hang off it: countdown restarts
(`restarts.ts`), link codes (`links.ts`), quest announcements (`quests.ts`), TPS lag notices (`lag.ts`), player
sessions (`playtime.ts`), a server's logs and crash reports (`logs.ts`, `crashlogs.ts`), and a factorio server's
moderation (`moderation.ts`) and game settings (`game-settings.ts`). Each file's header is its contract. Tests:
`test/servers/`.

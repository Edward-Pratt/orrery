# servers

A Server (CONTEXT.md), Minecraft or factorio, and what happens on one. `servers.ts` is `ServerHub`: the Mod port, the
Agents' game connections, and the public API every frontend calls. It keeps the state, the listener and the sockets;
its flows share that state (`ServerCtx`, `server-ctx.ts`, with the config and option types): a connection's handshake,
open and close (`connections.ts`), its messages and hung detection (`dispatch.ts`), the lifecycle events and a
factorio server's budget for them (`lifecycle-budget.ts`), `runCommand` (`commands.ts`) and the text and hello checks
(`server-text.ts`); `servers.ts` re-exports the names callers import. The rest hang off it: countdown restarts
(`restarts.ts`), link codes (`links.ts`), quest announcements (`quests.ts`), TPS lag notices (`lag.ts`), player
sessions (`playtime.ts`), a server's logs and crash reports (`logs.ts`, `crashlogs.ts`), and a factorio server's
moderation (`moderation.ts`) and game settings (`game-settings.ts`). Each file's header is its contract. Tests:
`test/servers/`, `ServerHub`'s split along its parts, sharing their hubs (`server-hub.ts`).

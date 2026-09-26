# The hub becomes a platform with built-in integrations

v2 adds a browser dashboard and grows beyond Minecraft: host metrics now, other games later. Instead of bolting
an HTTP API onto a Discord bot, the hub becomes the owner of all state, and everything that connects it to the
outside world is an **integration**: Discord, Minecraft servers (the mod and its protocol), the host. Discord
becomes optional. The dashboard is a separate Angular app in `web/`, versioned on its own `web-vX.Y.Z` tag line
(see ADR 0001), and talks only to the hub.

We evolve `hub/` in place (extracting `discord.ts` and the mod socket into integrations, tests green, production
running) rather than rewriting it. Integrations are compiled in and switched on by config, not loaded at runtime:
no one else writes them, so a stable plugin API would be cost with no user.

The dashboard is Angular with Tailwind + spartan/ui and ngx-echarts, built in CI and attached to its release.
It reaches the hub same-origin through Caddy: REST for reads and actions, one SSE stream (event ids,
`Last-Event-ID` resume) for live events, Discord OAuth (`guilds.members.read`, so the admin check needs no bot) and
cookie sessions in SQLite. The hub's HTTP layer is Hono; API types live in one hub file the dashboard imports.

## Considered options

- **HTTP API on the existing hub, dashboard as another frontend** (the v1 plan, `hub/src/web/`): less work, but
  leaves Discord hard-wired and gives host metrics and other games no clear home.
- **Greenfield platform, then migrate**: rejected; the hub is small, tested and deployed.
- **Runtime-loaded plugins**: rejected until someone other than us writes one.

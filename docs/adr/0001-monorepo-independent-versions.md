# One repo, independently versioned hub and mods

The hub and the mod stay in one repo, but each is released on its own tag line (`hub-vX.Y.Z`, `mod-vX.Y.Z`,
`web-vX.Y.Z` for the dashboard, `agent-vX.Y.Z` for the agent on a remote server's host and `factorio-vX.Y.Z` for the
Factorio mod; a tag's prefix is its part's folder; a mod for another Minecraft version gets its own prefix; since Packs v2, #134, one `mod-v*` tag carries one jar per Minecraft target instead). Their only compatibility contract is the protocol
version, and the hub accepts a range of protocol versions (current and previous) so servers can update their
mods one at a time. We didn't split the repo: a protocol change touches the hub, the mod and the spec together,
and one repo keeps that a single change. `git subtree split` can pull a mod out later if a second toolchain
makes the monorepo painful.

The agent shares that contract: its `agentHello` carries the Mod's `PROTOCOL_VERSION`, accepted in the same range,
and its game connection is a Mod connection (ADR 0004), so it has no protocol version of its own. The Factorio mod
is the exception to "only compatibility contract": it never talks to the hub, only to its server's agent, so its
contract is with the agent (`factorio/CLAUDE.md`). When a change ships in several parts, release them in this
order, each in place before the next: the hub, the dashboard, the agent, and the Factorio mod last. The dashboard
reads new hub API without a guard, and a Factorio mod release reaches its server through a game update.

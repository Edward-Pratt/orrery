# One repo, independently versioned hub and mods

The hub and the mod stay in one repo, but each is released on its own tag line (`hub-vX.Y.Z`, `mod-vX.Y.Z`,
and `web-vX.Y.Z` for the dashboard; a mod for another Minecraft version gets its own prefix). Their only compatibility contract is the protocol
version, and the hub accepts a range of protocol versions (current and previous) so servers can update their
mods one at a time. We didn't split the repo: a protocol change touches the hub, the mod and the spec together,
and one repo keeps that a single change. `git subtree split` can pull a mod out later if a second toolchain
makes the monorepo painful.

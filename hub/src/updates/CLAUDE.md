# updates

Game updates, Portal mod updates, Releases and Deploys (CONTEXT.md). `game-updates.ts` runs a factorio server's game
update through its Agent; `mod-updates.ts` its portal mod updates; `factorio.ts` is the catalog (factorio.com and the
mod portal) and `factorio-releases.ts` the pure checks on what the portal says; `deploys.ts` is GitHub's releases and
the deploys of the hub, the dashboard, a Mod and an Agent. Each file's header is its contract. Tests:
`test/updates/`.

# updates

Game updates, Portal mod updates, Releases and Deploys (CONTEXT.md). `game-updates.ts` runs a factorio server's game
update through its Agent; `mod-updates.ts` its portal mod updates; `factorio.ts` is the catalog (factorio.com and the
mod portal) and `factorio-releases.ts` the pure checks on what the portal says; `deploys.ts` is GitHub's releases and
the deploys of the hub, the dashboard, a Mod and an Agent, with `github.ts` (the GitHub reader), `release-rules.ts`
(which tags count, their order, the floors, the Mod's jar names), `running-release.ts` (what each part runs),
`deploy-rows.ts` (the history rows, notices and the unit's watch), `deploy-mod.ts` and `deploy-agent.ts`. Each file's
header is its contract. Tests: `test/updates/`.

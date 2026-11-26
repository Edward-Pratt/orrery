# updates

Game updates, Portal mod updates, Releases and Deploys (CONTEXT.md). `game-updates.ts` runs a factorio server's game
update through its Agent, over the shared `GameCtx` (`game-ctx.ts`, with the lookups and why an update can't start):
`game-run.ts` (an update's start, the Agent's steps and end, cancel), `game-stop.ts` (the hub's stop), `game-job.ts`
(the job's steps, quiet give-up, waits and end), `game-catalog.ts` (the catalog, the mod browser and the Import mod
list's check) and `game-messages.ts` (the request checks, `fitsLine`, `redact`); `mod-updates.ts` its portal mod
updates; `mods-zip.ts` the mods zip (the server's portal mods rebuilt from the portal, written by `zip-store.ts`);
`factorio.ts` is the catalog (factorio.com and the mod portal), with `factorio-fetch.ts` (the reads: caps,
timeouts, redirect rules, `GameRefused`), `factorio-resolve.ts` (dependency resolution), `factorio-link.ts` (a mod's
signed download link), `factorio-browse.ts` (the mod browser's row checks and search), `factorio-thumbs.ts` (the
thumbnails' path rule and PNG check) and `factorio-releases.ts` (the pure checks on what the portal says);
`deploys.ts` is GitHub's releases and the deploys of the hub, the dashboard, a Mod and an Agent, with `github.ts`
(the GitHub reader), `release-rules.ts` (which tags count, their order, the floors, the Mod's jar names),
`running-release.ts` (what each part runs), `deploy-rows.ts` (the history rows, notices and the unit's watch),
`deploy-mod.ts` and `deploy-agent.ts`. Each file's header is its contract. Tests: `test/updates/` (game updates one
file per part, `game-*.test.ts`; the catalog one per part, `factorio*.test.ts`, on the fake portal in
`factorio-portal.ts`).

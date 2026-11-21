# packs

Packs, the Pack library and uploads (CONTEXT.md). `packs.ts` is `Packs`, a Minecraft server's pack: its state, the
start and stop and the public API, each method calling into the flow that does it, through the shared `PacksCtx`
(`pack-ctx.ts`, with the lookups every flow uses): `pack-state.ts` (the state, the Java runtime, the rollback offer,
the snapshot and pending changes), `pack-compare.ts` (Compare and Adopt), `pack-extras.ts` (Extras and Config edits),
`pack-update.ts` (a pack update's run and rollback) with `pack-job.ts` (its job's steps, waits, Backup, health gate and
end), `pack-install.ts` (New server), `pack-zip.ts` (a pack zip's checks, unpack and start scripts) and
`pack-paths.ts` (`PackRefused`, the request paths and the Kept paths). `library.ts` is `Library`, the stored pack
versions and Java runtimes: its state, the start and stop and the public API, through the shared `LibraryCtx`
(`library-ctx.ts`, with an add's progress, end and events): `library-entries.ts` (pack versions: adds, the move of
`packs/`, the relink and duplicates), `library-runtimes.ts` (Java runtimes from Adoptium) and `library-download.ts`
(downloads, redirects, resumes and Actions artifacts, where the GitHub token goes). `uploads.ts` the chunked uploads
packs and save uploads share. Each file's header is its contract. Tests: `test/packs/`, one file per part, sharing
`pack-world.ts`, `pack-hub.ts` and `library-hub.ts`.

# stats

What the hub remembers and tells. `db.ts` is the SQLite database, `Db`: audit, host samples, deploys, upkeep (the dashboard's login sessions' reads and writes are `users/store.ts`, as `db.users`; the live feed's stored chat and console `feed-store.ts`, as `db.feed`), over its layers, each extending the one before: `db-base.ts` (the handle and every table), `db-uptime.ts` (uptime, sessions, TPS), `db-links.ts` (account links), `db-packs.ts` (packs) and `db-library.ts` (the library, runtimes, Pending servers); callers import every name from `db.ts`;
`stats.ts` the frontends' read questions as plain data; `live.ts` the numbered event feed with replay; `summary.ts`
the daily summary. Each file's header is its contract. Tests: `test/stats/`.

# stats

What the hub remembers and tells. `db.ts` is the SQLite database: uptime, sessions, TPS, audit, web sessions;
`stats.ts` the frontends' read questions as plain data; `live.ts` the numbered event feed with replay; `summary.ts`
the daily summary. Each file's header is its contract. Tests: `test/stats/`.

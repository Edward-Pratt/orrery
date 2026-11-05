# public

The Status page (`status-page.ts`): the one page anyone can open without logging in, on `status.orrery.run` (and
`/status` on the dashboard's address). `main.ts` boots `StatusPage` instead of the dashboard's `App` when the path is
`/status` (`isStatusPath`), into the same `<app-root>` (so both components have that selector), with `PUBLIC_CONFIG`: an HTTP client and nothing else, so there is no router, no shell, no
session and no `loggedOutOn401` interceptor. Its one request is `GET /api/public/status`, every 30 s; any failure,
a 401 included, is "Can't reach orrery right now", never a logout.

Never import `Session`, `Integrations`, `Attention`, `LiveEvents`, `Environment` or anything else from the shell here:
on `status.orrery.run` every other `/api` path is 404, and the page must not ask for them. Shared pieces it may use:
`Logo`, `Status` and `publicServerState` (`status.ts`), `Theme`, `formatDuration` (`units.ts`).

Tests: `status-page.spec.ts` checks the one request (`backend.verify()`), each state's word, the players and uptime
lines, and that a failed poll keeps the last answer greyed out and the next one clears it.

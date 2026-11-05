# web

The web integration: the HTTP API the dashboard talks to. `web.ts` is the Hono app under `/api`; `auth.ts` the
Discord OAuth login, sessions and the CSRF check; `web-game-extras.ts` the routes for portal mod updates and
moderation. Each file's header is its contract, and the trust boundaries in `hub/CLAUDE.md` apply to every route.
Tests: the web API's are in `test/start.test.ts` (a whole hub through `startHub`).

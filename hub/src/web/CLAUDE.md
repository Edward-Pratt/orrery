# web

The web integration: the HTTP API the dashboard talks to. `web.ts` is the Hono app under `/api`; `web-public.ts`
the reads without a session (the Environment, the Status page); `auth.ts` the Discord OAuth login, sessions and the
CSRF check; `web-game-extras.ts` the routes for portal mod updates and moderation; `web-services.ts` the services' list,
logs and actions; `web-config.ts` the check of
`integrations.web` for `validateConfig`. Each file's header is its contract, and the trust boundaries in
`hub/CLAUDE.md` apply to every route. Tests: `test/web/` (with the shared hub and login helpers in `web-hub.ts`) and,
for the older ones, `test/start.test.ts`.

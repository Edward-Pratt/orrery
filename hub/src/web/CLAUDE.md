# web

The web integration: the HTTP API the dashboard talks to. `web.ts` is the Hono app under `/api`; `web-public.ts`
the reads without a session (the Environment, the Status page); `auth.ts` the CSRF check, the login and invites, the
session check and the session's own routes; `permit.ts` the permission each route needs, with default deny;
`web-users.ts` the Users page's routes; `request.ts` what every route reads (the JSON body, the session's user, the
audit actor); `web-game-extras.ts` the routes for portal mod updates and moderation; `web-services.ts` the services'
list, logs and actions; `web-config.ts` the check of `integrations.web` for `validateConfig`, and `resolveWeb`. Each file's header is its contract, and the trust boundaries in
`hub/CLAUDE.md` apply to every route. Tests: `test/web/` (with the shared hub and login helpers in `web-hub.ts`) and,
for the older ones, `test/start.test.ts`.

# web

The web integration: the HTTP API the dashboard talks to. `web.ts` is the Hono app under `/api`, wiring the route
modules in the order Hono's matching needs; `web-public.ts` the reads without a session (the Status page); `auth.ts` the CSRF check, the login and invites, the
session check and the session's own routes; `permit.ts` the permission each route needs, with default deny;
`web-users.ts` the Users page's routes; `request.ts` what every route reads (the JSON body, the session's user, the
audit actor, a history period's `hours`); `web-game-extras.ts` the routes for portal mod updates and moderation; `web-services.ts` the services'
list, logs and actions; `web-deploys.ts` the deploys; `web-hosts.ts` the Hosts' samples; `web-servers.ts` the servers'
reads (cards, details, logs, history, players) and the audit log; `web-packs.ts` New server, the uploads, the library
and the packs; `web-game.ts` a factorio server's game updates, mod browser, game settings and save uploads;
`web-actions.ts` the restore, the online check and the actions behind it; `web-events.ts` the event stream (SSE); `web-config.ts` the check of `integrations.web` for `validateConfig`, and `resolveWeb`. Each file's header is its contract, and the trust boundaries in
`hub/CLAUDE.md` apply to every route. Tests: `test/web/` (with the shared hub and login helpers in `web-hub.ts`) and,
for the older ones, `test/start.test.ts`.
